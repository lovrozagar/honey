/* Static MCP stdio runtime — copied verbatim into emitted packages by codegen-mcp.ts.
 * Consumes a Tool[] array + SDK instance. Wires MCP low-level Server class to
 * stdio JSON-RPC. Maps SDK client errors -> { isError: true, content: [...] }.
 *
 * Intentional choice of low-level `Server` over `McpServer`: tool inputSchema is
 * already JSON Schema (emitted from OpenAPI). `McpServer.registerTool` requires
 * zod; switching would mean carrying json-schema-to-zod at runtime for zero gain.
 * `Server` is marked @deprecated but the SDK's own guidance says to use it for
 * advanced/codegen cases — keep until SDK exposes a JSON-Schema-native path. */

/* eslint-disable @typescript-eslint/no-deprecated */
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { Tool, ToolResult } from "./types.ts"

type ServerError = Error & { status?: number; body?: unknown; data?: unknown }

/** Per argument group, the keys a tool may forward (`true`: the whole JSON body). */
export type AllowedArgs = { headers?: string[]; json?: true; params?: string[]; search?: string[] }

/* Tool results go into a model's context: cap them. */
const MAX_RESULT_CHARS = 100_000

function errorResult(message: string, extra: Record<string, unknown> = {}): ToolResult {
	return { content: [{ text: JSON.stringify({ message, ...extra }), type: "text" }], isError: true }
}

function typeOf(value: unknown): string {
	if (value === null) return "null"
	if (Array.isArray(value)) return "array"
	if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
	return typeof value
}

function matchesType(value: unknown, type: unknown): boolean {
	if (type === undefined) return true
	const types = Array.isArray(type) ? type : [type]
	const actual = typeOf(value)
	return types.some((t) => t === actual || (t === "number" && actual === "integer"))
}

/**
 * The subset of JSON Schema that OpenAPI-derived tool schemas use: type, required,
 * properties, items, enum, const, nullable. Enough to reject malformed arguments before
 * they reach the API; the server validates the rest.
 */
