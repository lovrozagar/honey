/**
 * Streaming through app.fetch: stream(), generate() and sse() complete; a client that leaves, or
 * a request that ends, releases the producer (cleanups once, timers cleared, nothing left
 * running); SSE framing and Last-Event-ID resume; rangeResponse from a route; HEAD never starts
 * a producer; streams stay independent of each other and of other requests.
 */
import { type AddressInfo, connect } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { serve } from "../../src/adapters/node/serve.ts"
import { rangeResponse } from "../../src/response/range.ts"
import type { SSEStream } from "../../src/response/sse.ts"
import { honey } from "../../src/routing/app.ts"

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

/** app.fetch answers synchronously when it can: always a promise here. */
const send = async (
	app: { fetch(r: Request, env: {}): Response | Promise<Response> },
	path: string,
	init?: RequestInit,
) => app.fetch(new Request(`http://app.test${path}`, init), {})

/** An app with one route per helper, each recording when its producer starts and ends. */
function streamingApp() {
	const log: string[] = []
	const app = honey<{}>()
	app.get("/stream").handler((ctx) =>
		ctx.res.stream(async (writable) => {
			log.push("stream:start")
			const writer = writable.getWriter()
			await writer.write("a")
			await writer.write("b")
			await writer.close()
		}),
	)
	app.get("/generate").handler((ctx) =>
		ctx.res.generate(
			(async function* () {
				log.push("generate:start")
				try {
					yield '{"n":1}\n'
					yield '{"n":2}\n'
				} finally {
					log.push("generate:finally")
				}
			})(),
			{ contentType: "application/x-ndjson" },
		),
	)
	app.get("/events").handler((ctx) =>
		ctx.res.sse(async (stream) => {
			log.push(`sse:start:${stream.lastEventId ?? "-"}`)
			const from = Number(stream.lastEventId ?? 0)
			for (let id = from + 1; id <= from + 2; id++) await stream.send({ data: { id }, event: "tick", id: String(id) })
		}),
	)
	return { app, log }
}

describe("each helper streams to completion through app.fetch", () => {
	// v0: 4e756099df
	// v0: 19f4fe0178
	// v0: 1e31f960f7
	// v0: d1b522c721
	// v0: 953556cdbd
	// v0: 21ec26e9f8
	it("stream(), generate() and sse() answer their body, type and status", async () => {
		const { app, log } = streamingApp()
		const answers = await Promise.all(
			["/stream", "/generate", "/events"].map(async (path) => {
				const res = await send(app, path)
				return [res.status, res.headers.get("content-type"), await res.text()]
			}),
		)
		expect(answers).toEqual([
			[200, "application/octet-stream", "ab"],
			[200, "application/x-ndjson", '{"n":1}\n{"n":2}\n'],
			[200, "text/event-stream", 'event: tick\ndata: {"id":1}\nid: 1\n\nevent: tick\ndata: {"id":2}\nid: 2\n\n'],
		])
		expect(log.toSorted()).toEqual(["generate:finally", "generate:start", "sse:start:-", "stream:start"])
	})

	// v0: 2bafadd730
	it("an SSE client that reconnects with Last-Event-ID resumes after it", async () => {
		const { app, log } = streamingApp()
		const resumed = await (await send(app, "/events", { headers: { "last-event-id": "5" } })).text()
		expect([resumed.match(/id: \d+/g), log]).toEqual([["id: 6", "id: 7"], ["sse:start:5"]])
	})
})

/** An app whose /live SSE never ends on its own: it ticks until the stream does. */
function liveApp() {
	const ended: string[] = []
	const app = honey<{}>()
	app.get("/live").handler((ctx) =>
		ctx.res.sse(
			async (stream: SSEStream) => {
				stream.signal.addEventListener("abort", () => ended.push("aborted"))
				for (let n = 0; !stream.closed; n++) await stream.send({ data: String(n), event: "tick" })
			},
			{ keepalive: 1000 },
		),
	)
	return { app, ended }
}

describe("a stream ends when its client or its request does, and leaves nothing running", () => {
	// v0: 1895334371
	// v0: 4d37d5e373
	// v0: 6d0753f62c
	it("the client cancelling the body aborts the producer and clears its keepalive timer", async () => {
		const cleared = vi.spyOn(globalThis, "clearInterval")
		const { app, ended } = liveApp()
		const reader = ((await send(app, "/live")).body as ReadableStream<Uint8Array>).getReader()
		await reader.read()
		await reader.read()
		await reader.cancel()
		expect([ended, cleared.mock.calls.length]).toEqual([["aborted"], 1])
	})

	// v0: ee69b43ebd
	// v0: e3f532bdd4
	it("the request aborting (ctx.signal) ends a running SSE cleanly", async () => {
		const { app, ended } = liveApp()
		const client = new AbortController()
		const reader = (
			(await send(app, "/live", { signal: client.signal })).body as ReadableStream<Uint8Array>
		).getReader()
		await reader.read()
		client.abort()
		let done = false
		while (!done) done = (await reader.read()).done === true
		expect(ended).toEqual(["aborted"])
	})
})

