/**
 * The vendored MCP runtime's protocol (bit 18 phase a), on a one-tool server run as a client's process: initialize
 * negotiating a revision; under 2025-03-26 no outputSchema and no structuredContent, both from 2025-06-18; a JSON-RPC
 * error for each protocol fault (parse, request, method, unknown tool, arguments not an object, a handler's own fault),
 * the session going on after each; no reply to a notification; replies in request order; exit 0 once stdin closes and
 * every reply is out. Both official clients connect, their latest revision pinned. Bit 21 b, dual-era: the modern
 * revision 2026-07-28 from each request's own `_meta` (server/discover, `resultType`, the list's cache hints, another
 * revision refused with those served, a `_meta` lacking its required fields invalid, ping, logging/setLevel and
 * initialize gone), batches under 2025-03-26 alone, cancellation in both eras; each era's official TS clients
 * (python-client.test.ts runs Python's).
 */
import { describe, expect, it } from "vitest"
import { clientCheck, clientSession, type Step, withClients } from "./__fixtures__/clients.ts"
import { exchange, initialize, live, request } from "./__fixtures__/written.ts"

const SERVER = [
	"bun",
	"-e",
	`await (await import(${JSON.stringify(new URL("./__fixtures__/one-tool.ts", import.meta.url).pathname)})).main()`,
]
const CLIENTS = withClients()
const SLOW = { timeout: 60_000 }

/** A modern request's `_meta`: its revision and the client's capabilities, both required. */
const META = {
	"io.modelcontextprotocol/clientCapabilities": {},
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
}

/** A modern request: `params` with `meta` as its `_meta`. */
const modern = (id: number, method: string, params: object = {}, meta: object = META) =>
	request(id, method, { ...params, _meta: meta })

/** The replies to `lines` sent with no initialize. */
const answersTo = async (lines: readonly (string | object)[]) => (await exchange(SERVER, lines)).replies

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
	it("answers each with its JSON-RPC error, a notification with nothing, and goes on after each; each fault in order", async () => {
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
		/* a handler's own fault answers once its call is done, so it is matched by id; the protocol faults keep their order */
		const faulted = { error: { code: -32603, message: "Internal error" }, id: 5, jsonrpc: "2.0" }
		const rest = replies.slice(1).filter((reply) => (reply as { id?: unknown }).id !== 5)
		expect([replies.slice(1).filter((reply) => (reply as { id?: unknown }).id === 5), rest]).toEqual([
			[faulted],
			[
				{ error: { code: -32700, message: "Parse error" }, id: null, jsonrpc: "2.0" },
				{ error: { code: -32600, message: "Invalid Request" }, id: 1, jsonrpc: "2.0" },
				{ error: { code: -32601, message: "Method not found: nope" }, id: 2, jsonrpc: "2.0" },
				{ error: { code: -32602, message: "Unknown tool: missing" }, id: 3, jsonrpc: "2.0" },
				{ error: { code: -32602, message: "Tool arguments must be an object" }, id: 4, jsonrpc: "2.0" },
				{ id: 6, jsonrpc: "2.0", result: {} },
			],
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
					["hold", false, undefined],
					["release", false, undefined],
				],
				{ content: [{ text: '{"echoed":"hi"}', type: "text" }], structuredContent: { echoed: "hi" } },
			])
		},
	)
})

