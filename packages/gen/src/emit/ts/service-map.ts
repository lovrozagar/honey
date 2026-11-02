/**
 * Where each operation sits on a generated TS client, and the service map the runtime dispatches
 * by: the resource tree with every member name a client can expose, and one entry per operation.
 */
import type { IR, IRNamespace, IROperation, IRSchema, IRTreeEntry } from "../../ir/model.ts"
import {
	isJsonMedia,
	mediaEssence,
	type SdkStream,
	type SdkSuccess,
	sdkModel,
	sseEventSchema,
} from "../../ir/sdk-model.ts"
import { openApiPathParams } from "../../ir/slots.ts"
import { tsString } from "../shared/escape.ts"
import { compareCodeUnits } from "../shared/lang.ts"
import { quoteKey } from "../shared/literals.ts"
import { MIRROR } from "../shared/mirror.ts"

/** One operation as the runtime's service map holds it (`runtime/ts/sdk.ts` `ServiceEntry`). */
export type ServiceEntry = {
	accept?: string
	/** the operation declares no success body: a 2xx reads as null, its body only through `raw` */
	empty?: true
	headers?: string[]
	idempotent?: true
	invalidate?: string[]
	method: string
	params?: string[]
	path: string
	realtime?: true
	/** an event stream; `"json"` when its declared event schema is not a string */
	sse?: "json" | true
	wildcard?: string
	ws?: true
}

export type ServiceMapNode = ServiceEntry | { [key: string]: ServiceMapNode }

/** Members a generated client already has; a resource of the same name would hide them. */
const ROOT_MEMBERS: readonly string[] = ["dispose", MIRROR, "state"]

/**
 * Names JavaScript machinery reads off any object: a `then` member makes the client a thenable,
 * `toString` breaks `String(sdk)`, `__proto__` sets the prototype.
 */
const OBJECT_MEMBERS: readonly string[] = [
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	"__proto__",
	"constructor",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"then",
	"toJSON",
	"toLocaleString",
	"toString",
	"valueOf",
]

/**
 * The resource tree with every member name a client can expose, in code-unit order. A name that
 * would shadow a client member or an `Object.prototype` name gets a trailing `_` (`state` →
 * `state_`), the same rename in the types and the service map, so types and runtime agree.
 */
export function memberTree(ns: IRNamespace, root = true): IRNamespace {
	const entries = new Map<string, IRTreeEntry>()
	for (const [key, entry] of [...ns.entries].sort(([a], [b]) => compareCodeUnits(a, b))) {
		let name = key
		if ((root && ROOT_MEMBERS.includes(key)) || OBJECT_MEMBERS.includes(key)) {
			name = `${key}_`
			while (ns.entries.has(name) || entries.has(name)) name += "_"
		}
		entries.set(name, entry.kind === "namespace" ? { kind: "namespace", ns: memberTree(entry.ns, false) } : entry)
	}
	return { entries }
}

/** The member path of every operation on a generated client, after the renames: `state.get` → `["state_", "get"]`. */
export function sdkMemberPaths(ir: IR): Map<string, string[]> {
	const out = new Map<string, string[]>()
	const walk = (ns: IRNamespace, prefix: string[]): void => {
		for (const [key, entry] of ns.entries) {
			if (entry.kind === "namespace") walk(entry.ns, [...prefix, key])
			else out.set(entry.op.id, [...prefix, key])
		}
	}
	walk(memberTree(ir.tree), [])
	return out
}

/** The media type a call asks for: the declared one when the answer is neither JSON nor an event stream. */
function acceptOf(op: IROperation, contentType: string | undefined): string | undefined {
	if (contentType === undefined || op.extensions.sse === true || isJsonMedia(contentType)) return undefined
	return mediaEssence(contentType)
}

/** The response headers the success answer declares, lower case and sorted (A2). */
function headersOf(op: IROperation, status: string): string[] {
	const declared = op.responses[status]?.headers ?? []
	return [...new Set(declared.map(({ name }) => name.toLowerCase()))].sort(compareCodeUnits)
}

