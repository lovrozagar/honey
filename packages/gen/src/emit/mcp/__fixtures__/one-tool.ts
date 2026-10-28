/**
 * A server on the vendored runtime with one tool (bit 18 phase a): `echo`, its outputSchema declared and its result
 * structured, so a leg sees what each negotiated revision keeps of both; `faulty` throws. `hold` (bit 21 b) reports
 * progress 1, then waits until its call is aborted or `release` is called, then reports progress 2 and answers: a
 * latch a cancellation leg drives with no timer. `main` is run as a process.
 */
import { createProtocol } from "../../../runtime/mcp/protocol.ts"
import { serveStdio } from "../../../runtime/mcp/stdio.ts"

/** Serves the tools over stdio until stdin closes. */
export const main = (): Promise<void> => {
	const held = new Set<() => void>()
	return serveStdio(
		createProtocol({ name: "one-tool", version: "1.0.0" }, [
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
			{
				call: async (_, signal, progress) => {
					progress(1)
					await new Promise<void>((settle) => {
						held.add(settle)
						signal.addEventListener("abort", () => settle())
					})
					progress(2)
					return { content: [{ text: signal.aborted ? "aborted" : "released", type: "text" }] }
				},
				inputSchema: { type: "object" },
				name: "hold",
			},
			{
				call: async () => {
					for (const settle of held) settle()
					held.clear()
					return { content: [{ text: "released", type: "text" }] }
				},
				inputSchema: { type: "object" },
				name: "release",
			},
		]),
	)
}
