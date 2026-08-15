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
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { Tool, ToolResult } from "./types.ts"

type ServerError = Error & { status?: number; body?: unknown; data?: unknown }

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
		return {
			content: [{ text: JSON.stringify(payload), type: "text" }],
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
			const result = await tool.handler((args ?? {}) as Record<string, unknown>, sdk)
			return result
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
