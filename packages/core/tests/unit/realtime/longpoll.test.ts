import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"
import { createLongPollHandler } from "../../../src/realtime/longpoll.ts"
import type { LongPollHandlerOpts } from "../../../src/realtime/longpoll.ts"

/* ------------------------------------------------------------------ */
/*  Stub types matching the spec wire protocol                         */
/* ------------------------------------------------------------------ */

type ServerFrame =
	| { data: unknown; id: number; t: "msg" }
	| { t: "pong" }
	| { reason: string; t: "bye" }
	| { reconnectToken: string; t: "ready" }

type BufferEntry = { data: unknown; id: number }

/* ------------------------------------------------------------------ */
/*  Minimal mock factories                                             */
/* ------------------------------------------------------------------ */

function createMockBuffer(entries: Map<string, BufferEntry[]> = new Map()) {
	const store = entries
	const destroyed = new Set<string>()

	return {
		/* test helper to mark a token as expired (replay returns null) */
		_expire(token: string): void {
			store.delete(token)
			destroyed.add(token)
		},
		/* test helper to pre-seed a token */
		_seed(token: string, seedEntries: BufferEntry[]): void {
			store.set(token, seedEntries)
		},
		create(): string {
			const token = crypto.randomUUID()
			store.set(token, [])
			return token
		},
		destroy(token: string): void {
			store.delete(token)
			destroyed.add(token)
		},
		disconnect(_token: string): void {},
		push(token: string, data: unknown): number {
			const buf = store.get(token)
			if (!buf) throw new Error("Unknown token")
			const id = buf.length + 1
			buf.push({ data, id })
			return id
		},
		replay(token: string, lastId: number): BufferEntry[] | null {
			if (destroyed.has(token)) return null
			const buf = store.get(token)
			if (!buf) return null
			return buf.filter((e) => e.id > lastId)
		},
	}
}

type Subscriber = (frame: ServerFrame) => void

function createMockBus() {
	const subs = new Map<string, Set<Subscriber>>()
	const messageHandlers = new Map<string, (payload: unknown) => void>()

	return {
		/* test helper to emit a frame to a specific connection */
		_emit(token: string, frame: ServerFrame): void {
			this.publish(token, frame)
		},
		deliverMessage(token: string, payload: unknown): boolean {
			const handler = messageHandlers.get(token)
			if (!handler) return false
			handler(payload)
			return true
		},
		hasConnection(token: string): boolean {
			return subs.has(token) && (subs.get(token)?.size ?? 0) > 0
		},
		onMessage(token: string, handler: (payload: unknown) => void): void {
			messageHandlers.set(token, handler)
		},
		publish(token: string, frame: ServerFrame): void {
			const set = subs.get(token)
			if (set) {
				for (const cb of set) cb(frame)
			}
		},
		subscribe(token: string, cb: Subscriber): () => void {
			if (!subs.has(token)) subs.set(token, new Set())
			subs.get(token)?.add(cb)
			return () => {
				subs.get(token)?.delete(cb)
			}
		},
	}
}

function makeOpts(
	overrides: Partial<LongPollHandlerOpts> = {},
): LongPollHandlerOpts & { buffer: ReturnType<typeof createMockBuffer>; bus: ReturnType<typeof createMockBus> } {
	const bus = overrides.bus ?? createMockBus()
	const buffer = overrides.buffer ?? createMockBuffer()
	return {
		buffer: buffer as ReturnType<typeof createMockBuffer>,
		bus: bus as ReturnType<typeof createMockBus>,
		...overrides,
	} as LongPollHandlerOpts & { buffer: ReturnType<typeof createMockBuffer>; bus: ReturnType<typeof createMockBus> }
}

function pollRequest(params: Record<string, string> = {}, init?: RequestInit): Request {
	const url = new URL("http://localhost/realtime/chat")
	for (const [k, v] of Object.entries(params)) {
		url.searchParams.set(k, v)
	}
	return new Request(url.toString(), { method: "GET", ...init })
}

function sendRequest(body: Record<string, unknown>): Request {
	return new Request("http://localhost/realtime/chat/send", {
		body: JSON.stringify(body),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	})
}

async function parseJsonResponse<T = unknown>(res: Response): Promise<T> {
	return res.json() as Promise<T>
}

