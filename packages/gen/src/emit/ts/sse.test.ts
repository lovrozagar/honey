import { afterEach, describe, expect, it, vi } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, any>
type Event = { data: string; event?: string; id?: string; retry?: number }

const BASE = "https://api.test"
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SSE = { 200: { content: { "text/event-stream": { schema: { type: "string" } } }, description: "" } }
const OK = { 200: { content: { "application/json": { schema: {} } }, description: "" } }
const STREAMS = {
	info: { title: "T", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/channels/{channel}/events": {
			get: {
				operationId: "channels.events",
				parameters: [{ in: "path", name: "channel", required: true, schema: { type: "string" } }],
				responses: SSE,
			},
		},
		"/chat": {
			post: {
				operationId: "chat",
				requestBody: { content: { "application/json": { schema: { type: "object" } } }, required: true },
				responses: SSE,
			},
		},
		"/events": { get: { operationId: "events.stream", responses: SSE } },
		"/feed": { get: { operationId: "feed.get", responses: OK } },
		"/feed/live": { get: { operationId: "feed.live", responses: SSE, "x-invalidate": ["GET /feed"] } },
	},
}

/** The kitchen app's `/api/events` on the wire, as core's `ctx.res.sse()` frames it. */
const KITCHEN_EVENTS = "event: message\ndata: hello\nid: 1\n\nevent: message\ndata: world\nid: 2\n\n"
const KITCHEN_PARSED = [
	{ data: "hello", event: "message", id: "1" },
	{ data: "world", event: "message", id: "2" },
]

/** An event-stream response of `chunks`; open ones never close, and a `signal` abort errors the body. */
function eventStream(chunks: string[], opts: { onCancel?: () => void; open?: boolean; signal?: AbortSignal } = {}) {
	const encoder = new TextEncoder()
	const body = new ReadableStream<Uint8Array>({
		cancel: opts.onCancel,
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
			opts.signal?.addEventListener("abort", () => controller.error(opts.signal?.reason), { once: true })
			if (!opts.open) controller.close()
		},
	})
	return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

/** A scripted fetch answering as the kitchen app: `/api/events`, and `/api/events-live` honoring `Last-Event-ID`. */
function kitchen() {
	return recordingFetch((request) => {
		if (new URL(request.url).pathname === "/api/events") return eventStream([KITCHEN_EVENTS])
		const from = request.headers.get("last-event-id")
		const resume = from ? [`event: resume\ndata: resumed from ${from}\n\n`] : []
		return eventStream(["retry: 3000\n\n", ...resume, "event: tick\ndata: live\nid: t1\n\n", ": heartbeat\n\n"])
	})
}

/** Every event of `iterable`. */
async function collect(iterable: AsyncIterable<Event>): Promise<Event[]> {
	const events: Event[] = []
	for await (const event of iterable) events.push(event)
	return events
}

/** The emitted `TestSDK` over STREAMS, built with `config` against BASE. */
async function sdkFor(config: Json): Promise<any> {
	const { TestSDK } = await emittedSdk(STREAMS)
	return new (TestSDK as new (config: Json) => unknown)({ baseURL: BASE, ...config })
}

