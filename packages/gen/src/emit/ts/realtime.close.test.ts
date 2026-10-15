/**
 * What a resumable connection leaves behind: `close()` clears every dial and reconnect timer and
 * closes a transport still being dialed, and a server refusing the open fails that dial at once.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { emittedSdk } from "./__fixtures__/emitted.ts"

type Frame = { reason: string; t: "bye" } | { reconnectToken: string; t: "ready" }
type Conn = {
	close(): void
	onClose: (reason: string) => void
	onError: (err: unknown) => void
	onFrame: (frame: Frame) => void
	send(data: string): void
}
type Adapter = { connect(url: string, opts: object): Conn }
type Resumable = AsyncIterable<unknown> & {
	close(): void
	readonly provenTransport: string | null
	readonly state: string
}
type Create = (opts: { transports: Adapter[]; url: string } & Record<string, unknown>) => Resumable

const DOC = { info: { title: "T", version: "1" }, openapi: "3.1.0", paths: {} }

/** The emitted `createResumableConnection`. */
async function create(): Promise<Create> {
	return (await emittedSdk(DOC)).createResumableConnection as Create
}

/** An adapter whose connections `script` drives once wired; `closed` counts the connections closed. */
function adapter(script: (conn: Conn) => void): { adapter: Adapter; closed: () => number } {
	let closed = 0
	return {
		adapter: {
			connect() {
				const conn: Conn = {
					close: () => void closed++,
					onClose: () => {},
					onError: () => {},
					onFrame: () => {},
					send: () => {},
				}
				queueMicrotask(() => script(conn))
				return conn
			},
		},
		closed: () => closed,
	}
}

/** Let queued microtasks and promise continuations run. */
const settle = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve()
}

afterEach(() => {
	vi.useRealTimers()
})

describe("createResumableConnection: close()", () => {
	it("clears the reconnect timer of a dropped connection waiting to redial", async () => {
		vi.useFakeTimers()
		const drops = adapter((conn) => {
			conn.onFrame({ reconnectToken: "t", t: "ready" })
			queueMicrotask(() => conn.onClose("gone"))
		})
		const connection = (await create())({ reconnectDelayMs: 60_000, transports: [drops.adapter], url: "wss://x" })
		void connection[Symbol.asyncIterator]().next()
		await settle()
		expect([connection.state, vi.getTimerCount()]).toEqual(["reconnecting", 1])
		connection.close()
		expect([connection.state, vi.getTimerCount()]).toEqual(["closed", 0])
	})

	it("clears the dial timeout and closes the transport still being dialed", async () => {
		vi.useFakeTimers()
		const silent = adapter(() => {})
		const connection = (await create())({ fallbackTimeout: 60_000, transports: [silent.adapter], url: "wss://x" })
		void connection[Symbol.asyncIterator]().next()
		await settle()
		expect(vi.getTimerCount()).toBe(1)
		connection.close()
		expect([vi.getTimerCount(), silent.closed()]).toEqual([0, 1])
	})
})

describe("createResumableConnection: a refused open", () => {
	it("fails the dial on a goodbye before ready, at once, and falls to the next transport", async () => {
		vi.useFakeTimers()
		const refusing = adapter((conn) => conn.onFrame({ reason: "full", t: "bye" }))
		const accepting = adapter((conn) => conn.onFrame({ reconnectToken: "t", t: "ready" }))
		const connection = (await create())({
			fallbackTimeout: 60_000,
			transports: [refusing.adapter, accepting.adapter],
			url: "wss://x",
		})
		void connection[Symbol.asyncIterator]().next()
		await settle()
		expect([connection.state, connection.provenTransport, refusing.closed(), vi.getTimerCount()]).toEqual([
			"connected",
			"sse",
			1,
			0,
		])
		connection.close()
	})
})