/* ------------------------------------------------------------------ */
/*  Poll handler — common cases                                        */
/* ------------------------------------------------------------------ */

describe("LongPollHandler.poll — common cases", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("returns empty array after timeout when no messages arrive", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const promise = handler.poll(pollRequest({ reconnectToken: token, wait: "1" }))

		vi.advanceTimersByTime(1_000)

		const res = await promise
		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toEqual([])
	})

	it("returns pending messages immediately as JSON array", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		opts.buffer.push(token, { kind: "chat", text: "hello" })
		opts.buffer.push(token, { kind: "chat", text: "world" })

		const handler = createLongPollHandler(opts)
		const res = await handler.poll(
			pollRequest({ lastId: "0", reconnectToken: token, wait: "25" }),
		)

		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toHaveLength(2)
		expect(body[0]).toEqual({ data: { kind: "chat", text: "hello" }, id: 1, t: "msg" })
		expect(body[1]).toEqual({ data: { kind: "chat", text: "world" }, id: 2, t: "msg" })
	})

	it("filters messages by lastId — only returns id > lastId", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		opts.buffer.push(token, "msg-1")
		opts.buffer.push(token, "msg-2")
		opts.buffer.push(token, "msg-3")

		const handler = createLongPollHandler(opts)
		const res = await handler.poll(
			pollRequest({ lastId: "2", reconnectToken: token, wait: "25" }),
		)

		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toHaveLength(1)
		expect(body[0]).toEqual({ data: "msg-3", id: 3, t: "msg" })
	})

	it("returns 404 for unknown reconnectToken", async () => {
		const opts = makeOpts()
		const handler = createLongPollHandler(opts)

		const res = await handler.poll(
			pollRequest({ lastId: "0", reconnectToken: "nonexistent-token", wait: "5" }),
		)

		expect(res.status).toBe(404)
	})

	it("responds immediately when messages arrive during wait", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const promise = handler.poll(
			pollRequest({ lastId: "0", reconnectToken: token, wait: "25" }),
		)

		/*
		 * Simulate a message arriving 500ms into the wait. The bus emits
		 * to the subscriber, which should resolve the poll immediately.
		 */
		setTimeout(() => {
			opts.buffer.push(token, "live-msg")
			opts.bus._emit(token, { data: "live-msg", id: 1, t: "msg" })
		}, 500)

		vi.advanceTimersByTime(500)

		const res = await promise
		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body.length).toBeGreaterThanOrEqual(1)
		expect(body.some((f) => f.t === "msg" && "data" in f && f.data === "live-msg")).toBe(true)
	})

	it("response has content-type application/json", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		opts.buffer.push(token, "x")

		const handler = createLongPollHandler(opts)
		const res = await handler.poll(
			pollRequest({ lastId: "0", reconnectToken: token, wait: "1" }),
		)

		expect(res.headers.get("content-type")).toContain("application/json")
	})
})

/* ------------------------------------------------------------------ */
/*  Poll handler — wait parameter behavior                             */
/* ------------------------------------------------------------------ */

describe("LongPollHandler.poll — wait parameter", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("respects wait parameter from query string", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const promise = handler.poll(
			pollRequest({ reconnectToken: token, wait: "3" }),
		)

		/* at 2s, should still be pending */
		vi.advanceTimersByTime(2_000)

		/* at 3s, should resolve */
		vi.advanceTimersByTime(1_000)

		const res = await promise
		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toEqual([])
	})

	it("caps wait at maxWait when provided value exceeds it", async () => {
		const opts = makeOpts({ maxWait: 10 })
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const promise = handler.poll(
			pollRequest({ reconnectToken: token, wait: "60" }),
		)

		/* should resolve at maxWait (10s), not at 60s */
		vi.advanceTimersByTime(10_000)

		const res = await promise
		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toEqual([])
	})

	it("defaults wait to 25 seconds when not specified", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const promise = handler.poll(
			pollRequest({ reconnectToken: token }),
		)

		/* at 24s, should still be pending — advance but don't resolve */
		vi.advanceTimersByTime(24_000)

		/* at 25s, should resolve */
		vi.advanceTimersByTime(1_000)

		const res = await promise
		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toEqual([])
	})

	it("maxWait defaults to 30 when not configured", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		/* request a wait of 100s — should be capped at 30 */
		const promise = handler.poll(
			pollRequest({ reconnectToken: token, wait: "100" }),
		)

		vi.advanceTimersByTime(30_000)

		const res = await promise
		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toEqual([])
	})

	it("custom defaultWait is used when wait param missing", async () => {
		const opts = makeOpts({ defaultWait: 5 })
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const promise = handler.poll(
			pollRequest({ reconnectToken: token }),
		)

		vi.advanceTimersByTime(5_000)

		const res = await promise
		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toEqual([])
	})
})