/** The service entry of `op`; `success` is its success answer as the SDK model reads it. */
function entryOf(op: IROperation, success: SdkSuccess, resolve: (schema: IRSchema) => IRSchema): ServiceEntry {
	const entry: ServiceEntry = { method: op.method, path: op.path }
	const params = openApiPathParams(op.path)
	if (params.length > 0) entry.params = params
	const wildcard = op.params.path.find((p) => p.wildcard === true)
	if (wildcard) entry.wildcard = wildcard.name
	if (op.extensions.sse) entry.sse = sseEventSchema(op, resolve) === undefined ? true : "json"
	if (op.extensions.websocket) entry.ws = true
	if (op.extensions.realtime) entry.realtime = true
	if (op.extensions.idempotencyKey) entry.idempotent = true
	const invalidate = op.extensions.invalidates
	if (invalidate && invalidate.length > 0) entry.invalidate = [...invalidate]
	const accept = acceptOf(op, success.contentType)
	if (accept !== undefined) entry.accept = accept
	if (success.kind === "none" && !entry.sse && !entry.ws) entry.empty = true
	const headers = headersOf(op, success.status)
	if (headers.length > 0) entry.headers = headers
	return entry
}

/** The runtime adapter each non-REST transport is called through (`runtime/ts/sdk-*.ts`). */
const OPERATION_CALLS: Readonly<Record<Exclude<SdkStream, null>, string>> = {
	realtime: "realtimeOp",
	sse: "sseOp",
	ws: "wsOp",
}

/** A name the map text writes bare: an entry's adapter, imported from the runtime. */
class Identifier {
	constructor(readonly name: string) {}
}

/** The nested map of `ir`, each entry with its adapter's `call` when `calls`. */
function mapOf(ir: IR, calls: boolean): Record<string, ServiceMapNode> {
	const model = sdkModel(ir)
	const ops = model.opsById
	const walk = (ns: IRNamespace): Record<string, ServiceMapNode> => {
		const node: Record<string, ServiceMapNode> = Object.create(null)
		for (const [key, entry] of ns.entries) {
			if (entry.kind === "namespace") {
				node[key] = walk(entry.ns)
				continue
			}
			const op = ops.get(entry.op.id) as (typeof model.ops)[number]
			const value: ServiceEntry & { call?: Identifier } = entryOf(entry.op, op.success, model.resolve)
			if (calls && op.stream !== null) value.call = new Identifier(OPERATION_CALLS[op.stream])
			node[key] = value
		}
		return node
	}
	return walk(memberTree(ir.tree))
}

/**
 * The nested service map of `ir`: a dotted id's segments as nested keys, renamed as on the client.
 * Null-prototype nodes: an id of `__proto__.x` must never reach `Object.prototype`.
 */
export function serviceMapOf(ir: IR): Record<string, ServiceMapNode> {
	return mapOf(ir, false)
}

/** A service map value as TS literal text; each adapter's name is collected into `used`. */
function valueText(value: unknown, indent: string, used: Set<string>): string {
	if (value instanceof Identifier) {
		used.add(value.name)
		return value.name
	}
	if (typeof value === "string") return tsString(value)
	if (typeof value === "boolean") return String(value)
	if (Array.isArray(value)) return `[${value.map((item) => valueText(item, indent, used)).join(", ")}]`
	const inner = `${indent}\t`
	const lines = Object.entries(value as Record<string, unknown>)
		.sort(([a], [b]) => compareCodeUnits(a, b))
		.map(([key, item]) => `${inner}${quoteKey(key)}: ${valueText(item, inner, used)},`)
	return lines.length === 0 ? "{}" : `{\n${lines.join("\n")}\n${indent}}`
}

/** The `${stem}.map.gen.ts` text: the service map as a `const`, importing the adapters its entries name. */
export function serviceMapText(ir: IR, runtime: string): string {
	const used = new Set<string>()
	const map = valueText(mapOf(ir, true), "", used)
	const calls = [...used].sort(compareCodeUnits)
	const names = calls.length === 0 ? "type { ServiceMap }" : `{ ${calls.join(", ")}, type ServiceMap }`
	return `import ${names} from "./${runtime}"

export const serviceMap: ServiceMap = ${map}
`
}
