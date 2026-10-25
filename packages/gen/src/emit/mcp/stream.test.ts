/**
 * An event stream as a tool through the emitted server (bit 18 phase e, Q6), its process against a recording server:
 * one bounded collect, `{events, last_event_id, ended}`. It stops when the stream ends, at `max_events` (its body then
 * closed), past 100,000 characters, or at the call's bound, `$<PREFIX>_TIMEOUT_MS` from its start, a cut that is a
 * success to resume from. A stream that never opened within the bound is a timeout, and one answered outside 2xx its
 * failure. `last_event_id` resumes, each event is a progress step, and SIGTERM ends the server mid-collect, exit 0, no
 * reply written after.
 */
import { spawn } from "node:child_process"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { clientCheck, withClients } from "./__fixtures__/clients.ts"
import type { SseStep } from "../shared/__fixtures__/sse-steps.ts"
import { exchangeEach, initialize, live, request, written } from "./__fixtures__/written.ts"
import { generateMcpServer } from "./server.ts"

const SLOW = { timeout: 120_000 }
const CLIENTS = withClients()

/** A GET answering an event stream of `data`. */
const stream = (id: string, data: unknown) => ({
	get: {
		operationId: id,
		responses: { 200: { content: { "text/event-stream": { schema: data } }, description: "events" } },
		"x-mcp": true,
	},
})

/** The feed document: `feed.watch` a stream of strings, `ticks.watch` of JSON objects, `ping.get` a plain answer. */
const feed = {
	info: { title: "Feed", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/feed": stream("feed.watch", { type: "string" }),
		"/ping": {
			get: {
				operationId: "ping.get",
				responses: { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } },
				"x-mcp": true,
			},
		},
		"/ticks": stream("ticks.watch", { properties: { n: { type: "integer" } }, type: "object" }),
	},
}

/** `n` events, their ids 1 to `n`, each `data` of its number. */
const events = (n: number, data = (i: number): string => `e${i}`) =>
	Array.from({ length: n }, (_, i) => `id: ${i + 1}\ndata: ${data(i + 1)}\n\n`)

/** A reply streaming `steps`, ending as `end` says. */
const sse = (steps: readonly SseStep[], end: "close" | "hold"): Reply => ({ sse: { end, steps }, status: 200 })

/** The feed server run against a recording server answering `replies`, with `env`: its replies and the server. */
async function run(lines: readonly object[], replies: readonly Reply[], env: string[] = []) {
	const dir = written(generateMcpServer(feed).files)
	return served(replies, async (server) => {
		const command = ["env", `FEED_BASE_URL=${server.url}`, ...env, process.execPath, join(dir, "dist", "server.js")]
		const ran = await exchangeEach(command, [initialize("2025-11-25"), ...lines])
		return { hops: server.hops, replies: ran.replies.slice(1) as Record<string, unknown>[] }
	})
}

/** A tools/call of `name` with `args`, as request `id`. */
const call = (id: number, name: string, args: Record<string, unknown> = {}, meta?: object) =>
	request(id, "tools/call", { arguments: args, name, ...(meta ? { _meta: meta } : {}) })

/** A reply's result's structuredContent, else its result. */
const outcome = (reply: Record<string, unknown> | undefined) => {
	const result = reply?.result as { structuredContent?: unknown; isError?: true; content?: [{ text: string }] }
	return result?.structuredContent ?? { isError: result?.isError, text: JSON.parse(result?.content?.[0].text ?? "{}") }
}

