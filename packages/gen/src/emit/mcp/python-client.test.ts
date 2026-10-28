/**
 * The official Python MCP client against the vendored runtime (bit 21 b): `mcp` 2.3.0 pinned to 2026-07-28 drives the
 * one-tool server over stdio in the modern era, listing every tool with its schemas and calling one, its result
 * complete with its structuredContent. In the `python` project: its client runs through python-env.
 */
import { describe, expect, it } from "vitest"
import { withPython } from "../python/__fixtures__/python-env.ts"
import { pythonSession } from "./__fixtures__/python-client.ts"

const SERVER = [
	"bun",
	"-e",
	`await (await import(${JSON.stringify(new URL("./__fixtures__/one-tool.ts", import.meta.url).pathname)})).main()`,
]

/* a cold venv installing mcp 2.3.0 and its pinned dependencies, then a stdio session: 8fa1d3c's bound for it */
const PYTHON_CLIENT = 300_000

describe.skipIf(!withPython())("the Python client (bit 21 b)", { timeout: PYTHON_CLIENT }, () => {
	it("mcp 2.3.0, pinned to 2026-07-28, lists the tools with their schemas and gets structuredContent, complete", async () => {
		const [negotiated, listed, called] = await pythonSession(SERVER, [
			{ negotiated: true },
			{ list: true },
			{ call: { arguments: { text: "hi" }, name: "echo" } },
		])
		expect([negotiated, listed?.tools?.map((tool) => [tool.name, Boolean(tool.outputSchema)]), called?.result]).toEqual(
			[
				{ negotiated: "2026-07-28" },
				[
					["echo", true],
					["faulty", false],
					["hold", false],
					["release", false],
				],
				{
					content: [{ text: '{"echoed":"hi"}', type: "text" }],
					isError: false,
					resultType: "complete",
					structuredContent: { echoed: "hi" },
				},
			],
		)
	})
})
