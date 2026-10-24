/**
 * The vendored MCP runtime's protocol (bit 18 phase a), on a one-tool server run as a client's process: initialize
 * negotiating a revision; under 2025-03-26 no outputSchema and no structuredContent, both from 2025-06-18; a JSON-RPC
 * error for each protocol fault (parse, request, method, unknown tool, arguments not an object, a handler's own fault),
 * the session going on after each; no reply to a notification; replies in request order; exit 0 once stdin closes and
 * every reply is out. Both official clients connect, their latest revision pinned.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { clientCheck, clientsInstall, withClients } from "./__fixtures__/clients.ts"
import { exchange, initialize, request } from "./__fixtures__/written.ts"

const SERVER = [
	"bun",
	"-e",
	`await (await import(${JSON.stringify(new URL("./__fixtures__/one-tool.ts", import.meta.url).pathname)})).main()`,
]
const CLIENTS = withClients()
const SLOW = { timeout: 60_000 }

/** The replies to `lines` after an initialize asking for `version`, the initialize's own reply first. */
const session = async (version: string, lines: readonly (string | object)[]) =>
	(await exchange(SERVER, [initialize(version), ...lines])).replies

describe("initialize (phase a)", SLOW, () => {
	// v0: 9b7c875bdd
	it("answers each revision it serves with that revision, and any other with the newest", async () => {
		const asked = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2026-07-28"]
		const replies = await Promise.all(asked.map(async (version) => (await session(version, []))[0]))
		expect(replies.map((reply) => (reply as { result: { protocolVersion: string } }).result.protocolVersion)).toEqual([
			"2025-11-25",
			"2025-06-18",
			"2025-03-26",
			"2025-11-25",
			"2025-11-25",
		])
		expect((replies[0] as { result: unknown }).result).toEqual({
			capabilities: { tools: {} },
			protocolVersion: "2025-11-25",
			serverInfo: { name: "one-tool", version: "1.0.0" },
		})
	})
})

describe("the tools under each revision (phase a)", SLOW, () => {
	const listAndCall = [request(1, "tools/list"), request(2, "tools/call", { arguments: { text: "hi" }, name: "echo" })]
	it.each([
		["2025-03-26", false],
		["2025-06-18", true],
		["2025-11-25", true],
	])("under %s, carries an outputSchema and structuredContent: %s", async (version, structured) => {
		const [, listed, called] = (await session(version, listAndCall)) as [
			unknown,
			{ result: { tools: Record<string, unknown>[] } },
			{ result: Record<string, unknown> },
		]
		expect([
			"outputSchema" in (listed.result.tools[0] ?? {}),
			"structuredContent" in called.result,
			called.result.content,
		]).toEqual([structured, structured, [{ text: '{"echoed":"hi"}', type: "text" }]])
	})
})

describe("protocol faults (phase a)", SLOW, () => {
	it("answers each with its JSON-RPC error, a notification with nothing, and goes on after each, in order", async () => {
		const replies = await session("2025-11-25", [
			"not json",
			{ id: 1, method: "ping" },
			request(2, "nope"),
			request(3, "tools/call", { arguments: {}, name: "missing" }),
			request(4, "tools/call", { arguments: [1], name: "echo" }),
			request(5, "tools/call", { arguments: {}, name: "faulty" }),
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			request(6, "ping"),
		])
		expect(replies.slice(1)).toEqual([
			{ error: { code: -32700, message: "Parse error" }, id: null, jsonrpc: "2.0" },
			{ error: { code: -32600, message: "Invalid Request" }, id: 1, jsonrpc: "2.0" },
			{ error: { code: -32601, message: "Method not found: nope" }, id: 2, jsonrpc: "2.0" },
			{ error: { code: -32602, message: "Unknown tool: missing" }, id: 3, jsonrpc: "2.0" },
			{ error: { code: -32602, message: "Tool arguments must be an object" }, id: 4, jsonrpc: "2.0" },
			{ error: { code: -32603, message: "Internal error" }, id: 5, jsonrpc: "2.0" },
			{ id: 6, jsonrpc: "2.0", result: {} },
		])
	})

	// v0: a5e3793edc
	it("exits 0 once its input closes, every reply written first, nothing on stderr", async () => {
		const ran = await exchange(SERVER, [initialize("2025-11-25"), request(1, "ping")])
		expect([ran.status, ran.replies.length, ran.stderr]).toEqual([0, 2, ""])
	})

	it("answers a last line its client sent without a newline before stdin closed", async () => {
		const ran = await exchange(SERVER, [initialize("2025-11-25"), request(1, "ping")], false)
		expect(ran.replies.at(-1)).toEqual({ id: 1, jsonrpc: "2.0", result: {} })
	})
})

describe.skipIf(!CLIENTS)("the official clients (phase a)", SLOW, () => {
	it.each(["sdk", "v2"] as const)(
		"connect through %s: list the tool with its schemas and annotations, get structuredContent",
		async (client) => {
			const saw = await clientCheck(client, SERVER, { arguments: { text: "hi" }, name: "echo" })
			expect([
				saw.latest,
				saw.tools.map((tool) => [tool.name, Boolean(tool.outputSchema), tool.annotations]),
				saw.called,
			]).toEqual([
				"2025-11-25",
				[
					["echo", true, { readOnlyHint: true }],
					["faulty", false, undefined],
				],
				{ content: [{ text: '{"echoed":"hi"}', type: "text" }], structuredContent: { echoed: "hi" } },
			])
		},
	)
})

describe("the official clients in CI (phase a)", () => {
	it("installs them in the test job by the command the fixture names, verbatim", () => {
		const workflow = readFileSync(new URL("../../../../../.github/workflows/ci.yml", import.meta.url), "utf8")
		const test = workflow.slice(workflow.indexOf("\n  test:\n"), workflow.indexOf("\n  gen-rust:\n"))
		expect(test.split("\n").some((line) => line.trim() === `run: ${clientsInstall()}`)).toBe(true)
	})
})
