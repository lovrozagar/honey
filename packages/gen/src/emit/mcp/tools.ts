/**
 * The MCP server's tools (bit 18 phase b): one per operation marked `x-mcp` that a tool call can make, in the IR's
 * order. A tool's name is its operation id in snake case, only `[A-Za-z0-9_-]`, at most 64 characters (the tool-use
 * APIs an MCP client maps a tool onto accept no more), a name taken already suffixed `_2`, `_3`, … after truncating, so
 * it still fits. Its description is the operation's description or summary, controls dropped. Its inputSchema is flat:
 * each path, query and header parameter a property under its own name (one taken already suffixed, as the CLI's flags
 * are), the body under `body`; a credential header is never an argument, the server sending the API key itself.
 * Event streams, sockets and bodies a tool cannot send yet (bytes, multipart) are no tools until their phases.
 */
import type { IR, IROperation, IRParam } from "../../ir/model.ts"
import { isJsonMedia, mediaEssence } from "../../ir/sdk-model.ts"
import { NameScope, snakeWords } from "../shared/lang.ts"
import { sdkMemberPaths } from "../ts/service-map.ts"
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
	/** the body argument's property and the SDK input field it fills, when the operation takes a body */
	readonly body?: readonly [property: string, field: "json" | "form"]
}

/** The most characters a tool name may have. */
export const NAME_MAX = 64

/** Headers that carry a credential: never a tool's argument. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"]

/** The SDK input field a body fills, when a tool can send it: JSON or a urlencoded form. */
function bodyField(op: IROperation): "json" | "form" | null | undefined {
	const body = op.body
	if (body === undefined) return undefined
	if (body.kind !== "raw") return null
	if (isJsonMedia(body.contentType)) return "json"
	return mediaEssence(body.contentType) === "application/x-www-form-urlencoded" ? "form" : null
}

/** Whether `op` is a tool: marked `x-mcp`, no stream or socket, a body a tool can send. */
export const isTool = (op: IROperation): boolean =>
	op.extensions.mcp === true &&
	op.extensions.sse !== true &&
	op.extensions.websocket !== true &&
	op.extensions.realtime !== true &&
	bodyField(op) !== null

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
	let body: readonly [string, "json" | "form"] | undefined
	if (field !== undefined && field !== null && op.body?.kind === "raw") {
		const property = scope.claim("body")
		properties[property] = jsonSchemaOf(op.body.schema, ir.schemas)
		if (op.body.required) required.push(property)
		body = [property, field]
	}
	const inputSchema: JsonSchema = {
		type: "object",
		properties,
		...(required.length > 0 ? { required } : {}),
		additionalProperties: false,
	}
	return { args, body, inputSchema }
}

/** Every tool the IR's operations make, in their order. */
export function toolsOf(ir: IR): ToolSpec[] {
	const members = sdkMemberPaths(ir)
	const taken = new Set<string>()
	return ir.operations.filter(isTool).map((op) => {
		const { args, body, inputSchema } = inputOf(op, ir)
		return {
			name: toolName(op.id, taken),
			...describe(op.description ?? op.summary),
			inputSchema,
			/* sdkMemberPaths holds every operation of the IR */
			member: members.get(op.id) as string[],
			args,
			...(body === undefined ? {} : { body }),
		}
	})
}
