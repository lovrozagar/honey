import { PassThrough } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import { recordingServer, type Reply, served } from "./__fixtures__/recording-server.ts"
import { streamStage } from "./__fixtures__/stream-server.ts"

/** Each chunk of `res`'s body with the ms it arrived after `start`, and how the body ended. */
async function chunksOf(res: Response, start: number) {
	const reader = (res.body as ReadableStream<Uint8Array>).getReader()
	const chunks: { at: number; text: string }[] = []
	try {
		for (let read = await reader.read(); !read.done; read = await reader.read())
			chunks.push({ at: Date.now() - start, text: Buffer.from(read.value).toString("latin1") })
		return { chunks, ended: "end" }
	} catch {
		return { chunks, ended: "error" }
	}
}

/** Poll `check` every 10 ms until it holds, for at most a second. */
async function eventually(check: () => boolean): Promise<boolean> {
	for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
	return check()
}

describe("the stream server: event streams", () => {
	it("writes every step's bytes as given, chunked under the reply's status and headers, then ends the body", async () => {
		const steps = ["data: a\r\n\r\n", "id: 1\rdata: b\r\r", "﻿data: half", " done\n\n", ""]
		const reply: Reply = { headers: { "x-stream-id": "s-1" }, sse: { end: "close", steps }, status: 200 }
		const [res, body, streams] = await served([reply], async (server) => {
			const answered = await fetch(server.url)
			return [answered, Buffer.from(await answered.arrayBuffer()), server.streams] as const
		})
		expect({
			body: body.toString("utf8"),
			length: res.headers.get("content-length"),
			status: res.status,
			streams,
			type: res.headers.get("content-type"),
			xfer: res.headers.get("transfer-encoding"),
			xStream: res.headers.get("x-stream-id"),
		}).toEqual({
			body: steps.join(""),
			length: null,
			status: 200,
			streams: [{ clientGone: false, received: [] }],
			type: "text/event-stream",
			xfer: "chunked",
			xStream: "s-1",
		})
	})

	it("serves contentType in place of text/event-stream, and the reply's own content-type over both", async () => {
		const replies: Reply[] = [
			{ sse: { contentType: "text/plain", end: "close", steps: ["x"] }, status: 200 },
			{ headers: { "content-type": "application/json" }, sse: { end: "close", steps: [] }, status: 503 },
		]
		const seen = await served(replies, async (server) => {
			const answers = [await fetch(server.url), await fetch(server.url)]
			return Promise.all(answers.map(async (res) => [res.status, res.headers.get("content-type"), await res.text()]))
		})
		expect(seen).toEqual([
			[200, "text/plain", "x"],
			[503, "application/json", ""],
		])
	})

	it("flushes each step as it comes: the bytes before a pause arrive before it ends", async () => {
		const reply: Reply = { sse: { end: "close", steps: ["data: 1\n\n", { waitMs: 300 }, "data: 2\n\n"] }, status: 200 }
		const { chunks, ended } = await served([reply], async (server) => {
			const start = Date.now()
			return chunksOf(await fetch(server.url), start)
		})
		expect({ ended, texts: chunks.map((chunk) => chunk.text) }).toEqual({
			ended: "end",
			texts: ["data: 1\n\n", "data: 2\n\n"],
		})
		expect(chunks[0]?.at).toBeLessThan(250)
		expect(chunks[1]?.at).toBeGreaterThanOrEqual(290)
	})
})

describe("the stream server: how an event stream ends", () => {
	it("drops the connection after the steps reached the client: a body failing with no final chunk, the client not gone", async () => {
		/* the pause lets fetch read the event: undici discards what it queued once the body errors */
		const reply: Reply = { sse: { end: "drop", steps: ["id: 1\ndata: a\n\n", { waitMs: 100 }] }, status: 200 }
		const [read, streams] = await served([reply], async (server) => {
			const res = await fetch(server.url)
			return [await chunksOf(res, Date.now()), server.streams] as const
		})
		expect({ ended: read.ended, streams, text: read.chunks.map((c) => c.text).join("") }).toEqual({
			ended: "error",
			streams: [{ clientGone: false, received: [] }],
			text: "id: 1\ndata: a\n\n",
		})
	})

	it("holds the stream open until the client leaves, and records that the client went first", async () => {
		const reply: Reply = { sse: { end: "hold", steps: ["data: 1\n\n"] }, status: 200 }
		const [first, gone] = await served([reply], async (server) => {
			const abort = new AbortController()
			const res = await fetch(server.url, { signal: abort.signal })
			const reader = (res.body as ReadableStream<Uint8Array>).getReader()
			const chunk = await reader.read()
			abort.abort()
			return [
				Buffer.from(chunk.value as Uint8Array).toString(),
				await eventually(() => server.streams[0]?.clientGone === true),
			]
		})
		expect({ first, gone }).toEqual({ first: "data: 1\n\n", gone: true })
	})

	it("ends a held stream and every pending pause when the server closes, the client not gone and nothing written late", async () => {
		const server = await recordingServer([
			{ sse: { end: "hold", steps: ["data: 1\n\n"] }, status: 200 },
			{ sse: { end: "close", steps: [{ waitMs: 60_000 }, "late"] }, status: 200 },
		])
		const start = Date.now()
		const reads = [await fetch(server.url), await fetch(server.url)].map((res) => chunksOf(res, start))
		await new Promise((resolve) => setTimeout(resolve, 100))
		await server.close()
		const [held, paused] = await Promise.all(reads)
		expect({
			held: held.chunks.map((c) => c.text),
			heldEnded: held.ended,
			paused: paused.chunks,
			pausedEnded: paused.ended,
			streams: server.streams,
		}).toEqual({
			held: ["data: 1\n\n"],
			heldEnded: "error",
			paused: [],
			pausedEnded: "error",
			streams: [
				{ clientGone: false, received: [] },
				{ clientGone: false, received: [] },
			],
		})
		expect(Date.now() - start).toBeLessThan(5000)
	})
})

