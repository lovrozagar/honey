/**
 * The MCP server's protocol (bit 18; dual-era, bit 21 b), whatever the transport. A request whose `_meta` names its
 * revision is modern (2026-07-28), served from itself alone: server/discover, tools/list (cached) and tools/call, each
 * result complete; another revision refused naming those served. Any other is legacy: initialize negotiates 2025-11-25
 * down to 2025-03-26 into the connection, then ping, tools/list and tools/call; under 2025-03-26 no outputSchema, no
 * structuredContent, and only there a batch. A fault answers at once, a call when done; a tool's failure is its result.
 * A call with a progressToken may report progress, each step a notifications/progress before its result. A transport
 * that reads files (bit 21 c: stdio) hands each call its reader; a mount its uploads and fetch, a modern call its
 * params, so it may answer an input request or refuse its state (bit 21 g). `extensions` are advertised in both eras.
 */
import type { Files } from "./files.ts"
import { ErrorCode, failure, type Id, isId, type Message, type Reply, result } from "./jsonrpc.ts"

/** The revisions served, newest first: the modern, then each an initialize may negotiate, the newest by default. */
export const PROTOCOL_VERSIONS = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] as const

/* the one with per-request _meta; the first with outputSchema and structuredContent; the last with batches */
export const [MODERN, LEGACY, STRUCTURED_SINCE, BATCHED] = PROTOCOL_VERSIONS
export const VERSION = "io.modelcontextprotocol/protocolVersion"
const CAPABILITIES = "io.modelcontextprotocol/clientCapabilities"

/* a modern result is complete; a list cached by its caller alone, 5 minutes */
const COMPLETE = { resultType: "complete" }
const CACHED = { ...COMPLETE, cacheScope: "private", ttlMs: 300_000 }

/** A tool's result: its content, its structured value when it has an outputSchema, and whether it failed. */
export type ToolResult = {
	readonly content: readonly Record<string, unknown>[]
	readonly structuredContent?: Record<string, unknown>
	readonly isError?: true
	readonly _meta?: Record<string, unknown>
}

/** A call's answer: its result, a modern call's input request, or its params refused. */
export type Outcome = ToolResult | { readonly inputRequired: Record<string, unknown> } | { readonly invalid: string }

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
		files?: Files,
	) => Promise<Outcome>
}

/** Who the server is, as initialize and server/discover answer. */
export type ServerInfo = { readonly name: string; readonly version: string }

/** A connection's legacy revision, once its initialize negotiated one. */
export type Connection = { version?: string }

/** A message's abort, where its notifications go, its connection, and its transport's files. */
export type Context = {
	readonly signal: AbortSignal
	readonly notify: (message: object) => void
	readonly connection: Connection
	readonly files?: Files
}

/** Each message's reply, a batch's, or none; a promise only for a call, never rejected. */
export type Protocol = {
	readonly answer: (
		message: unknown,
		context: Context,
	) => Reply | Reply[] | undefined | Promise<Reply | Reply[] | undefined>
}

/** Whether `value` is a JSON object. */
export const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

