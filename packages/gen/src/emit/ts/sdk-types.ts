/**
 * The `${stem}.types.gen.ts` text: the component schemas, each operation's input, data, error and
 * header types, the SDK's config, and the interface its class merges with. Types and runtime meet
 * in the member tree, so a renamed member (`state` → `state_`) is renamed in both.
 */
import type { IR, IRBody, IRNamespace, IRParam, IRSchema } from "../../ir/model.ts"
import { irErrorEnvelope, isJsonMedia, mediaEssence, type SdkOp, sdkModel } from "../../ir/sdk-model.ts"
import { bodiesOf } from "../../ir/slots.ts"
import { blockCommentText, tsString } from "../shared/escape.ts"
import { compareCodeUnits, NameTable, pascalWords } from "../shared/lang.ts"
import { quoteKey } from "../shared/literals.ts"
import { irToTs, type TypeOptions } from "../shared/type-emitter.ts"
import { memberTree, sseEventSchema } from "./service-map.ts"

/* globals the emitted types read, and the names they declare: a component schema never takes one */
const RESERVED = [
	"AbortSignal",
	"ArrayBuffer",
	"AsyncIterable",
	"Blob",
	"ErrorEnvelope",
	"ErrorField",
	"HttpOptions",
	"Omit",
	"Promise",
	"ReadableStream",
	"Record",
	"Response",
	"SDKConfig",
	"SDKResult",
	"SSEEvent",
	"SseOptions",
	"TypedWebSocket",
	"Uint8Array",
	"WsOptions",
]

/** The input fields every call takes, by transport. */
const SHARED = `export type HttpOptions = {
	baseURL?: string
	cookies?: Record<string, string>
	headers?: Record<string, string>
	idempotencyKey?: string
	signal?: AbortSignal
	timeout?: number
}
export type SseOptions = Omit<HttpOptions, "idempotencyKey"> & { lastEventId?: string }
export type WsOptions = { protocols?: string | string[]; reconnectToken?: string }

type ErrorField = { error_key: string; message: string; path: string }

/** honey's error envelope at one status, its error keys as literals. */
export type ErrorEnvelope<TStatus extends number, TKey extends string> = {
	error_key: TKey
	fields: Record<string, ErrorField[]>
	message: string
	status: TStatus
	status_key: string
	success: false
}

/**
 * A safe-mode result. With declared errors, the failure branch is keyed by exactly their statuses,
 * so \`if (error)\` / \`if (!error)\` narrow; with declared headers, the success branch carries them.
 */
export type SDKResult<T, TErrorsByStatus = never, THeaders = never> =
	| ([THeaders] extends [never]
			? { data: T; error: null; response: Response; status: number }
			: { data: T; error: null; headers: THeaders; response: Response; status: number })
	| ([TErrorsByStatus] extends [never]
			? { data: null; error: unknown; response: Response; status: number }
			: {
					[S in keyof TErrorsByStatus & number]: { data: null; error: TErrorsByStatus[S]; response: Response; status: S }
				}[keyof TErrorsByStatus & number])
`

/** One field of an input object: required or not, by whether any of its members is. */
type Part = { field: string; required: boolean; type: string }