/** The emitted app front's client, built with `config` against BASE. */
async function appFor(config: Json): Promise<any> {
	const { createClient } = await emittedApp()
	return (createClient as (config: Json) => unknown)({ baseURL: BASE, ...config })
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("SDK SSE call: what it yields", () => {
	// v0: 2dd42d4e1d
	it("yields the response's events with their data in order", async () => {
		const { fetch } = recordingFetch(() =>
			eventStream(["event: message\ndata: hello\n\nevent: message\ndata: world\n\n"]),
		)
		const events = await collect((await sdkFor({ fetch })).events.stream())
		expect(events.map((e) => e.data)).toEqual(["hello", "world"])
	})

	// v0: c448109549
	it("reassembles events split across 6-byte chunks into two events in order", async () => {
		const text = "data: hello\n\ndata: world\n\n"
		const chunks = Array.from({ length: Math.ceil(text.length / 6) }, (_, i) => text.slice(i * 6, i * 6 + 6))
		const { fetch } = recordingFetch(() => eventStream(chunks))
		expect(await collect((await sdkFor({ fetch })).events.stream({}))).toEqual([{ data: "hello" }, { data: "world" }])
	})

	// v0: 11410bbf49
	it("iterates a real app's events in order with event, data and id (client half of a C5 live-server case)", async () => {
		const wire = "event: msg\ndata: hello\nid: 1\n\nevent: msg\ndata: world\nid: 2\n\n"
		const { fetch } = recordingFetch(() => eventStream([wire]))
		expect(await collect((await sdkFor({ fetch })).events.stream())).toEqual([
			{ data: "hello", event: "msg", id: "1" },
			{ data: "world", event: "msg", id: "2" },
		])
	})

	// v0: 2dd02e57a0
	/* bit 19 d2: the cap is sseMaxEventBytes, in UTF-8 bytes (it was sseMaxBufferChars, in characters) */
	it("config sseMaxEventBytes bounds an event: past it the iterator throws", async () => {
		const { fetch } = recordingFetch(() => eventStream(["data: short\n\n", `data: ${"x".repeat(100)}\n\n`]))
		const sdk = await sdkFor({ fetch, sseMaxEventBytes: 64 })
		const seen: string[] = []
		const read = async () => {
			for await (const event of sdk.events.stream() as AsyncIterable<Event>) seen.push(event.data)
		}
		await expect(read()).rejects.toThrow()
		expect(seen).toEqual(["short"])
	})
})

describe("SDK SSE call: the request it sends", () => {
	// v0: 0b850c9cc8
	// v0: 2e5476feda
	it("carries an auto UUIDv4 x-request-id on the SDK and the app front", async () => {
		const sdk = recordingFetch(() => eventStream(["event: tick\ndata: {}\n\n"]))
		const app = recordingFetch(() => eventStream(["data: hi\n\n"]))
		const events = await collect((await sdkFor({ fetch: sdk.fetch })).events.stream())
		const appEvents = await collect((await appFor({ fetch: app.fetch })).get("/events"))
		const ids = [sdk.calls[0], app.calls[0]].map((r) => UUID_V4.test(r?.headers.get("x-request-id") ?? ""))
		expect([events.length, appEvents.length, ids]).toEqual([1, 1, [true, true]])
	})

	// v0: 6dbf399a5c
	// v0: bfa1430f64
	it("sends lastEventId as the Last-Event-ID header on the SDK and the app front", async () => {
		const sdk = recordingFetch(() => eventStream(["event: resume\ndata: ok\n\n"]))
		const app = recordingFetch(() => eventStream(["event: resume\ndata: ok\n\n"]))
		await collect((await sdkFor({ fetch: sdk.fetch })).events.stream({ lastEventId: "evt-5" }))
		await collect((await appFor({ fetch: app.fetch })).get("/events", { lastEventId: "evt-5" }))
		expect([sdk.calls[0]?.headers.get("last-event-id"), app.calls[0]?.headers.get("last-event-id")]).toEqual([
			"evt-5",
			"evt-5",
		])
	})

	// v0: 1900be55b5
	it("sends the input's cookies in the Cookie header", async () => {
		const { calls, fetch } = recordingFetch(() => eventStream(["data: a\n\n"]))
		const iterator = (await sdkFor({ fetch })).events.stream({ cookies: { session: "abc" } })[Symbol.asyncIterator]()
		await iterator.next()
		await iterator.return?.()
		expect(calls[0]?.headers.get("cookie")).toContain("session=abc")
	})

	// v0: 5d1afb56bf
	it("interpolates a {channel} path param into the request URL", async () => {
		const { calls, fetch } = recordingFetch(() => eventStream(["data: a\n\n"]))
		await collect((await sdkFor({ fetch })).channels.events({ params: { channel: "a b" } }))
		expect([calls[0]?.method, calls[0]?.url]).toEqual(["GET", `${BASE}/channels/a%20b/events`])
	})
})

describe("SDK SSE call: hooks and body", () => {
	// v0: 662e95ee14
	// v0: 2ddd3d861d
	it("runs onRequest and onResponse hooks around a GET stream", async () => {
		const seen: string[] = []
		const { calls, fetch } = recordingFetch(() => eventStream(["data: a\n\n"]))
		const sdk = await sdkFor({
			fetch,
			onRequest: [(ctx: Json) => void (seen.push("request"), ctx.headers.set("x-hook", "1"))],
			onResponse: [(ctx: Json) => void seen.push(`response ${ctx.response.headers.get("content-type")}`)],
		})
		const events = await collect(sdk.events.stream())
		expect([events, seen, calls[0]?.headers.get("x-hook")]).toEqual([
			[{ data: "a" }],
			["request", "response text/event-stream"],
			"1",
		])
	})

	// v0: 2e6b22b0c4
	it("a POST stream op sends its JSON body and content type and runs onRequest and onResponse", async () => {
		const seen: string[] = []
		const { calls, fetch } = recordingFetch(() => eventStream(["data: hi\n\n"]))
		const sdk = await sdkFor({
			fetch,
			onRequest: [(ctx: Json) => void ctx.headers.set("authorization", "Bearer t")],
			onResponse: [() => void seen.push("response")],
		})
		const events = await collect(sdk.chat({ json: { q: "hello" } }))
		const sent = calls[0] as Request
		expect([events, sent.method, await sent.text(), sent.headers.get("content-type")]).toEqual([
			[{ data: "hi" }],
			"POST",
			'{"q":"hello"}',
			"application/json",
		])
		expect([sent.headers.get("authorization"), sent.headers.get("accept"), seen]).toEqual([
			"Bearer t",
			"text/event-stream",
			["response"],
		])
	})

	// v0: 890bba3563
	it("uses the globalThis-bound default fetch when config.fetch is omitted", async () => {
		vi.stubGlobal("fetch", function methodFetch(this: unknown) {
			if (this !== globalThis) throw new TypeError("Illegal invocation")
			return Promise.resolve(eventStream(["event: message\ndata: hi\n\n"]))
		})
		expect(await collect((await sdkFor({})).events.stream())).toEqual([{ data: "hi", event: "message" }])
	})
})

describe("SDK SSE call: failure, abort and timers", () => {
	// v0: e28af4e2c1
	it("a non-ok response rejects the iteration with a ClientError; the safe call resolves it as an Err", async () => {
		const { NotFoundError } = await emittedSdk(STREAMS)
		const { fetch } = recordingFetch(() => Response.json({ message: "nope" }, { status: 404 }))
		const sdk = await sdkFor({ fetch })
		const failure = collect(sdk.events.stream())
		await expect(failure).rejects.toSatisfy((e) => e instanceof (NotFoundError as any) && (e as any).status === 404)
		const opened = await sdk.safe.events.stream()
		expect([
			opened.ok,
			opened.error instanceof (NotFoundError as any),
			opened.error?.status,
			opened.error?.body,
			opened.response.status,
		]).toEqual([false, true, 404, { message: "nope" }, 404])
	})

	it("the safe call resolves Ok once the stream opens, its data the events", async () => {
		const { fetch } = recordingFetch(() => eventStream(["data: a\n\n", "data: b\n\n"]))
		const opened = await (await sdkFor({ fetch })).safe.events.stream()
		expect([opened.ok, opened.response.status, await collect(opened.data)]).toEqual([
			true,
			200,
			[{ data: "a" }, { data: "b" }],
		])
	})

	// v0: e0fe80d231
	it("aborting the signal ends the iteration through fetch and leaves no abort listener behind", async () => {
		const ctrl = new AbortController()
		const add = vi.spyOn(ctrl.signal, "addEventListener")
		const remove = vi.spyOn(ctrl.signal, "removeEventListener")
		const { calls, fetch } = recordingFetch((r) => eventStream(["data: a\n\n"], { open: true, signal: r.signal }))
		const iterator = (await sdkFor({ fetch })).events.stream({ signal: ctrl.signal })[Symbol.asyncIterator]()
		const first = await iterator.next()
		const reason = new Error("stop")
		ctrl.abort(reason)
		await expect(iterator.next()).rejects.toBe(reason)
		const open = add.mock.calls.length - remove.mock.calls.length
		expect([first.value, calls[0]?.signal.aborted, open]).toEqual([{ data: "a" }, true, 0])
	})

	// v0: f06250a5fe
	/* bit 19 b2: config.timeout bounds the open up to the headers; the timer is cleared before any event */
	it("clears config.timeout's timer once a stream's headers arrive, so the stream itself is never cut", async () => {
		const set = vi.spyOn(globalThis, "setTimeout")
		const cleared = vi.spyOn(globalThis, "clearTimeout")
		const { fetch } = recordingFetch(() => eventStream(["data: hello\n\n"], { open: true }))
		const iterator = (await sdkFor({ fetch, timeout: 30_000 })).events.stream({})[Symbol.asyncIterator]()
		const first = await iterator.next()
		const timers = set.mock.results.filter((_, i) => set.mock.calls[i]?.[1] === 30_000).map((r) => r.value)
		const clearedBeforeEnd = timers.every((timer) => cleared.mock.calls.some(([id]) => id === timer))
		await iterator.return?.()
		expect([first.value, timers.length, clearedBeforeEnd]).toEqual([{ data: "hello" }, 1, true])
	})
})

describe("SDK SSE call: x-invalidate", () => {
	// v0: d68153af0b
	it("marks its x-invalidate targets stale once the stream response is ok, not on a failure", async () => {
		let live = 0
		const { fetch } = recordingFetch((request) => {
			if (new URL(request.url).pathname === "/feed") return Response.json({})
			return live++ === 0 ? Response.json({}, { status: 500 }) : eventStream(["data: x\n\n"])
		})
		const stale: unknown[] = []
		const sdk = await sdkFor({
			fetch,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx: Json) => void (ctx.url.endsWith("/feed") && stale.push(ctx.isStale))],
		})
		await sdk.feed.get()
		await expect(collect(sdk.feed.live())).rejects.toBeDefined()
		await sdk.feed.get()
		await collect(sdk.feed.live())
		await sdk.feed.get()
		expect(stale).toEqual([false, false, true])
	})
})