describe("an event stream's collect (phase e)", SLOW, () => {
	it("stops at the stream's end, at max_events with its body closed, and past 100,000 characters", async () => {
		const left: boolean[] = []
		const big = "x".repeat(40_000)
		const { replies } = await run(
			[call(1, "feed_watch"), call(2, "feed_watch", { max_events: 3 }), call(3, "ping_get"), call(4, "feed_watch")],
			[
				sse(events(2), "close"),
				sse(events(5), "hold"),
				{ afterLeft: { seen: (gone) => left.push(gone), stream: 1, withinMs: 10_000 }, json: {}, status: 200 },
				sse(
					events(3, () => big),
					"hold",
				),
			],
		)
		expect([outcome(replies[0]), outcome(replies[1]), left, outcome(replies[3])]).toEqual([
			{
				ended: "end",
				events: [
					{ data: "e1", id: "1" },
					{ data: "e2", id: "2" },
				],
				last_event_id: "2",
			},
			{ ended: "max_events", events: [1, 2, 3].map((i) => ({ data: `e${i}`, id: String(i) })), last_event_id: "3" },
			[true],
			{ ended: "cap", events: [1, 2].map((i) => ({ data: big, id: String(i) })), last_event_id: "2" },
		])
	})

	it("parses JSON events, resumes after last_event_id, and reports each event as a progress step", async () => {
		const { hops, replies } = await run(
			[call(1, "ticks_watch", { last_event_id: "7" }, { progressToken: "p" })],
			[
				sse(
					events(2, (i) => JSON.stringify({ n: i })),
					"close",
				),
			],
		)
		expect([hops[0]?.headers["last-event-id"], replies.slice(0, 2), outcome(replies[2])]).toEqual([
			"7",
			[1, 2].map((progress) => ({
				jsonrpc: "2.0",
				method: "notifications/progress",
				params: { progress, progressToken: "p" },
			})),
			{ ended: "end", events: [1, 2].map((n) => ({ data: { n }, id: String(n) })), last_event_id: "2" },
		])
	})
})

describe("an event stream's tool (phase e)", SLOW, () => {
	it("lists max_events (1 to 100) and last_event_id as its arguments and {events, last_event_id, ended} as its output", async () => {
		const { replies } = await run([request(1, "tools/list")], [])
		const { tools } = (replies[0]?.result ?? { tools: [] }) as { tools: Record<string, unknown>[] }
		const tool = tools.find((listed) => listed.name === "feed_watch") ?? {}
		const output = (tool.outputSchema ?? { properties: {}, required: [] }) as {
			properties: Record<string, unknown>
			required: string[]
		}
		expect([
			((tool.inputSchema ?? {}) as { properties?: Record<string, unknown> }).properties,
			Object.keys(output.properties),
			output.required,
		]).toEqual([
			{
				last_event_id: { description: "Resume after this event id: a collect's last_event_id", type: "string" },
				max_events: {
					description: "The most events to collect, 1 to 100; 20 when omitted",
					maximum: 100,
					minimum: 1,
					type: "integer",
				},
			},
			["events", "last_event_id", "ended"],
			["events", "last_event_id", "ended"],
		])
	})

	it("collects 20 events when max_events is not given, and refuses one outside 1 to 100, sending nothing", async () => {
		const { hops, replies } = await run(
			[call(1, "feed_watch"), call(2, "feed_watch", { max_events: 0 }), call(3, "feed_watch", { max_events: 101 })],
			[sse(events(25), "hold")],
		)
		const collected = outcome(replies[0]) as { ended: string; events: unknown[] }
		expect([collected.ended, collected.events.length, outcome(replies[1]), outcome(replies[2]), hops.length]).toEqual([
			"max_events",
			20,
			{ isError: true, text: { message: "Invalid arguments: max_events must be at least 1" } },
			{ isError: true, text: { message: "Invalid arguments: max_events must be at most 100" } },
			1,
		])
	})

	it.skipIf(!CLIENTS).each(["sdk", "v2"] as const)(
		"lets %s validate a collect against its outputSchema",
		async (client) => {
			const dir = written(generateMcpServer(feed).files)
			const saw = await served([sse(events(2), "close")], (server) =>
				clientCheck(client, ["env", `FEED_BASE_URL=${server.url}`, process.execPath, join(dir, "dist", "server.js")], {
					arguments: { max_events: 5 },
					name: "feed_watch",
				}),
			)
			expect([saw.failed, (saw.called as { structuredContent?: { ended?: string } }).structuredContent?.ended]).toEqual(
				[undefined, "end"],
			)
		},
	)
})