const objectText = (fields: readonly string[]) => (fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`)

/** A params, search, headers or cookies field from declared parameters. */
function paramsPart(field: string, params: readonly IRParam[], value: (p: IRParam) => string): Part | null {
	if (params.length === 0) return null
	const entries = [...params]
		.sort((a, b) => compareCodeUnits(a.name, b.name))
		.map((p) => `${quoteKey(p.name)}${p.required === true ? "" : "?"}: ${value(p)}`)
	return { field, required: params.some((p) => p.required === true), type: objectText(entries) }
}

/** The input field a request body fills, by its media type. */
function bodyField(body: IRBody): "body" | "form" | "json" | null {
	if (body.kind === "stream") return "body"
	if (body.kind === "multipart") return "form"
	if (isJsonMedia(body.contentType)) return "json"
	const essence = mediaEssence(body.contentType)
	return essence === "multipart/form-data" || essence === "application/x-www-form-urlencoded" ? "form" : null
}

/** One input field per body kind, the preferred content type of each kind winning: bytes, JSON, a form. */
function bodyParts(op: SdkOp, types: TypeOptions): Part[] {
	const byField = new Map<string, IRBody>()
	for (const body of bodiesOf(op.ir)) {
		const field = bodyField(body)
		if (field && !byField.has(field)) byField.set(field, body)
	}
	return (["body", "json", "form"] as const).flatMap((field) => {
		const body = byField.get(field)
		if (body === undefined) return []
		/* a multipart file part is a Blob, so a File passes; in JSON a binary field stays a string */
		const type =
			body.kind === "stream"
				? "ArrayBuffer | Blob | ReadableStream<Uint8Array> | Uint8Array"
				: irToTs(body.schema, field === "form" ? { ...types, binary: "Blob" } : types)
		return [{ field, required: body.required, type }]
	})
}

/** A call's input object, and whether it must be passed. */
function inputOf(op: SdkOp, types: TypeOptions): { required: boolean; type: string } {
	/* a header or cookie is text on the wire: an enum keeps its values, anything else is a string */
	const text = (p: IRParam) => (p.schema.kind === "scalar" && p.schema.enum ? irToTs(p.schema, types) : "string")
	const pathParams = op.pathParams.map((p) => ({ ...p, required: true }))
	const parts = [
		paramsPart("params", pathParams, (p) => irToTs(p.schema, types)),
		paramsPart("search", op.query, (p) => irToTs(p.schema, types)),
		paramsPart("headers", op.headers, text),
		paramsPart("cookies", op.ir.params.cookie ?? [], text),
		...bodyParts(op, types),
	].filter((part): part is Part => part !== null)
	const ordered = [...parts.filter((p) => p.required), ...parts.filter((p) => !p.required)]
	const fields = ordered.map((p) => `${p.field}${p.required ? "" : "?"}: ${p.type}`)
	return { required: parts.some((p) => p.required), type: objectText(fields) }
}

/** The data a successful call resolves to: JSON from its schema, text as a string, bytes (A1), else null. */
function dataOf(op: SdkOp, types: TypeOptions): string {
	const { kind, schema } = op.success
	if (kind === "none") return "null"
	if (kind === "text") return "string"
	if (kind === "binary") return "Uint8Array<ArrayBuffer>"
	return schema ? irToTs(schema, types) : "unknown"
}

/** The declared error bodies by concrete status; honey's envelope with its keys as literals. */
function errorsOf(op: SdkOp, types: TypeOptions, resolve: (schema: IRSchema) => IRSchema): string | null {
	const entries = op.errorStatuses.flatMap((status) => {
		const response = op.ir.responses[String(status)]
		if (!response?.schema || !response.contentType || !isJsonMedia(response.contentType)) return []
		const envelope = irErrorEnvelope(response.schema, resolve)
		if (!envelope) return [`${status}: ${irToTs(response.schema, types)}`]
		return [`${status}: ErrorEnvelope<${envelope.status}, ${envelope.keys.map(tsString).join(" | ")}>`]
	})
	return entries.length === 0 ? null : `{ ${entries.join("; ")} }`
}

/** The success answer's declared headers, lower case, a required one required (A2). */
function headersOf(op: SdkOp): string | null {
	const declared = op.ir.responses[op.success.status]?.headers ?? []
	if (declared.length === 0) return null
	const byName = new Map(declared.map((h) => [h.name.toLowerCase(), h.required]))
	const fields = [...byName].sort(([a], [b]) => compareCodeUnits(a, b))
	return objectText(fields.map(([name, required]) => `${quoteKey(name)}${required ? "" : "?"}: string`))
}

/** The method signatures of `op` named `name`: a raw overload before the parsed one for an HTTP call. */
function signatures(name: string, op: SdkOp, ctx: Context): string[] {
	const input = inputOf(op, ctx.types)
	const arg = (extra: string) => {
		const type = input.type === "{}" ? extra : `${input.type} & ${extra}`
		return `${input.required ? "input" : "input?"}: ${type}`
	}
	const key = quoteKey(name)
	/* a realtime op is typed by its transport, as the runtime dispatches it */
	const { sse, websocket } = op.ir.extensions
	if (websocket) return [`${key}(${arg("WsOptions")}): TypedWebSocket`]
	if (sse) {
		const events = sseEventSchema(op.ir, ctx.resolve)
		const event = events === undefined ? "SSEEvent" : `SSEEvent<${irToTs(events, ctx.types)}>`
		return [`${key}(${arg("SseOptions")}): AsyncIterable<${event}>`]
	}
	const data = dataOf(op, ctx.types)
	const errors = errorsOf(op, ctx.types, ctx.resolve)
	const headers = headersOf(op)
	const args = headers === null ? [data, ...(errors === null ? [] : [errors])] : [data, errors ?? "never", headers]
	const result = `SDKResult<${args.join(", ")}>`
	const raw = `input: ${input.type === "{}" ? "" : `${input.type} & `}HttpOptions & { raw: true }`
	return [
		`${key}(${raw}): Promise<Response>`,
		`${key}(${arg("HttpOptions & { raw?: false }")}): TThrow extends true ? Promise<${data}> : Promise<${result}>`,
	]
}

type Context = { ops: Map<string, SdkOp>; resolve: (schema: IRSchema) => IRSchema; types: TypeOptions }

/** A namespace's members as type-literal lines, nested namespaces as nested literals. */
function members(ns: IRNamespace, ctx: Context, indent: string): string[] {
	return [...ns.entries].flatMap(([name, entry]) => {
		if (entry.kind === "method") {
			const op = ctx.ops.get(entry.op.id) as SdkOp
			return signatures(name, op, ctx).map((line) => `${indent}${line}`)
		}
		return [`${indent}${quoteKey(name)}: {`, ...members(entry.ns, ctx, `${indent}\t`), `${indent}}`]
	})
}

/**
 * The component schemas' declared names, clear of `reserved` (the names the emitted file declares
 * and the globals it reads), claimed in code-unit order so the same document names them alike.
 */
export function componentNames(ir: IR, reserved: readonly string[]): (schema: string) => string {
	const table = new NameTable(reserved)
	for (const schema of Object.keys(ir.schemas).sort(compareCodeUnits)) {
		const base = pascalWords(schema) || "Schema"
		table.get(schema, /^[0-9]/.test(base) ? `Schema${base}` : base)
	}
	return (schema) => table.get(schema, "Schema")
}

/** The config type: `baseURL` optional when the document declares a server, the first one being its default. */
function configText(name: string, server: string | undefined): string {
	const head = `export type ${name}Config<TThrow extends boolean = false> =`
	if (server === undefined) return `${head} Omit<SDKConfig, "throwOnError"> & { throwOnError?: TThrow }`
	return `${head} Omit<SDKConfig, "baseURL" | "throwOnError"> & {
	/** Default: the document's first server, ${blockCommentText(server)} */
	baseURL?: string
	throwOnError?: TThrow
}`
}

/** The `${stem}.types.gen.ts` text of `ir` for the SDK `name`, importing the runtime module `runtime`. */
export function sdkTypesText(ir: IR, name: string, runtime: string): string {
	const model = sdkModel(ir)
	const types: TypeOptions = { refName: componentNames(ir, [...RESERVED, name, `${name}Config`, `${name}Operations`]) }
	const ctx: Context = { ops: model.opsById, resolve: model.resolve, types }
	const schemas = model.schemaNames.map(
		(schema) => `export type ${types.refName?.(schema)} = ${irToTs(ir.schemas[schema] as IRSchema, types)}`,
	)
	return `import type { SDKConfig, SSEEvent, TypedWebSocket } from "./${runtime}"

${schemas.length === 0 ? "" : `${schemas.join("\n")}\n\n`}${SHARED}
${configText(name, ir.servers[0])}

/** Every operation of the SDK, by its member path. */
export interface ${name}Operations<TThrow extends boolean = false> {
${members(memberTree(ir.tree), ctx, "\t").join("\n")}
}
`
}