describe("app front stream call: the kitchen app's events", () => {
	// v0: 55321e8014
	// v0: 3e5728f686
	// v0: 4d8126e7fe
	it("for-await yields the server's events with string data, event and id, in order", async () => {
		const events = await collect((await appFor({ fetch: kitchen().fetch })).get("/api/events"))
		expect(events).toEqual(KITCHEN_PARSED)
	})

	// v0: c20b26c962
	it("a live stream yields its tick event with data and id, past the retry directive and heartbeats", async () => {
		const events = await collect((await appFor({ fetch: kitchen().fetch })).get("/api/events-live"))
		expect([events.map((e) => e.event), events[0]]).toEqual([
			["tick"],
			expect.objectContaining({ data: "live", id: "t1" }),
		])
	})

	// v0: 6b06bf8f90
	it("resumes with Last-Event-ID against a scripted server that honors it (client half of a C5 live-server case)", async () => {
		const { calls, fetch } = kitchen()
		const events = await collect((await appFor({ fetch })).get("/api/events-live", { lastEventId: "prev-5" }))
		expect([calls[0]?.headers.get("last-event-id"), events.map((e) => [e.event, e.data])]).toEqual([
			"prev-5",
			[
				["resume", "resumed from prev-5"],
				["tick", "live"],
			],
		])
	})

	// v0: b5d9c80ffd
	it("two calls in sequence are independent fresh streams", async () => {
		const { calls, fetch } = kitchen()
		const api = await appFor({ fetch })
		const first = await collect(api.get("/api/events"))
		const second = await collect(api.get("/api/events"))
		expect([first, second, calls.length]).toEqual([KITCHEN_PARSED, KITCHEN_PARSED, 2])
	})
})

