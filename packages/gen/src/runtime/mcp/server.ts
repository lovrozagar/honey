/**
 * The MCP server's protocol (bit 18): initialize negotiating a revision, ping, tools/list and tools/call, and a JSON-RPC
 * error for a protocol fault (a malformed request, an unknown method or tool, arguments that are not an object). A
 * tool's own failure is its result, `isError`, never a protocol error. Under 2025-03-26, which predates them, a tool's
 * outputSchema and a result's structuredContent are left out. A call whose request carries a progressToken may report
 * its progress, each step a notifications/progress before its result.
 */
import { ErrorCode, failure, type Id, isId, type Message, type Reply, result } from "./jsonrpc.ts"

/** The revisions served, newest first: the one a client asks for if listed, else the newest. */
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const

/** The first revision with a tool's outputSchema and a result's structuredContent. */
const STRUCTURED_SINCE = "2025-06-18"

/** A tool's result: its content, its structured value when it has an outputSchema, and whether it failed. */
export type ToolResult = {
	readonly content: readonly Record<string, unknown>[]
	readonly structuredContent?: Record<string, unknown>
	readonly isError?: true
}

/** A tool: what tools/list shows of it, and what tools/call runs. */
export type Tool = {
	readonly name: string
	readonly description?: string
	readonly inputSchema: Record<string, unknown>
	readonly outputSchema?: Record<string, unknown>
	readonly annotations?: Record<string, boolean>
	readonly call: (
		args: Record<string, unknown>,
		signal: AbortSignal,
		progress: (done: number) => void,
	) => Promise<ToolResult>
}

/** Who the server is, as initialize answers. */
export type ServerInfo = { readonly name: string; readonly version: string }

/** One session's protocol: the answer to each message, the revision fixed by initialize. */
export type Session = {
	readonly answer: (
		message: Message,
		signal: AbortSignal,
		notify: (message: object) => void,
	) => Promise<Reply | undefined>
}

/** The tools/list entry for `tool` under `version`. */
function listed(tool: Tool, structured: boolean): Record<string, unknown> {
	return {
		name: tool.name,
		...(tool.description === undefined ? {} : { description: tool.description }),
		inputSchema: tool.inputSchema,
		...(structured && tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
		...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
	}
}

/** `outcome` as `version` carries it: without structuredContent before it existed. */
function shaped(outcome: ToolResult, structured: boolean): ToolResult {
	if (structured || outcome.structuredContent === undefined) return outcome
	const { structuredContent: _, ...rest } = outcome
	return rest
}

/** A session over `tools`, as `info` names the server. */
export function createSession(info: ServerInfo, tools: readonly Tool[]): Session {
	const byName = new Map(tools.map((tool) => [tool.name, tool]))
	let version: string = PROTOCOL_VERSIONS[0]
	const structured = () => version >= STRUCTURED_SINCE
	/* a fault returns at once, not through a promise, so it answers in the order it came */
	const call = (
		id: Id,
		params: Record<string, unknown>,
		signal: AbortSignal,
		notify: (message: object) => void,
	): Reply | Promise<Reply> => {
		const tool = typeof params.name === "string" ? byName.get(params.name) : undefined
		if (tool === undefined) return failure(id, ErrorCode.InvalidParams, `Unknown tool: ${String(params.name)}`)
		const args = params.arguments ?? {}
		if (typeof args !== "object" || args === null || Array.isArray(args))
			return failure(id, ErrorCode.InvalidParams, "Tool arguments must be an object")
		const token = (params._meta as { progressToken?: unknown } | undefined)?.progressToken
		const progress = (done: number) =>
			(typeof token === "string" || typeof token === "number") &&
			notify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: done, progressToken: token } })
		return tool
			.call(args as Record<string, unknown>, signal, progress)
			.then((outcome) => result(id, shaped(outcome, structured())))
	}
	const answer = async (
		message: Message,
		signal: AbortSignal,
		notify: (message: object) => void,
	): Promise<Reply | undefined> => {
		if (message.jsonrpc !== "2.0" || typeof message.method !== "string")
			return failure(isId(message.id) ? message.id : null, ErrorCode.InvalidRequest, "Invalid Request")
		if (!isId(message.id)) return undefined
		const params = (typeof message.params === "object" && message.params !== null ? message.params : {}) as Record<
			string,
			unknown
		>
		switch (message.method) {
			case "initialize": {
				const asked = String(params.protocolVersion)
				version = (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0]
				return result(message.id, { capabilities: { tools: {} }, protocolVersion: version, serverInfo: info })
			}
			case "ping":
				return result(message.id, {})
			case "tools/list":
				return result(message.id, { tools: tools.map((tool) => listed(tool, structured())) })
			case "tools/call":
				return call(message.id, params, signal, notify)
			default:
				return failure(message.id, ErrorCode.MethodNotFound, `Method not found: ${message.method}`)
		}
	}
	return { answer }
}