describe("the stream server: event-stream reconnects", () => {
	it("records each reconnect as its own hop, the Last-Event-ID the client resumed with observed on it", async () => {
		const replies: Reply[] = [
			{ sse: { end: "drop", steps: ["id: 1\ndata: a\n\n", { waitMs: 100 }] }, status: 200 },
			{ delayMs: 150, sse: { end: "close", steps: ["id: 2\ndata: b\n\n"] }, status: 200 },
		]
		const [texts, hops, elapsed] = await served(replies, async (server) => {
			const first = await chunksOf(await fetch(server.url), Date.now())
			const start = Date.now()
			const second = await fetch(`${server.url}/resume`, { headers: { "last-event-id": "1" } })
			const waited = Date.now() - start
			return [[first.chunks[0]?.text, await second.text()], server.hops, waited] as const
		})
		expect({ ids: hops.map((hop) => [hop.url, hop.headers["last-event-id"]]), texts }).toEqual({
			ids: [
				["/", undefined],
				["/resume", "1"],
			],
			texts: ["id: 1\ndata: a\n\n", "id: 2\ndata: b\n\n"],
		})
		expect(elapsed).toBeGreaterThanOrEqual(140)
	})
})

describe("the stream server: replies it refuses", () => {
	it("refuses a stream beside a body, two streams, and a WebSocket reply without status 101, before listening", async () => {
		const sse = { end: "close", steps: [] } as const
		const bad: Reply[] = [
			{ json: {}, sse, status: 200 },
			{ status: 101, text: "x", ws: { steps: [] } },
			{ sse, status: 101, ws: { steps: [] } },
			{ status: 200, ws: { steps: [] } },
		]
		const errors = await Promise.all(
			bad.map((reply) => recordingServer([reply]).catch((error: Error) => error.message)),
		)
		expect(errors).toEqual([
			"reply 0 names 2 bodies; give at most one",
			"reply 0 names 2 bodies; give at most one",
			"reply 0 names 2 bodies; give at most one",
			"reply 0 accepts a WebSocket with status 101",
		])
	})

	it("answers a WebSocket reply to a plain request with a 500, and close() rejects naming the violation", async () => {
		const server = await recordingServer([{ status: 101, ws: { steps: [] } }])
		const res = await fetch(`${server.url}/plain`)
		expect({ status: res.status, streams: server.streams }).toEqual({ status: 500, streams: [undefined] })
		await expect(server.close()).rejects.toThrow("GET /plain: a ws reply to a request that is no upgrade")
	})
})

describe("the stream stage: what a server's close stops", () => {
	it("ends a pending pause at once with false, refuses one after it, and lets one run out with true", async () => {
		const stage = streamStage()
		const started = Date.now()
		const [short, long] = [stage.wait(20), stage.wait(60_000)]
		expect(await short).toBe(true)
		stage.violation("v1")
		const seen = stage.stop()
		expect({ after: await stage.wait(10), long: await long, seen, stopped: stage.stopped }).toEqual({
			after: false,
			long: false,
			seen: ["v1"],
			stopped: true,
		})
		expect(Date.now() - started).toBeLessThan(1000)
	})

	it("destroys the sockets it holds on stop, a socket error swallowed rather than thrown", async () => {
		const stage = streamStage()
		const [open, closed] = [new PassThrough(), new PassThrough()]
		stage.hold(open)
		stage.hold(closed)
		closed.destroy()
		await new Promise((resolve) => closed.once("close", resolve))
		open.emit("error", new Error("reset"))
		stage.stop()
		expect([open.destroyed, closed.destroyed]).toEqual([true, true])
	})
})

describe("the stream server: a pause", () => {
	it("lasts at least its ms in real time when its timer fires early, as Node's do on a stale loop clock", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		let now = 1000
		const clock = vi.spyOn(performance, "now").mockImplementation(() => now)
		try {
			const ended: boolean[] = []
			void streamStage()
				.wait(50)
				.then((passed) => ended.push(passed))
			now += 49.4
			await vi.advanceTimersByTimeAsync(50)
			const early = [...ended]
			now += 0.6
			await vi.advanceTimersByTimeAsync(1)
			expect([early, ended]).toEqual([[], [true]])
		} finally {
			clock.mockRestore()
			vi.useRealTimers()
		}
	})
})