describe("app front stream call: lifetime", () => {
	// v0: 192a6c5edd
	it("breaking out of for-await after the first event cancels the open stream", async () => {
		let cancelled = false
		const { fetch } = recordingFetch(() =>
			eventStream([KITCHEN_EVENTS], { onCancel: () => void (cancelled = true), open: true }),
		)
		const events: Event[] = []
		for await (const event of (await appFor({ fetch })).get("/api/events") as AsyncIterable<Event>) {
			events.push(event)
			break
		}
		expect([events, cancelled]).toEqual([[KITCHEN_PARSED[0]], true])
	})

	// v0: d6e04bba8e
	it("a config timeout shorter than the stream does not cut it", async () => {
		const { fetch } = recordingFetch(() => {
			const encoder = new TextEncoder()
			const body = new ReadableStream<Uint8Array>({
				async start(controller) {
					controller.enqueue(encoder.encode("data: hello\n\n"))
					await new Promise((resolve) => setTimeout(resolve, 120))
					controller.enqueue(encoder.encode("data: world\n\n"))
					controller.close()
				},
			})
			return new Response(body, { headers: { "content-type": "text/event-stream" } })
		})
		const events = await collect((await appFor({ fetch, timeout: 50 })).get("/api/events"))
		expect(events).toEqual([{ data: "hello" }, { data: "world" }])
	})

	// v0: ca636f0714
	it("iterating a call issues exactly one request", async () => {
		const { calls, fetch } = recordingFetch(() => eventStream(["data: hello\n\n"]))
		const iterator = (await appFor({ fetch })).get("/test")[Symbol.asyncIterator]()
		await iterator.next()
		for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve))
		await iterator.return?.()
		expect(calls).toHaveLength(1)
	})
})

