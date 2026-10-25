/**
 * A TS realtime operation over the full chain (bit 19 e2), as Go's newRealtime: the method returns a resumable
 * connection that dials WebSocket, then SSE, then long-poll, the SSE and long-poll dials through the client (its
 * headers, auth, hooks and log) and the WebSocket dial with no credential (the platform's WebSocket sends no header).
 * The cursor resumes from what was delivered; every transport refused ends it with the most specific refusal, a
 * WebSocket failing without a status ranked lowest; a 401 refreshes once per open and restarts the chain; a send
 * POSTs through the client. Driven against the recording server.
 */
import { describe, expect, it } from "vitest"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { emittedSdk } from "./__fixtures__/emitted.ts"

const DOC = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/feed": {
			get: {
				operationId: "rt.feed",
				responses: { 200: { content: { "text/event-stream": { schema: { type: "object" } } }, description: "" } },
				"x-realtime": true,
			},
		},
	},
}

type Connection = AsyncIterable<unknown> & {
	close(): void
	readonly provenTransport: string | null
	send(data: unknown): Promise<void>
}
type Sdk = { dispose(): void; rt: { feed(input?: object): Connection } }
type Run = { config?: object; input?: object; send?: unknown; take?: number }

/** event n of the feed: SSE id n, payload n with reconnect token rt-n */
const ev = (n: number) => `id: ${n}\ndata: {"n":${n},"reconnect_token":"rt-${n}"}\n\n`
const sse = (steps: string[], end: "drop" | "hold"): Reply => ({ sse: { end, steps }, status: 200 })
const status = (code: number): Reply => ({ json: { error_key: `s${code}`, message: "no" }, status: code })

/** A hop as `<transport> <url> <authorization>`: an upgrade, an event stream, a POST, else a poll. */
function dialOf(hop: RecordedHop): string {
	const kind = hop.headers.upgrade
		? "ws"
		: hop.method === "POST"
			? "post"
			: hop.headers.accept === "text/event-stream"
				? "sse"
				: "poll"
	const cursor = hop.headers["last-event-id"] === undefined ? "" : ` #${hop.headers["last-event-id"]}`
	return `${kind} ${hop.url}${cursor} ${hop.headers.authorization ?? "-"}`
}

/** How `connection`'s first `take` values ended: open, its error's status, or `"stalled"` past a 5 s latch for "never". */
async function read(connection: Connection, values: unknown[], run: Run): Promise<unknown> {
	const reading = (async () => {
		for await (const value of connection) {
			values.push(value)
			if (run.send !== undefined && values.length === 1) await connection.send(run.send)
			if (values.length === (run.take ?? 1)) return "open"
		}
		return "ended"
	})().catch((err: Error & { status?: number }) => err.status ?? err.message)
	let latch: ReturnType<typeof setTimeout> | undefined
	const stalled = new Promise<string>((resolve) => (latch = setTimeout(() => resolve("stalled"), 5_000)))
	try {
		return await Promise.race([reading, stalled])
	} finally {
		clearTimeout(latch)
	}
}

/** `take` values off `rt.feed` over `replies`, then how it ended, the transport it proved and every dial. */
async function feed(replies: Reply[], run: Run = {}) {
	const { TestSDK } = (await emittedSdk(DOC)) as unknown as { TestSDK: new (config: object) => Sdk }
	return served(replies, async (server) => {
		const sdk = new TestSDK({ baseURL: server.url, ...run.config })
		const connection = sdk.rt.feed({ reconnectDelayMs: 1, ...run.input })
		const values: unknown[] = []
		const ended = await read(connection, values, run)
		const proven = connection.provenTransport
		connection.close()
		sdk.dispose()
		return { dials: server.hops.map(dialOf), ended, proven, values }
	})
}

