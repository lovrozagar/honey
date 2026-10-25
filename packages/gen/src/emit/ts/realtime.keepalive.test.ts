/**
 * A resumable connection's keepalive (bit 19 d1, sweep item 26): over WebSocket it pings every `keepaliveInterval` ms
 * (20 s by default, C#'s and Java's interval; it was off unless set) and reconnects when a ping goes unanswered as long
 * as the interval, so a peer gone dead behind a live connection is left within about twice it. An event stream gets no
 * keepalive unless one is set: a quiet stream is no dead one. `keepaliveInterval: 0` turns it off. On fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { emittedSdk } from "./__fixtures__/emitted.ts"

type Frame = { data: unknown; id: number; t: "msg" } | { reconnectToken: string; t: "ready" }
type Conn = {
	close(): void
	onClose: (reason: string) => void
	onError: (err: unknown) => void
	onFrame: (frame: Frame) => void
	send(data: string): void
}
type Adapter = { connect(url: string, opts: object): Conn }
type Resumable = AsyncIterable<unknown> & { close(): void; readonly provenTransport: string | null }
type Realtime = {
	createResumableConnection(opts: {
		keepaliveInterval?: number
		reconnectDelayMs?: number
		transports: Adapter[]
		url: string
	}): Resumable
}

const REALTIME = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: { "/rt/feed": { get: { operationId: "rt.feed", responses: {}, "x-realtime": true } } },
}

/** A transport each dial of which is ready, sends one message and never answers a ping; what each dial sent, kept. */
function silent(): { adapter: Adapter; sent: string[][] } {
	const sent: string[][] = []
	const adapter: Adapter = {
		connect() {
			const mine: string[] = []
			const dial = sent.push(mine)
			const conn: Conn = {
				close: () => {},
				onClose: () => {},
				onError: () => {},
				onFrame: () => {},
				send: (data) => void mine.push(data),
			}
			queueMicrotask(() => {
				conn.onFrame({ reconnectToken: `rt-${dial}`, t: "ready" })
				conn.onFrame({ data: dial, id: dial, t: "msg" })
			})
			return conn
		},
	}
	return { adapter, sent }
}

/** A transport that refuses every dial: the chain's next one is tried. */
const refusing: Adapter = {
	connect() {
		const conn: Conn = { close: () => {}, onClose: () => {}, onError: () => {}, onFrame: () => {}, send: () => {} }
		queueMicrotask(() => conn.onError(new Error("refused")))
		return conn
	},
}

/** A connection over `transports` with `keepaliveInterval`, its first value read; the time then advanced by `ms`. */
async function opened(transports: Adapter[], ms: number, keepaliveInterval?: number) {
	const { createResumableConnection } = (await emittedSdk(REALTIME)) as unknown as Realtime
	const connection = createResumableConnection({
		...(keepaliveInterval === undefined ? {} : { keepaliveInterval }),
		reconnectDelayMs: 1,
		transports,
		url: "https://rt.example/feed",
	})
	const iterator = connection[Symbol.asyncIterator]()
	await iterator.next()
	await vi.advanceTimersByTimeAsync(ms)
	connection.close()
	return connection
}

const PING = '{"t":"ping"}'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

describe("a resumable connection's keepalive (bit 19 d1)", () => {
	it("pings a WebSocket every 20 s by default", async () => {
		const { adapter, sent } = silent()
		await opened([adapter], 20_000)
		expect(sent[0]).toEqual([PING])
	})

	it("reconnects when a ping goes unanswered for the interval, within twice it", async () => {
		const { adapter, sent } = silent()
		await opened([adapter], 210, 100)
		expect(sent.length).toBe(2)
	})

	it("keeps a pong-less WebSocket under the interval", async () => {
		const { adapter, sent } = silent()
		await opened([adapter], 150, 100)
		expect(sent).toEqual([[PING]])
	})

	it("pings nothing at keepaliveInterval 0", async () => {
		const { adapter, sent } = silent()
		await opened([adapter], 60_000, 0)
		expect(sent).toEqual([[]])
	})

	it("gives an event stream no keepalive unless one is set: a quiet stream stays", async () => {
		const { adapter, sent } = silent()
		const connection = await opened([refusing, adapter], 120_000)
		expect([connection.provenTransport, sent]).toEqual(["sse", [[]]])
	})
})