describe("the modern era, 2026-07-28 (bit 21 b)", SLOW, () => {
	it("answers server/discover with every revision it serves, its capabilities and identity, complete and cacheable", async () => {
		expect(await answersTo([modern(1, "server/discover")])).toEqual([
			{
				id: 1,
				jsonrpc: "2.0",
				result: {
					_meta: { "io.modelcontextprotocol/serverInfo": { name: "one-tool", version: "1.0.0" } },
					cacheScope: "private",
					capabilities: { tools: {} },
					resultType: "complete",
					supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"],
					ttlMs: 300_000,
				},
			},
		])
	})

	it("serves each request from its own _meta: every result complete, the list with its cache hints, whatever the connection negotiated", async () => {
		const answered = (await session("2025-03-26", [
			modern(1, "tools/list"),
			modern(2, "tools/call", { arguments: { text: "hi" }, name: "echo" }),
			request(3, "tools/list"),
		])) as { id: number; result: Record<string, unknown> & { tools: Record<string, unknown>[] } }[]
		/* a call answers once it is done, so each reply is read by its id */
		const [listed, called, legacy] = [1, 2, 3].map((id) => answered.find((reply) => reply.id === id))
		const { tools, ...hints } = listed?.result ?? { tools: [] }
		expect([
			hints,
			tools.map((tool) => "outputSchema" in tool),
			called?.result,
			Object.keys(legacy?.result ?? {}),
			legacy?.result.tools.map((tool) => "outputSchema" in tool),
		]).toEqual([
			{ cacheScope: "private", resultType: "complete", ttlMs: 300_000 },
			[true, false, false, false],
			{
				content: [{ text: '{"echoed":"hi"}', type: "text" }],
				resultType: "complete",
				structuredContent: { echoed: "hi" },
			},
			["tools"],
			[false, false, false, false],
		])
	})
})

