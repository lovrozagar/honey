/**
 * The MCP server's tools (bit 18 phases b, d and e): one per operation marked `x-mcp` that a tool call can make, in the IR's
 * order. A tool's name is its operation id in snake case, only `[A-Za-z0-9_-]`, at most 64 characters (the tool-use
 * APIs an MCP client maps a tool onto accept no more), a name taken already suffixed `_2`, `_3`, … after truncating, so
 * it still fits. Its description is the operation's description or summary, controls dropped. Its inputSchema is flat:
 * each path, query and header parameter a property under its own name (one taken already suffixed, as the CLI's flags
 * are), the body under `body`: JSON or a form as its schema, bytes as a base64 string (Q4), text as a string; a
 * credential header is never an argument, the server sending the API key itself. Its outputSchema and annotations are
 * output-schema.ts's and annotations.ts's. An event stream is a bounded collect, taking `max_events` (1 to 100, 20 by
 * default) and `last_event_id` to resume after. Sockets are no tools, nor is multipart, by decision (bit 19 g, #11).
 */
import type { IR, IROperation, IRParam } from "../../ir/model.ts"
import { isJsonMedia, isTextMedia, mediaEssence, sdkModel } from "../../ir/sdk-model.ts"
import { NameScope, snakeWords } from "../shared/lang.ts"
import { sdkMemberPaths } from "../ts/service-map.ts"
import { type Annotations, annotationsOf } from "./annotations.ts"
import { outputOf } from "./output-schema.ts"
import { describe, jsonSchemaOf, type JsonSchema } from "./schema.ts"

/** The SDK input group a parameter goes in, by where it is sent. */
type Group = "params" | "search" | "headers"

/** One tool as tools.gen.ts holds it (runtime/mcp/call.ts `ToolSpec`). */
export type ToolSpec = {
	readonly name: string
	readonly description?: string
	readonly inputSchema: JsonSchema
	readonly member: readonly string[]
	readonly args: readonly (readonly [property: string, group: Group, name: string])[]
	/** the body argument's property, how it is sent, and a raw body's content type, when the operation takes a body */
	readonly body?: readonly [property: string, field: BodyField, contentType?: string]
	readonly outputSchema?: JsonSchema
	/** whether structuredContent wraps the answer as `{result, headers}` */
	readonly wrap?: true
	readonly annotations?: Annotations
	/** an event stream's collect: its `max_events` and `last_event_id` properties */
	readonly collect?: readonly [max: string, lastEventId: string]
}

/** How a body argument is sent: JSON, a urlencoded form, base64-decoded bytes, or text as it is. */
type BodyField = "json" | "form" | "bytes" | "text"

/** The most characters a tool name may have. */
export const NAME_MAX = 64

/** Headers that carry a credential: never a tool's argument. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"]

/** How a body is sent, when a tool can send it: JSON, a urlencoded form, bytes or text; never multipart. */
function bodyField(op: IROperation): BodyField | null | undefined {
	const body = op.body
	if (body === undefined) return undefined
	if (body.kind === "multipart") return null
	if (body.kind === "stream") return "bytes"
	if (isJsonMedia(body.contentType)) return "json"
	if (mediaEssence(body.contentType) === "application/x-www-form-urlencoded") return "form"
	if (mediaEssence(body.contentType) === "multipart/form-data") return null
	return isTextMedia(body.contentType) ? "text" : "bytes"
}

/** The schema a body argument of `field` takes. */
function bodySchema(op: IROperation, field: BodyField, ir: IR): JsonSchema {
	if (field === "bytes") return { type: "string", contentEncoding: "base64" }
	if (field === "text" || op.body?.kind !== "raw") return { type: "string" }
	return jsonSchemaOf(op.body.schema, ir.schemas)
}