/** The tools/list entry for `tool`: its outputSchema only when `structured`. */
function listed(tool: Tool, structured: boolean): Record<string, unknown> {
	return {
		name: tool.name,
		...(tool.description === undefined ? {} : { description: tool.description }),
		inputSchema: tool.inputSchema,
		...(structured && tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
		...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
	}
}

/** `outcome` without structuredContent unless `structured`. */
function shaped(outcome: ToolResult, structured: boolean): ToolResult {
	if (structured || outcome.structuredContent === undefined) return outcome
	const { structuredContent: _, ...rest } = outcome
	return rest
}

/** A modern request's `_meta`: one that names its revision. */
export function claimed(params: Record<string, unknown>): Record<string, unknown> | undefined {
	const meta = params._meta
	return isObject(meta) && VERSION in meta ? meta : undefined
}

/** A request as a tools/call reads it: its id and its params. */
type Asked = { readonly id: Id; readonly params: Record<string, unknown> }

/** A modern request's refusal: a `_meta` without its revision or the client's capabilities, or a revision not served. */
export function unserved(id: Id, meta: Record<string, unknown>): Reply | undefined {
	const asked = meta[VERSION]
	if (typeof asked !== "string" || !isObject(meta[CAPABILITIES]))
		return failure(id, ErrorCode.InvalidParams, `Invalid params: needs ${VERSION} and ${CAPABILITIES}`)
	if (asked !== MODERN)
		return failure(id, ErrorCode.UnsupportedProtocolVersion, "Unsupported protocol version", {
			requested: asked,
			supported: PROTOCOL_VERSIONS,
		})
	return undefined
}

/** A tools/call of `tool` under `version`: a fault at once, else its result when done; a handler's fault internal. */
function called({ id, params }: Asked, tool: Tool | undefined, version: string, context: Context) {
	if (tool === undefined) return failure(id, ErrorCode.InvalidParams, `Unknown tool: ${String(params.name)}`)
	const args = params.arguments ?? {}
	if (!isObject(args)) return failure(id, ErrorCode.InvalidParams, "Tool arguments must be an object")
	const token = (params._meta as { progressToken?: unknown } | undefined)?.progressToken
	const progress = (done: number) =>
		(typeof token === "string" || typeof token === "number") &&
		context.notify({
			jsonrpc: "2.0",
			method: "notifications/progress",
			params: { progress: done, progressToken: token },
		})
	const modern = version === MODERN
	const client = modern ? (claimed(params)?.[CAPABILITIES] as Files["client"]) : undefined
	return tool
		.call(args, context.signal, progress, modern ? { ...context.files, asked: params, client } : context.files)
		.then(
			(outcome) =>
				"invalid" in outcome
					? failure(id, ErrorCode.InvalidParams, `Invalid params: ${outcome.invalid}`)
					: result(
							id,
							"inputRequired" in outcome
								? { ...outcome.inputRequired, resultType: "input_required" }
								: { ...shaped(outcome, version >= STRUCTURED_SINCE), ...(modern && COMPLETE) },
						),
			() => failure(id, ErrorCode.InternalError, "Internal error"),
		)
}

/** A batch's replies, `one` answering each: only 2025-03-26 has batches, every later revision dropped them. */
function batch(
	one: (message: unknown, context: Context) => Reply | Promise<Reply> | undefined,
	messages: unknown[],
	context: Context,
) {
	if (messages.length === 0 || context.connection.version !== BATCHED)
		return failure(null, ErrorCode.InvalidRequest, "Invalid Request")
	return Promise.all(messages.map((message) => one(message, context))).then((replies) => {
		const answered = replies.filter((reply) => reply !== undefined) as Reply[]
		return answered.length === 0 ? undefined : answered
	})
}

/** The protocol over `tools`, as `info` names the server, advertising `extensions`. */
export function createProtocol(info: ServerInfo, tools: readonly Tool[], extensions?: object): Protocol {
	const capabilities = { tools: {}, ...(extensions && { extensions }) }
	const byName = new Map(tools.map((tool) => [tool.name, tool]))
	/* `method` under `version`: each era's own methods, and the tools in both; undefined for any other method */
	const served = (request: Asked, method: string, version: string, context: Context) => {
		const { id, params } = request
		const modern = version === MODERN
		switch (modern ? method : `legacy ${method}`) {
			case "server/discover":
				return result(id, {
					_meta: { "io.modelcontextprotocol/serverInfo": info },
					capabilities,
					supportedVersions: PROTOCOL_VERSIONS,
					...CACHED,
				})
			case "legacy initialize":
				context.connection.version =
					PROTOCOL_VERSIONS.slice(1).find((each) => each === params.protocolVersion) ?? LEGACY
				return result(id, {
					capabilities,
					protocolVersion: context.connection.version,
					serverInfo: info,
				})
			case "legacy ping":
				return result(id, {})
			case "tools/list":
			case "legacy tools/list":
				return result(id, {
					tools: tools.map((tool) => listed(tool, version >= STRUCTURED_SINCE)),
					...(modern && CACHED),
				})
			case "tools/call":
			case "legacy tools/call":
				return called(request, byName.get(String(params.name)), version, context)
		}
		return undefined
	}
	const one = (message: unknown, context: Context): Reply | Promise<Reply> | undefined => {
		const { id, jsonrpc, method, params: given } = (isObject(message) ? message : {}) as Message
		if (jsonrpc !== "2.0" || typeof method !== "string")
			return failure(isId(id) ? id : null, ErrorCode.InvalidRequest, "Invalid Request")
		if (!isId(id)) return undefined
		const params = isObject(given) ? given : {}
		/* a modern request's revision is its own `_meta`'s, never the connection's */
		const meta = claimed(params)
		const version = meta === undefined ? (context.connection.version ?? LEGACY) : MODERN
		return (
			(meta && unserved(id, meta)) ??
			served({ id, params }, method, version, context) ??
			failure(id, ErrorCode.MethodNotFound, `Method not found: ${method}`)
		)
	}
	return {
		answer: (message, context) => (Array.isArray(message) ? batch(one, message, context) : one(message, context)),
	}
}