/** One event-loop turn: an endless producer that never yields would starve the client sharing this process. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

/** An app with an endless producer per helper, each recording when its finally runs. */
function endlessApp() {
	const finished: string[] = []
	const app = honey<{}>()
	app.get("/stream").handler((ctx) =>
		ctx.res.stream(async (writable) => {
			const writer = writable.getWriter()
			try {
				for (;;) await writer.write("tick\n").then(tick)
			} finally {
				finished.push("stream")
			}
		}),
	)
	app.get("/generate").handler((ctx) =>
		ctx.res.generate(
			(async function* () {
				try {
					for (;;) {
						yield "tick\n"
						await tick()
					}
				} finally {
					finished.push("generate")
				}
			})(),
		),
	)
	app.get("/sse").handler((ctx) =>
		ctx.res.sse(async (stream) => {
			try {
				while (!stream.closed) await stream.send({ data: "1", event: "tick" }).then(tick)
			} finally {
				finished.push("sse")
			}
		}),
	)
	return { app, finished }
}

describe("a stream ends when its client drops the socket", () => {
	// v0: 6e66defcb5
	it("stream(), generate() and sse() each run their finally after a real socket drops mid-stream", async () => {
		const { app, finished } = endlessApp()
		const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
		await new Promise((resolve) => server.once("listening", resolve))
		const { port } = server.address() as AddressInfo
		try {
			for (const path of ["/stream", "/generate", "/sse"]) {
				const socket = connect(port, "127.0.0.1")
				socket.on("error", () => {})
				await new Promise((resolve) => {
					socket.once("data", resolve)
					socket.write(`GET ${path} HTTP/1.1\r\nHost: h\r\n\r\n`)
				})
				socket.destroy()
			}
			await expect.poll(() => finished.toSorted()).toEqual(["generate", "sse", "stream"])
		} finally {
			await server.shutdown(0)
		}
	})
})

describe("HEAD and range from a route", () => {
	// v0: 38b62aecf2
	it("HEAD on a streaming route answers its head and never runs the producer", async () => {
		const { app, log } = streamingApp()
		const heads = await Promise.all(
			["/stream", "/generate", "/events"].map((path) => send(app, path, { method: "HEAD" })),
		)
		expect([heads.map((res) => res.status), log]).toEqual([[200, 200, 200], []])
	})

	it("rangeResponse answers 206, 416 and 200 from a route", async () => {
		const video = new Blob([new TextEncoder().encode("0123456789")], { type: "video/mp4" })
		const app = honey<{}>()
		app.get("/video").handler((ctx) => ctx.res.raw(rangeResponse(ctx.req, video)))
		const answers = await Promise.all(
			([{ range: "bytes=2-4" }, { range: "bytes=20-" }, {}] as Record<string, string>[]).map(async (headers) => {
				const res = await send(app, "/video", { headers })
				return [res.status, res.headers.get("content-range"), await res.text()]
			}),
		)
		expect(answers).toEqual([
			[206, "bytes 2-4/10", "234"],
			[416, "bytes */10", ""],
			[200, null, "0123456789"],
		])
	})
})

describe("streams stay apart", () => {
	// v0: a423a6c871
	// v0: 8a99fa6b71
	it("two SSE clients get their own events, and an open stream blocks no other request", async () => {
		const { app } = streamingApp()
		const live = liveApp()
		const open = ((await send(live.app, "/live")).body as ReadableStream<Uint8Array>).getReader()
		await open.read()
		const [first, second, plain] = await Promise.all([
			send(app, "/events", { headers: { "last-event-id": "10" } }).then((r) => r.text()),
			send(app, "/events", { headers: { "last-event-id": "20" } }).then((r) => r.text()),
			send(app, "/stream").then((r) => r.text()),
		])
		await open.cancel()
		expect([first.match(/id: \d+/g), second.match(/id: \d+/g), plain]).toEqual([
			["id: 11", "id: 12"],
			["id: 21", "id: 22"],
			"ab",
		])
	})
})

describe("streams at scale", () => {
	// v0: 69e4601c9d
	// v0: f0d3849b91
	// v0: 66b9bf45c6
	// v0: 6b9d15459d
	// v0: c2d2de0e1e
	// v0: b8fba75cd1
	// v0: 87b0437813
	// v0: 315781587c
	it("large and many: 1000 events of 10 KB, 100k generated chunks, a 1 MB write, unicode intact", async () => {
		const app = honey<{}>()
		const big = "é".repeat(5_000) + "🍯".repeat(1_250)
		app.get("/sse").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				for (let i = 0; i < 1000; i++) await stream.send({ data: big, event: "big" })
			}),
		)
		app.get("/gen").handler((ctx) =>
			ctx.res.generate(
				(function* () {
					for (let i = 0; i < 100_000; i++) yield "x"
				})(),
			),
		)
		app.get("/mb").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				await writer.write(new Uint8Array(1024 * 1024).fill(7))
				await writer.close()
			}),
		)
		const [events, chunks, bytes] = await Promise.all([
			send(app, "/sse").then((r) => r.text()),
			send(app, "/gen").then((r) => r.text()),
			send(app, "/mb").then((r) => r.arrayBuffer()),
		])
		expect([events.split(`data: ${big}\n`).length - 1, chunks.length, bytes.byteLength]).toEqual([
			1000,
			100_000,
			1024 * 1024,
		])
	})
})