describe("an event stream's bound (phase e)", SLOW, () => {
	it("cuts at $<PREFIX>_TIMEOUT_MS as a success to resume from; a stream never opened in it is a timeout", async () => {
		const [cut, unopened] = await Promise.all([
			/* event 1, then held open: only the bound ends it */
			boundedReply([sse(events(1), "hold")], ["FEED_TIMEOUT_MS=2000"]),
			boundedReply([{ delayMs: 5_000, sse: { end: "close", steps: [] }, status: 200 }], ["FEED_TIMEOUT_MS=300"]),
		])
		expect([outcome(cut), outcome(unopened)]).toEqual([
			{ ended: "timeout", events: [{ data: "e1", id: "1" }], last_event_id: "1" },
			{ isError: true, text: { kind: "timeout", message: "The stream did not open within the call's timeout" } },
		])
	})

	it("delivers every event of a stream paced by its client's progress, nothing cutting it inside the bound", async () => {
		const dir = written(generateMcpServer(feed).files)
		let server: ReturnType<typeof live> | undefined
		/* event n goes out only once the client saw progress n − 1: the gaps are latches, not timers */
		const progressed = (n: number) => () =>
			(server as ReturnType<typeof live>).seen(
				(line) => (line.params as { progress?: number } | undefined)?.progress === n,
			)
		const [first, second, third] = events(3)
		const steps = [first, { after: progressed(1) }, second, { after: progressed(2) }, third] as SseStep[]
		const result = await served([sse(steps, "close")], async (recording) => {
			server = live([
				"env",
				`FEED_BASE_URL=${recording.url}`,
				"FEED_TIMEOUT_MS=10000",
				process.execPath,
				join(dir, "dist", "server.js"),
			])
			server.send(initialize("2025-11-25"))
			server.send(call(1, "feed_watch", {}, { progressToken: "t" }))
			const reply = await server.seen((line) => line.id === 1)
			await server.close()
			return reply
		})
		expect(outcome(result)).toEqual({
			ended: "end",
			events: [1, 2, 3].map((i) => ({ data: `e${i}`, id: String(i) })),
			last_event_id: "3",
		})
	})

	it("answers a stream refused outside 2xx as its failure, isError with its status", async () => {
		const { replies } = await run([call(1, "feed_watch")], [{ json: { message: "down" }, status: 503 }])
		expect(outcome(replies[0])).toMatchObject({ isError: true, text: { status: 503 } })
	})
})

/** The reply to one `feed_watch` against `replies`, waited on 10 s at most, so a collect no bound ends fails here. */
async function boundedReply(replies: readonly Reply[], env: string[]) {
	return served(replies, async (recording) => {
		const server = await liveFeed(recording, env)
		server.send(call(1, "feed_watch"))
		await vi.waitFor(() => expect(server.lines.some((line) => line.id === 1)).toBe(true), {
			interval: 20,
			timeout: 10_000,
		})
		const reply = server.lines.find((line) => line.id === 1)
		await server.close()
		return reply
	})
}

/** The feed server against `recording`, its input left open, initialized. */
async function liveFeed(recording: { url: string }, env: string[] = []) {
	const dir = written(generateMcpServer(feed).files)
	const server = live([
		"env",
		`FEED_BASE_URL=${recording.url}`,
		...env,
		process.execPath,
		join(dir, "dist", "server.js"),
	])
	server.send(initialize("2025-11-25"))
	await server.seen((line) => line.id === 0)
	return server
}

describe("concurrent calls (phase e)", SLOW, () => {
	it("answers a second call while a collect is held open, each reply matched by its id", async () => {
		const order = await served([sse(events(1), "hold"), { json: { pong: true }, status: 200 }], async (recording) => {
			const server = await liveFeed(recording, ["FEED_TIMEOUT_MS=3000"])
			server.send(call(1, "feed_watch"))
			/* the latch: the collect's stream is open on the server before the second call goes */
			await vi.waitFor(() => expect(recording.streams[0]).toBeDefined(), { interval: 20, timeout: 10_000 })
			server.send(call(2, "ping_get"))
			const [ping, collect] = [await server.seen((line) => line.id === 2), await server.seen((line) => line.id === 1)]
			const ids = server.lines.map((line) => line.id)
			await server.close()
			return { collect: outcome(collect), ids, ping: outcome(ping) }
		})
		expect(order).toEqual({
			collect: { ended: "timeout", events: [{ data: "e1", id: "1" }], last_event_id: "1" },
			ids: [0, 2, 1],
			ping: { pong: true },
		})
	})

	it("keeps each of two collects' own open state: one opened and cut, one never opened", async () => {
		const outcomes = await served(
			[{ delayMs: 8_000, sse: { end: "close", steps: [] }, status: 200 }, sse(events(1), "hold")],
			async (recording) => {
				const server = await liveFeed(recording, ["FEED_TIMEOUT_MS=1500"])
				/* the never-opened collect first, then the one that opens: a hook shared between them would mark both */
				server.send(call(2, "feed_watch"))
				await vi.waitFor(() => expect(recording.hops.length).toBe(1), { interval: 20, timeout: 10_000 })
				server.send(call(1, "feed_watch"))
				const replies = [await server.seen((line) => line.id === 1), await server.seen((line) => line.id === 2)]
				await server.close()
				return replies.map(outcome)
			},
		)
		expect(outcomes).toEqual([
			{ ended: "timeout", events: [{ data: "e1", id: "1" }], last_event_id: "1" },
			{ isError: true, text: { kind: "timeout", message: "The stream did not open within the call's timeout" } },
		])
	})
})