/* ------------------------------------------------------------------ */
/*  Send handler — common cases                                        */
/* ------------------------------------------------------------------ */

describe("LongPollHandler.send — common cases", () => {
	it("returns 200 for valid POST with reconnectToken + data", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()

		/* register a message handler so the token is "active" */
		opts.bus.onMessage(token, vi.fn<(payload: unknown) => void>())

		const handler = createLongPollHandler(opts)
		const res = await handler.send(
			sendRequest({ data: { text: "hi" }, reconnectToken: token }),
		)

		expect(res.status).toBe(200)
	})

	it("returns 404 for unknown reconnectToken", async () => {
		const opts = makeOpts()
		const handler = createLongPollHandler(opts)

		const res = await handler.send(
			sendRequest({ data: "hello", reconnectToken: "unknown-token" }),
		)

		expect(res.status).toBe(404)
	})

	it("returns 400 when body is missing reconnectToken", async () => {
		const opts = makeOpts()
		const handler = createLongPollHandler(opts)

		const res = await handler.send(
			sendRequest({ data: "hello" }),
		)

		expect(res.status).toBe(400)
	})

	it("returns 400 when body is missing data field", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const res = await handler.send(
			sendRequest({ reconnectToken: token }),
		)

		expect(res.status).toBe(400)
	})

	it("delivers message payload to connection message handler", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const messageHandler = vi.fn<(payload: unknown) => void>()
		opts.bus.onMessage(token, messageHandler)

		const handler = createLongPollHandler(opts)
		await handler.send(
			sendRequest({ data: { text: "hello from POST" }, reconnectToken: token }),
		)

		expect(messageHandler).toHaveBeenCalledOnce()
		expect(messageHandler).toHaveBeenCalledWith({ text: "hello from POST" })
	})
})

/* ------------------------------------------------------------------ */
/*  Resume semantics                                                   */
/* ------------------------------------------------------------------ */

describe("LongPollHandler.poll — resume semantics", () => {
	it("replays buffered messages on reconnect with valid token", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()

		/* push messages while "connected" */
		opts.buffer.push(token, "msg-1")
		opts.buffer.push(token, "msg-2")
		opts.buffer.push(token, "msg-3")

		/*
		 * Client disconnects and reconnects with lastId=1.
		 * Should get msg-2 and msg-3 replayed from buffer.
		 */
		const handler = createLongPollHandler(opts)
		const res = await handler.poll(
			pollRequest({ lastId: "1", reconnectToken: token, wait: "1" }),
		)

		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toHaveLength(2)
		expect(body[0]).toEqual({ data: "msg-2", id: 2, t: "msg" })
		expect(body[1]).toEqual({ data: "msg-3", id: 3, t: "msg" })
	})

	it("returns bye frame with reason server_restart for expired token", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		opts.buffer.push(token, "old-msg")

		/* expire the token to simulate server restart */
		opts.buffer._expire(token)

		const handler = createLongPollHandler(opts)
		const res = await handler.poll(
			pollRequest({ lastId: "0", reconnectToken: token, wait: "5" }),
		)

		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toHaveLength(1)
		expect(body[0]).toEqual({ reason: "server_restart", t: "bye" })
	})
})

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

