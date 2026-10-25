/**
 * A resumable connection's headers per dial (bit 19 b2, sweep item 2): `headers` may be a function, read on every
 * dial, so a token the caller rotated after the open is the one a reconnect carries, as Rust's, Python's, C#'s and
 * Java's dials read theirs. A plain object is sent as it is on every dial.
 */
import { describe, expect, it } from "vitest"
import { emittedSdk } from "./__fixtures__/emitted.ts"

type Frame = { data: unknown; id: string; t: "msg" } | { reconnectToken: string; t: "ready" }
type Conn = {
	close(): void
	onClose: (reason: string) => void
	onError: (err: unknown) => void
	onFrame: (frame: Frame) => void
	send(data: string): void
}
type Opts = { headers?: Record<string, string>; lastEventId?: string; reconnectToken?: string }
type Adapter = { connect(url: string, opts: Opts): Conn }
type Resumable = AsyncIterable<unknown> & { close(): void }
type Headers = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>)
type Realtime = {
	createResumableConnection(opts: {
		headers?: Headers
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

/** A transport whose first dial sends one message then drops, and whose second sends one more; each dial's headers kept. */
function dropping(): { adapter: Adapter; seen: (Record<string, string> | undefined)[] } {
	const seen: (Record<string, string> | undefined)[] = []
	const adapter: Adapter = {
		connect(_url, opts) {
			const dial = seen.push(opts.headers)
			const conn: Conn = { close: () => {}, onClose: () => {}, onError: () => {}, onFrame: () => {}, send: () => {} }
			queueMicrotask(async () => {
				conn.onFrame({ reconnectToken: `rt-${dial}`, t: "ready" })
				await Promise.resolve()
				conn.onFrame({ data: dial, id: `${dial}`, t: "msg" })
				await Promise.resolve()
				if (dial === 1) conn.onClose("network")
			})
			return conn
		},
	}
	return { adapter, seen }
}

/** The first two values a connection with `headers` yields, the token rotated after the first, and each dial's headers. */
async function rotated(headers: (token: () => string) => Headers) {
	const { createResumableConnection } = (await emittedSdk(REALTIME)) as unknown as Realtime
	let token = "old"
	const { adapter, seen } = dropping()
	const connection = createResumableConnection({
		headers: headers(() => token),
		reconnectDelayMs: 1,
		transports: [adapter],
		url: "https://rt.example/feed",
	})
	const values: unknown[] = []
	for await (const value of connection) {
		values.push(value)
		token = "new"
		if (values.length === 2) break
	}
	connection.close()
	return { seen, values }
}

describe("a resumable connection's headers, read on every dial (bit 19 b2)", () => {
	it("reconnects with the token a headers function returns now, rotated after the open", async () => {
		expect(await rotated((token) => () => ({ authorization: `Bearer ${token()}` }))).toEqual({
			seen: [{ authorization: "Bearer old" }, { authorization: "Bearer new" }],
			values: [1, 2],
		})
	})

	it("awaits an async headers function on each dial", async () => {
		expect(await rotated((token) => async () => ({ authorization: `Bearer ${token()}` }))).toEqual({
			seen: [{ authorization: "Bearer old" }, { authorization: "Bearer new" }],
			values: [1, 2],
		})
	})

	it("sends a plain headers object as it is on every dial", async () => {
		expect(await rotated(() => ({ authorization: "Bearer fixed" }))).toEqual({
			seen: [{ authorization: "Bearer fixed" }, { authorization: "Bearer fixed" }],
			values: [1, 2],
		})
	})
})