describe("a TS realtime operation dials WebSocket, then SSE, then long-poll (bit 19 e2)", () => {
	it("resumes on SSE from the delivered cursor after a drop, the WebSocket refused without a status", async () => {
		const replies = [status(404), sse([ev(1)], "drop"), status(404), sse([ev(2)], "hold")]
		expect(await feed(replies, { take: 2 })).toEqual({
			dials: [
				"ws /feed -",
				"sse /feed -",
				"ws /feed?reconnect_token=rt-1&last_event_id=1 -",
				"sse /feed?reconnect_token=rt-1 #1 -",
			],
			ended: "open",
			proven: "sse",
			values: [
				{ n: 1, reconnect_token: "rt-1" },
				{ n: 2, reconnect_token: "rt-2" },
			],
		})
	})

	it("polls when WebSocket and SSE refuse, the cursor in the query; a 204 polls again", async () => {
		const polled = (n: number) => ({ json: { id: `${n}`, n, reconnect_token: `rt-${n}` }, status: 200 })
		const replies = [status(404), status(404), polled(7), { status: 204 }, polled(8)]
		expect(await feed(replies, { input: { lastEventId: "6", reconnectToken: "rt-6" }, take: 2 })).toEqual({
			dials: [
				"ws /feed?reconnect_token=rt-6&last_event_id=6 -",
				"sse /feed?reconnect_token=rt-6 #6 -",
				"poll /feed?reconnect_token=rt-6&last_event_id=6 -",
				"poll /feed?reconnect_token=rt-7&last_event_id=7 -",
				"poll /feed?reconnect_token=rt-7&last_event_id=7 -",
			],
			ended: "open",
			proven: "longpoll",
			values: [
				{ id: "7", n: 7, reconnect_token: "rt-7" },
				{ id: "8", n: 8, reconnect_token: "rt-8" },
			],
		})
	})

	it("ends when every transport refused, with the most specific refusal; a transient failure among them retries", async () => {
		const refused = await feed([status(403), status(403), status(410)])
		const mixed = await feed([status(404), status(503), status(503), status(404), sse([ev(1)], "hold")])
		expect({ mixed: [mixed.dials.length, mixed.values], refused }).toEqual({
			mixed: [5, [{ n: 1, reconnect_token: "rt-1" }]],
			refused: { dials: ["ws /feed -", "sse /feed -", "poll /feed -"], ended: 403, proven: null, values: [] },
		})
	})
})

describe("a TS realtime operation's 401 refreshes once per open, and its send and log (bit 19 e2)", () => {
	/** a connection whose client sends `Bearer old` and refreshes to `new` through onAuthExpired, counting each call */
	const refreshing = () => {
		const calls: unknown[] = []
		const config = { headers: { authorization: "Bearer old" }, onAuthExpired: async () => (calls.push(1), "new") }
		return { calls, config }
	}

	it("refreshes once on a 401 and restarts the chain with the new token; a second 401 in that open is a refusal", async () => {
		const once = refreshing()
		const twice = refreshing()
		const ok = await feed([status(404), status(401), status(404), sse([ev(1)], "hold")], { config: once.config })
		const refused = await feed([status(404), status(401), status(404), status(401), status(404)], {
			config: twice.config,
		})
		expect({ calls: [once.calls.length, twice.calls.length], ok, refused: [refused.dials, refused.ended] }).toEqual({
			calls: [1, 1],
			ok: {
				dials: ["ws /feed -", "sse /feed Bearer old", "ws /feed -", "sse /feed Bearer new"],
				ended: "open",
				proven: "sse",
				values: [{ n: 1, reconnect_token: "rt-1" }],
			},
			refused: [
				["ws /feed -", "sse /feed Bearer old", "ws /feed -", "sse /feed Bearer new", "poll /feed Bearer new"],
				401,
			],
		})
	})

	it("POSTs a send through the client on SSE, its auth on it", async () => {
		const replies = [status(404), sse([ev(1)], "hold"), { json: {}, status: 202 }]
		const run = await feed(replies, { config: { headers: { authorization: "Bearer k" } }, send: { hi: 1 } })
		expect(run.dials).toEqual(["ws /feed -", "sse /feed Bearer k", "post /feed Bearer k"])
	})

	it("never logs the resume cursor the server issued", async () => {
		const entries: unknown[] = []
		const config = { onLog: (entry: unknown) => entries.push(entry) }
		const replies = [status(404), sse([ev(1)], "drop"), status(404), sse([ev(2)], "hold")]
		const run = await feed(replies, { config, input: { reconnectToken: "rt-secret" }, take: 2 })
		expect([run.values.length, entries.length > 0, JSON.stringify(entries).match(/rt-secret|rt-1/g)]).toEqual([
			2,
			true,
			null,
		])
	})
})

describe("the realtime refresh is no part of the TS SDK's surface (bit 19 e2)", () => {
	it("exports no refreshAuth, and the HTTPClient carries none", async () => {
		const sdk = await emittedSdk(DOC)
		const Http = sdk.HTTPClient as new (config: object) => object
		const client = new Http({ baseURL: "https://api.test" })
		const types = Object.entries(sdk.files)
			.filter(([name]) => name.endsWith(".index.gen.ts") || name.endsWith(".types.gen.ts"))
			.map(([, text]) => text)
		expect({
			exported: Object.keys(sdk).filter((key) => /refresh/i.test(key)),
			member: "refreshAuth" in client || "refreshAuth" in Http,
			typed: types.some((text) => /refreshAuth/.test(text)),
		}).toEqual({ exported: [], member: false, typed: false })
	})
})