describe("the modern era's refusals (bit 21 b)", SLOW, () => {
	it.each(["2025-11-25", "2025-03-26", "1900-01-01"])(
		"refuses %s in _meta with -32022, naming each revision it serves and the one asked",
		async (asked) => {
			const meta = { ...META, "io.modelcontextprotocol/protocolVersion": asked }
			expect(await answersTo([modern(1, "tools/list", {}, meta)])).toEqual([
				{
					error: {
						code: -32022,
						data: { requested: asked, supported: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26"] },
						message: "Unsupported protocol version",
					},
					id: 1,
					jsonrpc: "2.0",
				},
			])
		},
	)

	it("refuses a _meta whose revision is no string or that lacks the client's capabilities, with -32602", async () => {
		const version = "io.modelcontextprotocol/protocolVersion"
		const metas = [
			{ [version]: "2026-07-28" },
			{ ...META, [version]: 20260728 },
			{ ...META, "io.modelcontextprotocol/clientCapabilities": null },
		]
		const answered = await answersTo(metas.map((meta, i) => modern(i + 1, "server/discover", {}, meta)))
		const message = `Invalid params: needs ${version} and io.modelcontextprotocol/clientCapabilities`
		expect(answered).toEqual([1, 2, 3].map((id) => ({ error: { code: -32602, message }, id, jsonrpc: "2.0" })))
	})

	it("answers ping, logging/setLevel and initialize as methods it does not have", async () => {
		const methods = ["ping", "logging/setLevel", "initialize"]
		expect(await answersTo(methods.map((method, i) => modern(i + 1, method)))).toEqual(
			methods.map((method, i) => ({
				error: { code: -32601, message: `Method not found: ${method}` },
				id: i + 1,
				jsonrpc: "2.0",
			})),
		)
	})
})

describe("batches (bit 21 b)", SLOW, () => {
	const notification = { jsonrpc: "2.0", method: "notifications/initialized" }
	const invalid = { error: { code: -32600, message: "Invalid Request" }, id: null, jsonrpc: "2.0" }

	it("answers a batch under 2025-03-26 as one array of its requests' replies, none for a notification, nothing for notifications alone", async () => {
		const [, ...rest] = await session("2025-03-26", [
			[request(1, "ping"), notification, request(2, "tools/list")],
			[notification],
			[],
		])
		const [batch] = rest.filter(Array.isArray) as { id: number; result: { tools?: Record<string, unknown>[] } }[][]
		expect([
			rest.length,
			rest.filter((reply) => !Array.isArray(reply)),
			batch?.map((reply) => [reply.id, reply.result.tools?.some((tool) => "outputSchema" in tool) ?? null]),
		]).toEqual([
			2,
			[invalid],
			[
				[1, null],
				[2, false],
			],
		])
	})

	it.each([["2025-11-25"], ["2025-06-18"], ["no initialize"], ["2026-07-28"]])(
		"refuses a batch under %s with JSON-RPC's Invalid Request: every revision after 2025-03-26 dropped batches",
		async (era) => {
			const batch = era === "2026-07-28" ? [modern(1, "tools/list")] : [request(1, "ping")]
			const lines = era.startsWith("20") && era !== "2026-07-28" ? [initialize(era), batch] : [batch]
			expect((await answersTo(lines)).slice(lines.length - 1)).toEqual([invalid])
		},
	)
})

describe("cancellation (bit 21 b)", SLOW, () => {
	it.each(["2026-07-28", "2025-11-25"])(
		"under %s, aborts the call a notifications/cancelled names and writes nothing more for it; the session goes on",
		async (era) => {
			const server = live(SERVER)
			const meta = (more: object) => (era === "2026-07-28" ? { ...META, ...more } : more)
			if (era !== "2026-07-28") server.send(initialize(era))
			server.send(request(1, "tools/call", { _meta: meta({ progressToken: "held" }), arguments: {}, name: "hold" }))
			await server.seen((line) => line.method === "notifications/progress")
			server.send({
				jsonrpc: "2.0",
				method: "notifications/cancelled",
				params: { reason: "done waiting", requestId: 1 },
			})
			server.send(request(2, "tools/call", { _meta: meta({}), arguments: {}, name: "release" }))
			await server.seen((line) => line.id === 2)
			const { replies: written, status } = await server.close()
			const lines = written as Record<string, unknown>[]
			expect([
				status,
				lines.filter((line) => line.id === 1),
				lines
					.filter((line) => line.method === "notifications/progress")
					.map((line) => (line.params as { progress: number }).progress),
				(lines.find((line) => line.id === 2)?.result as { content: unknown } | undefined)?.content,
			]).toEqual([0, [], [1], [{ text: "released", type: "text" }]])
		},
	)
})

describe("a duplicate id in flight (bit 21 h)", SLOW, () => {
	it("answers each call under a repeated id on its own, the cancel naming that id reaching the later one alone", async () => {
		const server = live(SERVER)
		const hold = (token: string) =>
			request(1, "tools/call", { _meta: { ...META, progressToken: token }, arguments: {}, name: "hold" })
		const progressed = (token: string) => (line: Record<string, unknown>) =>
			line.method === "notifications/progress" && (line.params as { progressToken?: unknown }).progressToken === token
		server.send(hold("first"))
		await server.seen(progressed("first"))
		server.send(hold("second"))
		await server.seen(progressed("second"))
		server.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })
		server.send(request(2, "tools/call", { _meta: META, arguments: {}, name: "release" }))
		await server.seen((line) => line.id === 2)
		const { replies, status } = await server.close()
		const lines = replies as Record<string, unknown>[]
		expect([
			status,
			lines
				.filter((line) => line.method === "notifications/progress")
				.map((line) => {
					const { progress, progressToken } = line.params as { progress: number; progressToken: string }
					return `${progressToken} ${progress}`
				}),
			lines.filter((line) => line.id === 1).map((line) => (line.result as { content: unknown }).content),
		]).toEqual([0, ["first 1", "second 1", "first 2"], [[{ text: "released", type: "text" }]]])
	})
})

describe.skipIf(!CLIENTS)("each era's official clients (bit 21 b)", SLOW, () => {
	const steps: Step[] = [{ negotiated: true }, { call: { arguments: { text: "hi" }, name: "echo" } }]
	it.each([
		["sdk", "2025-11-25"],
		["v2", "2025-11-25"],
		["modern", "2026-07-28"],
	] as const)("%s runs its session under %s and gets structuredContent", async (client, era) => {
		const [negotiated, called] = await clientSession(client, SERVER, steps)
		expect([negotiated, called?.result?.structuredContent]).toEqual([{ negotiated: era }, { echoed: "hi" }])
	})
})