/** What `op` is that no tool serves, or undefined when a tool can: a socket, a multipart body. */
export function untoolable(op: IROperation): string | undefined {
	if (op.extensions.websocket === true) return "a WebSocket"
	if (op.extensions.realtime === true) return "a realtime channel"
	return bodyField(op) === null ? "a multipart body" : undefined
}

/** Whether `op` is a tool: marked `x-mcp`, and nothing no tool serves. */
export const isTool = (op: IROperation): boolean => op.extensions.mcp === true && untoolable(op) === undefined

/** The tool name for `id`, not one `taken` holds: snake case, sanitized, truncated, then suffixed. */
export function toolName(id: string, taken: Set<string>): string {
	/* snakeWords keeps only letters, digits and inner underscores: nothing is left to sanitize */
	const base = (snakeWords(id) || "tool").slice(0, NAME_MAX)
	let name = base
	for (let n = 2; taken.has(name); n++) name = `${base.slice(0, NAME_MAX - `_${n}`.length)}_${n}`
	taken.add(name)
	return name
}

/** `op`'s flat inputSchema and how each property reaches the SDK input. */
function inputOf(op: IROperation, ir: IR) {
	const scope = new NameScope()
	const credentials = new Set([...CREDENTIAL_HEADERS, ir.auth.headerName.toLowerCase()])
	/* null-prototype: a parameter named __proto__ is a property, never the object's prototype */
	const properties: Record<string, JsonSchema> = Object.create(null) as Record<string, JsonSchema>
	const required: string[] = []
	const args: [string, Group, string][] = []
	const groups: [Group, readonly IRParam[]][] = [
		["params", op.params.path],
		["search", op.params.query],
		["headers", op.params.header.filter((param) => !credentials.has(param.name.toLowerCase()))],
	]
	for (const [group, params] of groups)
		for (const param of params) {
			const property = scope.claim(param.name)
			properties[property] = { ...jsonSchemaOf(param.schema, ir.schemas), ...describe(param.description) }
			if (group === "params" || param.required === true) required.push(property)
			args.push([property, group, param.name])
		}
	const field = bodyField(op)
	let body: ToolSpec["body"]
	if (field !== undefined && field !== null && op.body !== undefined) {
		const property = scope.claim("body")
		properties[property] = bodySchema(op, field, ir)
		if (op.body.required) required.push(property)
		body = field === "bytes" || field === "text" ? [property, field, op.body.contentType] : [property, field]
	}
	let collect: ToolSpec["collect"]
	if (op.extensions.sse === true) {
		collect = [scope.claim("max_events"), scope.claim("last_event_id")]
		properties[collect[0]] = {
			type: "integer",
			minimum: 1,
			maximum: 100,
			description: "The most events to collect, 1 to 100; 20 when omitted",
		}
		properties[collect[1]] = { type: "string", description: "Resume after this event id: a collect's last_event_id" }
	}
	const inputSchema: JsonSchema = {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false,
	}
	return { args, body, collect, inputSchema }
}

/** Every tool the IR's operations make, in their order. */
export function toolsOf(ir: IR): ToolSpec[] {
	const members = sdkMemberPaths(ir)
	const model = sdkModel(ir)
	const taken = new Set<string>()
	return ir.operations.filter(isTool).map((op) => {
		const { args, body, collect, inputSchema } = inputOf(op, ir)
		/* the SDK model holds every operation of the IR */
		const sdkOp = model.opsById.get(op.id) as NonNullable<ReturnType<typeof model.opsById.get>>
		const annotations = annotationsOf(sdkOp)
		return {
			name: toolName(op.id, taken),
			...describe(op.description ?? op.summary),
			inputSchema,
			/* sdkMemberPaths holds every operation of the IR */
			member: members.get(op.id) as string[],
			args,
			...(body === undefined ? {} : { body }),
			...outputOf(sdkOp, ir),
			...(annotations === undefined ? {} : { annotations }),
			...(collect === undefined ? {} : { collect }),
		}
	})
}
