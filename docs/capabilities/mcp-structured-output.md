# MCP structured output

The generated MCP server gives every tool an
`outputSchema` from the operation's success response, and answers with `structuredContent` an agent can read as
data, beside a text rendering. An error comes back as a tool error with its status and key, never as a successful
result.

## Example

```json
{
	"name": "orders_get",
	"inputSchema": { "type": "object", "properties": { "id": { "type": "string" } }, "required": ["id"] },
	"outputSchema": { "type": "object", "properties": { "id": { "type": "string" }, "status": { "type": "string" } } }
}
```

Tested by: `emit/mcp/output-schema.test.ts`
