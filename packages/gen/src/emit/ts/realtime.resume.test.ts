/**
 * A resumable connection never skips or repeats an event across a reconnect (bit 19 d1, sweep item 17). TS holds every
 * frame it received in its own queue until the consumer reads it, and that queue survives the reconnect, so the cursor
 * it resumes from (the last frame received) is never past an event the consumer will not get: the frame received but
 * unread when the socket drops is still delivered, and the server resends only what follows it. Pinned here, since a
 * cursor moved to the point of yield without dropping that queue would deliver the unread frame twice.
 */
import { describe, expect, it, vi } from "vitest"
import { emittedSdk } from "./__fixtures__/emitted.ts"

type Frame = { data: unknown; id: number; t: "msg" } | { reconnectToken: string; t: "ready" }
type Conn = {
	close(): void
	onClose: (reason: string) => void
	onError: (err: unknown) => void
	onFrame: (frame: Frame) => void
	send(data: string): void
}
type Opts = { lastId?: number; reconnectToken?: string }
type Adapter = { connect(url: string, opts: Opts): Conn }
type Realtime = {
	createResumableConnection(opts: {
		lastId?: number
		reconnectDelayMs?: number
		transports: Adapter[]
		url: string
	}): AsyncIterable<unknown> & { close(): void }
}

const REALTIME = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: { "/rt/feed": { get: { operationId: "rt.feed", responses: {}, "x-realtime": true } } },
}

/** Events 1 to 3, each frame's data its id; a server that resends every event after the cursor a dial hands it. */
const EVENTS = [1, 2, 3]

/** A transport whose first dial sends events 1 and 2 then drops; every later dial resends what follows its cursor. */
function resending(): { adapter: Adapter; cursors: (number | undefined)[] } {
	const cursors: (number | undefined)[] = []
	const adapter: Adapter = {
		connect(_url, opts) {
			const dial = cursors.push(opts.lastId)
			const conn: Conn = { close: () => {}, onClose: () => {}, onError: () => {}, onFrame: () => {}, send: () => {} }
			queueMicrotask(async () => {
				conn.onFrame({ reconnectToken: `rt-${dial}`, t: "ready" })
				const after = EVENTS.filter((id) => id > (opts.lastId ?? 0))
				for (const id of dial === 1 ? after.slice(0, 2) : after) {
					await Promise.resolve()
					conn.onFrame({ data: id, id, t: "msg" })
				}
				await Promise.resolve()
				if (dial === 1) conn.onClose("network")
			})
			return conn
		},
	}
	return { adapter, cursors }
}

describe("a resumable connection across a reconnect (bit 19 d1)", () => {
	it("delivers a frame received but unread at the drop once, and resumes after it: no event skipped or repeated", async () => {
		const { createResumableConnection } = (await emittedSdk(REALTIME)) as unknown as Realtime
		const { adapter, cursors } = resending()
		const connection = createResumableConnection({ reconnectDelayMs: 1, transports: [adapter], url: "https://rt/feed" })
		const iterator = connection[Symbol.asyncIterator]()
		const first = (await iterator.next()).value
		/* the latch: the reconnect has dialed, so event 2 was received and the socket dropped while it sat unread */
		await vi.waitFor(() => expect(cursors.length).toBe(2), { timeout: 5_000 })
		const rest = [(await iterator.next()).value, (await iterator.next()).value]
		connection.close()
		expect({ cursors, delivered: [first, ...rest] }).toEqual({ cursors: [undefined, 2], delivered: [1, 2, 3] })
	})
})