describe("LongPollHandler.poll — edge cases", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("abort signal on request cancels the wait", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const controller = new AbortController()
		const promise = handler.poll(
			pollRequest({ reconnectToken: token, wait: "25" }, { signal: controller.signal }),
		)

		/* abort after 1s instead of waiting 25s */
		setTimeout(() => controller.abort(), 1_000)
		vi.advanceTimersByTime(1_000)

		const res = await promise
		/* aborted poll should return empty array or a specific response, not hang */
		expect(res.status).toBeLessThan(500)
	})

	it("handles multiple concurrent polls from same token gracefully", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const promise1 = handler.poll(
			pollRequest({ reconnectToken: token, wait: "5" }),
		)
		const promise2 = handler.poll(
			pollRequest({ reconnectToken: token, wait: "5" }),
		)

		vi.advanceTimersByTime(5_000)

		/*
		 * Both should resolve without error. Implementation may cancel
		 * the first poll (409) or let both timeout with empty arrays.
		 */
		const [res1, res2] = await Promise.all([promise1, promise2])
		expect(res1.status).toBeLessThan(500)
		expect(res2.status).toBeLessThan(500)
	})

	it("returns bye frame if server closes connection during wait", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const promise = handler.poll(
			pollRequest({ reconnectToken: token, wait: "25" }),
		)

		/* server pushes a bye frame during the wait */
		setTimeout(() => {
			opts.bus._emit(token, { reason: "kicked", t: "bye" })
		}, 500)

		vi.advanceTimersByTime(500)

		const res = await promise
		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body.some((f) => f.t === "bye" && f.reason === "kicked")).toBe(true)
	})

	it("poll with non-numeric wait falls back to default", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const promise = handler.poll(
			pollRequest({ reconnectToken: token, wait: "invalid" }),
		)

		/* default is 25s */
		vi.advanceTimersByTime(25_000)

		const res = await promise
		const body = await parseJsonResponse<ServerFrame[]>(res)
		expect(body).toEqual([])
	})

	it("poll with negative wait treats as 0 or clamps to minimum", async () => {
		const opts = makeOpts()
		const token = opts.buffer.create()
		const handler = createLongPollHandler(opts)

		const promise = handler.poll(
			pollRequest({ reconnectToken: token, wait: "-5" }),
		)

		/* should resolve nearly immediately */
		vi.advanceTimersByTime(0)

		const res = await promise
		expect(res.status).toBe(200)
	})

	it("poll without reconnectToken query param returns error", async () => {
		const opts = makeOpts()
		const handler = createLongPollHandler(opts)

		const res = await handler.poll(pollRequest({}))

		/* missing reconnectToken should be 400 (bad request) */
		expect(res.status).toBe(400)
	})

	it("send with malformed JSON body returns 400", async () => {
		const opts = makeOpts()
		const handler = createLongPollHandler(opts)

		const req = new Request("http://localhost/realtime/chat/send", {
			body: "not valid json{{{",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		})

		const res = await handler.send(req)
		expect(res.status).toBe(400)
	})

	it("send with empty body returns 400", async () => {
		const opts = makeOpts()
		const handler = createLongPollHandler(opts)

		const req = new Request("http://localhost/realtime/chat/send", {
			body: "",
			headers: { "Content-Type": "application/json" },
			method: "POST",
		})

		const res = await handler.send(req)
		expect(res.status).toBe(400)
	})
})

/* ------------------------------------------------------------------ */
/*  Type contracts                                                     */
/* ------------------------------------------------------------------ */

describe("LongPollHandler — type contracts", () => {
	it("createLongPollHandler returns object with poll and send methods", () => {
		const opts = makeOpts()
		const handler = createLongPollHandler(opts)

		expectTypeOf(handler.poll).toEqualTypeOf<(req: Request) => Promise<Response>>()
		expectTypeOf(handler.send).toEqualTypeOf<(req: Request) => Promise<Response>>()
	})

	it("createLongPollHandler accepts opts with optional defaultWait and maxWait", () => {
		expectTypeOf(createLongPollHandler).toBeCallableWith({
			buffer: createMockBuffer() as LongPollHandlerOpts["buffer"],
			bus: createMockBus() as LongPollHandlerOpts["bus"],
		})

		expectTypeOf(createLongPollHandler).toBeCallableWith({
			buffer: createMockBuffer() as LongPollHandlerOpts["buffer"],
			bus: createMockBus() as LongPollHandlerOpts["bus"],
			defaultWait: 10,
			maxWait: 30,
		})
	})

	it("LongPollHandlerOpts has correct shape", () => {
		expectTypeOf<LongPollHandlerOpts>().toHaveProperty("bus")
		expectTypeOf<LongPollHandlerOpts>().toHaveProperty("buffer")
		expectTypeOf<LongPollHandlerOpts>().toHaveProperty("defaultWait")
		expectTypeOf<LongPollHandlerOpts>().toHaveProperty("maxWait")
	})
})
