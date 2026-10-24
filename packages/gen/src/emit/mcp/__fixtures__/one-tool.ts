/**
 * A server on the vendored runtime with one tool (bit 18 phase a): `echo`, its outputSchema declared and its result
 * structured, so a leg sees what each negotiated revision keeps of both; `faulty` throws. `main` is run as a process.
 */
import { createSession } from "../../../runtime/mcp/server.ts"
import { serveStdio } from "../../../runtime/mcp/stdio.ts"

/** Serves the two tools over stdio until stdin closes. */
export const main = (): Promise<void> =>
	serveStdio(
		createSession({ name: "one-tool", version: "1.0.0" }, [
			{
				annotations: { readOnlyHint: true },
				call: async (args) => {
					const value = { echoed: typeof args.text === "string" ? args.text : null }
					return { content: [{ text: JSON.stringify(value), type: "text" }], structuredContent: value }
				},
				description: "Echo the text",
				inputSchema: { properties: { text: { type: "string" } }, type: "object" },
				name: "echo",
				outputSchema: { properties: { echoed: { type: ["string", "null"] } }, type: "object" },
			},
			{
				call: async () => {
					throw new Error("a fault inside the handler")
				},
				inputSchema: { type: "object" },
				name: "faulty",
			},
		]),
	)
