/**
 * The MCP server's tools (bit 18 phases b, d and e): one per operation marked `x-mcp` that a tool call can make, in the IR's
 * order. A tool's name is its operation id in snake case, only `[A-Za-z0-9_-]`, at most 64 characters (the tool-use
 * APIs an MCP client maps a tool onto accept no more), a name taken already suffixed `_2`, `_3`, … after truncating, so
 * it still fits. Its description is the operation's description or summary, controls dropped. Its inputSchema is flat:
 * each path, query and header parameter a property under its own name (one taken already suffixed, as the CLI's flags
 * are), the body under `body`: JSON or a form as its schema, bytes as a base64 string (Q4), text as a string; a
 * credential header is never an argument, the server sending the API key itself. Its outputSchema and annotations are
 * output-schema.ts's and annotations.ts's. An event stream is a bounded collect, taking `max_events` (1 to 100, 20 by
 * default) and `last_event_id` to resume after. Sockets are no tools. A multipart form (bit 21 c, H24) is a tool too,
 * each part its own argument: a text part as its schema, a file part (or a list of them) a file argument, files.ts's
 * schema.
 */
import type { IR, IROperation, IRParam, IRSchema } from "../../ir/model.ts"
import { irResolver } from "../../ir/schema.ts"
import { isJsonMedia, isTextMedia, mediaEssence, sdkModel } from "../../ir/sdk-model.ts"
import { NameScope, snakeWords } from "../shared/lang.ts"
import { sdkMemberPaths } from "../ts/service-map.ts"
import { type Annotations, annotationsOf } from "./annotations.ts"
import { FILE_SCHEMA } from "./files.ts"
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
	/** a multipart form's parts: each one's property, its name in the form, and whether it is a file or a list of them */
	readonly parts?: readonly Part[]
}

/** A multipart form's part as a tool argument: its property, its name in the form, and what it is. */
type Part = readonly [property: string, name: string, kind: "text" | "file" | "files"]

/** How a body is sent: JSON, a urlencoded form, base64-decoded bytes, text as it is, or a multipart form's parts. */
type BodyField = "json" | "form" | "bytes" | "text" | "parts"

/** The most characters a tool name may have. */
export const NAME_MAX = 64

/** Headers that carry a credential: never a tool's argument. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"]

/** How `op`'s body is sent: JSON, a urlencoded form, bytes, text, or a multipart form (a file in it or not) by parts. */
function bodyField(op: IROperation): BodyField | undefined {
	const body = op.body
	if (body === undefined) return undefined
	if (body.kind === "stream") return "bytes"
	if (isJsonMedia(body.contentType)) return "json"
	const essence = mediaEssence(body.contentType)
	if (essence === "application/x-www-form-urlencoded") return "form"
	if (essence === "multipart/form-data") return "parts"
	return isTextMedia(body.contentType) ? "text" : "bytes"
}

/** The schema a body argument of `field` takes. */
function bodySchema(op: IROperation, field: BodyField, ir: IR): JsonSchema {
	if (field === "bytes") return { type: "string", contentEncoding: "base64" }
	if (field === "text" || op.body?.kind !== "raw") return { type: "string" }
	return jsonSchemaOf(op.body.schema, ir.schemas)
}

/** What `op` is that no tool serves, or undefined when a tool can: a socket. */
export function untoolable(op: IROperation): string | undefined {
	if (op.extensions.websocket === true) return "a WebSocket"
	return op.extensions.realtime === true ? "a realtime channel" : undefined
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

/** A tool's properties as it gathers them: the names taken, each property's schema, and the required ones. */
type Gathered = {
	readonly scope: NameScope
	readonly properties: Record<string, JsonSchema>
	readonly required: string[]
}

/** `form`'s fields as arguments into `into`: a text part its schema; a file, or a list of them, files.ts's. */
function partsOf(form: IRSchema, ir: IR, into: Gathered): Part[] {
	const resolve = irResolver(ir.schemas)
	const object = resolve(form)
	return (object.kind === "object" ? object.fields : []).map((field) => {
		const property = into.scope.claim(field.name)
		const schema = resolve(field.schema)
		const files = schema.kind === "array" && resolve(schema.items).kind === "binary"
		const kind = schema.kind === "binary" ? "file" : files ? "files" : "text"
		const own = kind === "file" ? FILE_SCHEMA : jsonSchemaOf(field.schema, ir.schemas)
		into.properties[property] = {
			...own,
			...(kind === "files" && { items: FILE_SCHEMA }),
			...describe(field.description),
		}
		if (field.required) into.required.push(property)
		return [property, field.name, kind]
	})
}

/** `op`'s body argument into `into`: its property, how it is sent and a raw body's content type; or its parts. */
function bodyOf(op: IROperation, ir: IR, into: Gathered): Pick<ToolSpec, "body" | "parts"> {
	const field = bodyField(op)
	if (field === undefined || op.body === undefined) return {}
	/* a multipart form is never a stream: it has its schema */
	if (field === "parts") return { parts: partsOf((op.body as { schema: IRSchema }).schema, ir, into) }
	const property = into.scope.claim("body")
	into.properties[property] = bodySchema(op, field, ir)
	if (op.body.required) into.required.push(property)
	return { body: field === "bytes" || field === "text" ? [property, field, op.body.contentType] : [property, field] }
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
	const body = bodyOf(op, ir, { properties, required, scope })
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
			...body,
			...outputOf(sdkOp, ir),
			...(annotations === undefined ? {} : { annotations }),
			...(collect === undefined ? {} : { collect }),
		}
	})
}
