/**
 * The official Python MCP client against the vendored runtime (bit 21 b): `mcp` 2.3.0 pinned to 2026-07-28 drives the
 * one-tool server over stdio in the modern era, listing every tool with its schemas and calling one, its result
 * complete with its structuredContent. In the `python` project: its client runs through python-env. Bit 21 h: over
 * Streamable HTTP against any URL, every request carrying the target's headers as given (a mount's `ApiKey`), and a
 * refused request reported as its step's failure.
 */
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { withPython } from "../python/__fixtures__/python-env.ts"
import { pythonHttpSession, pythonSession } from "./__fixtures__/python-client.ts"

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

	it("sends the target's headers as given on every request, and reports a refused request as its step's failure", async () => {
		const seen: IncomingHttpHeaders[] = []
		const server = createServer((request, response) => {
			seen.push(request.headers)
			request.resume()
			response.writeHead(401, { "www-authenticate": "ApiKey" }).end()
		})
		await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening))
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`
		try {
			const stepped = await pythonHttpSession({ headers: { authorization: "ApiKey ak_1", "x-tenant": "t1" }, url }, [
				{ list: true },
			])
			expect([
				seen.length > 0,
				seen
					.map((headers) => [headers.authorization, headers["x-tenant"]])
					.filter(([key, tenant]) => key !== "ApiKey ak_1" || tenant !== "t1"),
				stepped.length,
				typeof stepped[0]?.failed,
			]).toEqual([true, [], 1, "string"])
		} finally {
			await new Promise((closed) => server.close(closed))
		}
	})
})