describe("concurrent replies (phase e)", SLOW, () => {
	it("writes each of 50 concurrent replies whole on its own line, refusals settling in one tick among them", async () => {
		const big = "y".repeat(20_000)
		const ids = Array.from({ length: 50 }, (_, i) => i + 1)
		/* an odd id is refused before anything is sent: those settle together, so a split write would interleave */
		const refused = (id: number) => id % 2 === 1
		const replies = await served(
			ids.filter((id) => !refused(id)).map(() => ({ json: { big }, status: 200 })),
			async (recording) => {
				const server = await liveFeed(recording)
				server.send(ids.map((id) => JSON.stringify(call(id, "ping_get", refused(id) ? { extra: id } : {}))).join("\n"))
				/* every reply and initialize's: a split write leaves fewer whole lines, so this latch is bounded */
				await vi.waitFor(() => expect(server.lines.length).toBeGreaterThanOrEqual(ids.length + 1), {
					interval: 20,
					timeout: 10_000,
				})
				const answered = ids.map((id) => server.lines.find((line) => line.id === id) ?? { id, missing: true })
				const lines = server.lines.length
				const unparsed = server.lines.filter((line) => "unparsed" in line).length
				await server.close()
				return { answered, lines, unparsed }
			},
		)
		expect([
			replies.unparsed,
			replies.lines,
			replies.answered.map((reply) => [
				reply.id,
				refused(reply.id as number) || (outcome(reply) as { big?: string }).big === big,
			]),
		]).toEqual([0, 51, ids.map((id) => [id, true])])
	})
})

describe("the server's lifecycle (phase e)", SLOW, () => {
	it("exits 0 on SIGTERM mid-collect once the aborted collect settled, its late reply never written", async () => {
		const dir = written(generateMcpServer(feed).files)
		await served([sse(events(1), "hold")], async (server) => {
			const child = spawn(process.execPath, [join(dir, "dist", "server.js")], {
				/* a bound far past the latch below: only the abort can settle the collect */
				env: { ...process.env, FEED_BASE_URL: server.url, FEED_TIMEOUT_MS: "600000" },
				stdio: ["pipe", "pipe", "pipe"],
			})
			let out = ""
			let code: number | null | undefined
			child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()))
			const exited = new Promise<number | null>((settle) => child.once("close", settle)).then(
				(status) => (code = status),
			)
			child.stdin.write(`${JSON.stringify(initialize("2025-11-25"))}\n${JSON.stringify(call(1, "feed_watch"))}\n`)
			/* the latch: the collect's stream is open on the server */
			await vi.waitFor(() => expect(server.streams[0]).toBeDefined(), { interval: 20, timeout: 10_000 })
			child.kill("SIGTERM")
			await vi.waitFor(() => expect(code).not.toBeUndefined(), { interval: 20, timeout: 10_000 })
			const status = await exited
			/* the initialize reply only: the aborted collect's reply never written */
			expect([status, out.split("\n").filter(Boolean).length]).toEqual([0, 1])
			await vi.waitFor(() => expect(server.streams[0]?.clientGone).toBe(true), { interval: 20, timeout: 10_000 })
		})
	})
})