describe("app front stream call: await and POST", () => {
	// v0: b5e669647d
	it("awaiting the call resolves to an iterable on an unclosed stream instead of buffering it", async () => {
		const { calls, fetch } = recordingFetch(() => eventStream(["data: a\n\n"], { open: true }))
		const stream = (await (await appFor({ fetch, timeout: 50 })).get("/events")) as AsyncIterable<Event>
		const seen: string[] = []
		for await (const event of stream) {
			seen.push(event.data)
			break
		}
		expect([seen, calls.length]).toEqual([["a"], 1])
	})

	// v0: 77f4223bf6
	it("await then for-await on one call reuses the single request", async () => {
		const { calls, fetch } = recordingFetch(() => eventStream(["data: a\n\ndata: b\n\n"]))
		const call = (await appFor({ fetch })).get("/events")
		await call
		const events = await collect(call)
		expect([events.map((e) => e.data), calls.length]).toEqual([["a", "b"], 1])
	})

	// v0: 7ed5eb1f5d
	it("a streamed POST carries its JSON body and Accept text/event-stream and runs onRequest and onResponse", async () => {
		const seen: string[] = []
		const { calls, fetch } = recordingFetch(() => eventStream(["data: 1\n\n"]))
		const api = await appFor({
			fetch,
			onRequest: [(ctx: Json) => void ctx.headers.set("authorization", "Bearer hook")],
			onResponse: [(ctx: Json) => void seen.push(ctx.response.headers.get("content-type") ?? "")],
		})
		const events = await collect(api.post("/chat", { json: { q: "hi" } }))
		const sent = calls[0] as Request
		expect([events.map((e) => e.data), await sent.text(), sent.headers.get("authorization")]).toEqual([
			["1"],
			'{"q":"hi"}',
			"Bearer hook",
		])
		expect([sent.headers.get("accept"), seen]).toEqual(["text/event-stream", ["text/event-stream"]])
	})
})

describe("JSON events (C1): a declared non-string event schema", () => {
	const JSON_EVENTS = {
		info: { title: "T", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/ticks": {
				get: {
					operationId: "ticks",
					responses: {
						200: {
							content: { "text/event-stream": { schema: { properties: { n: { type: "number" } }, type: "object" } } },
							description: "",
						},
					},
				},
			},
		},
	}

	/** The SDK for JSON_EVENTS, answering `/ticks` with `chunks`. */
	async function ticks(chunks: string[]) {
		const { TestSDK } = (await emittedSdk(JSON_EVENTS)) as unknown as { TestSDK: new (config: Json) => Json }
		const sdk = new TestSDK({ baseURL: BASE, fetch: recordingFetch(() => eventStream(chunks)).fetch })
		const seen: unknown[] = []
		const error = await (async () => {
			for await (const event of sdk.ticks() as AsyncIterable<Json>) seen.push(event)
		})().catch((e: unknown) => e as Json)
		return { error, seen }
	}

	it("parses each event's data as JSON, keeping its event and id", async () => {
		const { error, seen } = await ticks(['event: tick\nid: 1\ndata: {"n":1}\n\n', 'data: {"n":2}\n\n'])
		expect([error, seen]).toEqual([
			undefined,
			[
				{ data: { n: 1 }, event: "tick", id: "1" },
				{ data: { n: 2 }, id: "1" },
			],
		])
	})

	it("fails the stream with a status-0 ClientError naming an event whose data is not JSON", async () => {
		const { ClientError } = await emittedSdk(JSON_EVENTS)
		const { error, seen } = await ticks(['data: {"n":1}\n\n', "id: 7\ndata: oops\n\n"])
		expect([seen.length, error instanceof (ClientError as typeof Error), error?.status, error?.body]).toEqual([
			1,
			true,
			0,
			"oops",
		])
		expect(error?.message).toMatch(/^SSE event "7" is not valid JSON: /)
	})
})