export function validateArgs(schema: Record<string, unknown>, value: unknown, path = "arguments"): string[] {
	const errors: string[] = []
	if (value === null && schema.nullable === true) return errors
	if (!matchesType(value, schema.type)) {
		errors.push(`${path}: expected ${JSON.stringify(schema.type)}, got ${typeOf(value)}`)
		return errors
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
		errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`)
	}
	if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
		errors.push(`${path}: must be ${JSON.stringify(schema.const)}`)
	}
	if (typeOf(value) === "object") {
		const obj = value as Record<string, unknown>
		const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
		for (const key of (schema.required ?? []) as string[]) {
			if (!Object.hasOwn(obj, key) || obj[key] === undefined) errors.push(`${path}.${key}: required`)
		}
		for (const [key, sub] of Object.entries(props)) {
			if (Object.hasOwn(obj, key) && obj[key] !== undefined)
				errors.push(...validateArgs(sub, obj[key], `${path}.${key}`))
		}
	}
	if (Array.isArray(value) && schema.items && typeof schema.items === "object") {
		value.forEach((item, i) =>
			errors.push(...validateArgs(schema.items as Record<string, unknown>, item, `${path}[${i}]`)),
		)
	}
	return errors
}

function pick(source: unknown, keys: string[]): Record<string, unknown> | undefined {
	if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined
	const out: Record<string, unknown> = {}
	for (const key of keys) {
		if (Object.hasOwn(source, key) && (source as Record<string, unknown>)[key] !== undefined) {
			out[key] = (source as Record<string, unknown>)[key]
		}
	}
	return Object.keys(out).length > 0 ? out : undefined
}

function formatResult(result: unknown): ToolResult {
	let text: string
	if (typeof result === "string") text = result
	else if (result instanceof ArrayBuffer || ArrayBuffer.isView(result)) {
		const bytes = result instanceof ArrayBuffer ? result.byteLength : result.byteLength
		text = JSON.stringify({ binary: true, bytes, message: "binary response not shown" })
	} else if (typeof Blob !== "undefined" && result instanceof Blob) {
		text = JSON.stringify({ binary: true, bytes: result.size, message: "binary response not shown", type: result.type })
	} else text = JSON.stringify(result ?? null)
	if (text.length > MAX_RESULT_CHARS) {
		text = `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${text.length} characters, showing ${MAX_RESULT_CHARS}]`
	}
	return { content: [{ text, type: "text" }] }
}

/**
 * Run one tool call: validate `args` against the tool's input schema, forward only the keys
 * the operation declares (never extra headers, cookies or a raw body), refuse path params that
 * would change the request path, and call the SDK method at `segments`.
 */
export async function callTool(
	sdk: unknown,
	segments: string[],
	args: Record<string, unknown>,
	inputSchema: Record<string, unknown>,
	allowed: AllowedArgs,
): Promise<ToolResult> {
	const errors = validateArgs(inputSchema, args ?? {})
	if (errors.length > 0) return errorResult("Invalid tool arguments", { errors: errors.slice(0, 20) })

	const input: Record<string, unknown> = {}
	for (const group of ["params", "search", "headers"] as const) {
		const keys = allowed[group]
		if (!keys) continue
		const picked = pick(args[group], keys)
		if (picked) input[group] = picked
	}
	if (allowed.json && args.json !== undefined) input.json = args.json

	const params = input.params as Record<string, unknown> | undefined
	for (const [key, value] of Object.entries(params ?? {})) {
		const text = String(value)
		if (text === "" || text === "." || text === "..") {
			return errorResult(`Invalid path parameter ${JSON.stringify(key)}: ${JSON.stringify(text)}`)
		}
		params![key] = text
	}

	let method: unknown = sdk
	let owner: unknown = sdk
	for (const seg of segments) {
		owner = method
		method = method !== null && typeof method === "object" ? (method as Record<string, unknown>)[seg] : undefined
	}
	if (typeof method !== "function") return errorResult(`SDK missing method ${segments.join(".")}`)
	return formatResult(await (method as (input: unknown) => Promise<unknown>).call(owner, input))
}

function formatError(err: unknown): ToolResult {
	if (err instanceof Error) {
		const e = err as ServerError
		const status = typeof e.status === "number" ? e.status : 0
		const payload: Record<string, unknown> = {
			message: e.message,
			name: e.name,
		}
		if (status > 0) payload.status = status
		if (e.data !== undefined) payload.data = e.data
		else if (e.body !== undefined) payload.data = e.body
		const text = JSON.stringify(payload)
		return {
			content: [{ text: text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}…` : text, type: "text" }],
			isError: true,
		}
	}
	return {
		content: [{ text: JSON.stringify({ message: String(err) }), type: "text" }],
		isError: true,
	}
}

export async function createMCPServer(options: {
	tools: Tool[]
	sdk: unknown
	serverInfo: { name: string; version: string }
}): Promise<void> {
	const { tools, sdk, serverInfo } = options

	const server = new Server(serverInfo, {
		capabilities: { tools: {} },
	})

	server.setRequestHandler(ListToolsRequestSchema, () => {
		return {
			tools: tools.map((t) => ({
				description: t.description,
				inputSchema: t.inputSchema,
				name: t.name,
			})),
		}
	})

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params
		const tool = tools.find((t) => t.name === name)
		if (!tool) {
			return {
				content: [{ text: JSON.stringify({ message: `Unknown tool: ${name}` }), type: "text" }],
				isError: true,
			}
		}
		try {
			return await tool.handler((args ?? {}) as Record<string, unknown>, sdk)
		} catch (err: unknown) {
			return formatError(err)
		}
	})

	const transport = new StdioServerTransport()

	/* graceful shutdown on SIGTERM / stdin close — stdio transport closes on stdin EOF,
	 * Server.close() flushes pending responses, process.exit(0) per MCP conventions. */
	const shutdown = (): void => {
		void server.close().finally(() => process.exit(0))
	}
	process.on("SIGTERM", shutdown)
	process.on("SIGINT", shutdown)
	process.stdin.on("end", shutdown)

	await server.connect(transport)
}
