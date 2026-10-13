/* Static MCP runtime types — copied verbatim into emitted packages by codegen-mcp.ts.
 * No @modelcontextprotocol/sdk imports here: keeps type surface decoupled from the
 * SDK so callers (tool authors) only depend on this shared shape. */

export type ToolContent = { type: "text"; text: string }

export type ToolResult = {
	content: ToolContent[]
	isError?: boolean
}

export type ToolHandler = (args: Record<string, unknown>, sdk: unknown) => Promise<ToolResult>

export type Tool = {
	name: string
	description?: string
	inputSchema: Record<string, unknown>
	handler: ToolHandler
}
