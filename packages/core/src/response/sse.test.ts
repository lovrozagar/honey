import { afterEach, describe, expect, it, vi } from "vitest"
import { encodeEvent, type SSEOptions, type SSEStream, sseBody } from "./sse.ts"

/** The whole body an SSE callback produces, as text. */
function bodyOf(callback: (stream: SSEStream) => Promise<void>, options: SSEOptions = {}): Promise<string> {
	return new Response(sseBody(callback, options, {})).text()
}

afterEach(() => {
	vi.useRealTimers()
})

describe("encodeEvent: framing", () => {
	// v0: 0044d5fc0e
	// v0: 109f60ec2d
	// v0: fd83df2cb1
	// v0: d62073cc71
	// v0: 1f96fa3536
	// v0: b01526bd02
	// v0: a1b6c62bc8
	// v0: a46441de93
	// v0: 54f0235240
	it.each([
		["one line", { data: "hi", event: "msg" }, "event: msg\ndata: hi\n\n"],
		[
			"lines split on LF, CRLF and CR",
			{ data: "a\nb\r\nc\rd", event: "m" },
			"event: m\ndata: a\ndata: b\ndata: c\ndata: d\n\n",
		],
		["object data as JSON", { data: { n: 1, s: "é" }, event: "m" }, 'event: m\ndata: {"n":1,"s":"é"}\n\n'],
		["an id", { data: "x", event: "m", id: "42" }, "event: m\ndata: x\nid: 42\n\n"],
		["an empty id: the reset directive (H18.6)", { data: "x", event: "m", id: "" }, "event: m\ndata: x\nid:\n\n"],
		["empty data", { data: "", event: "m" }, "event: m\ndata: \n\n"],
	])("%s", (_case, event, wire) => {
		expect(encodeEvent(event)).toBe(wire)
	})
})

describe("encodeEvent: the retry directive", () => {
	// v0: 25367e3581
	// v0: b4e2dd7e37
	// v0: e6711d12a4
	// v0: 32395ab237
	// v0: 44b18dcd64
	// v0: 8e07f86676
	// v0: 8a85da3060
	// v0: 4a5abbfc3a
	// v0: 415f2c4dd8
	it.each([
		[3000, "retry: 3000\n"],
		[1500.9, "retry: 1500\n"],
		[0, "retry: 0\n"],
		[-1, ""],
		[Number.NaN, ""],
		[Number.POSITIVE_INFINITY, ""],
	])("retry %s: a non-negative finite value is floored, anything else left out", (retry, line) => {
		expect(encodeEvent({ data: "x", event: "m", retry })).toBe(`event: m\ndata: x\n${line}\n`)
	})
})

describe("encodeEvent: what it refuses", () => {
	// v0: d8340be145
	// v0: a246333412
	// v0: f32ad076d5
	// v0: ef82637ddd
	it.each([
		["an event name with LF", { data: "x", event: "a\nb" }, "SSE event name must not contain newlines"],
		["an event name with CR", { data: "x", event: "a\rb" }, "SSE event name must not contain newlines"],
		["an id with LF", { data: "x", event: "m", id: "1\n2" }, "SSE id must not contain newlines"],
		["an id with CR", { data: "x", event: "m", id: "1\r2" }, "SSE id must not contain newlines"],
	])("%s throws: it would start another field", (_case, event, message) => {
		expect(() => encodeEvent(event)).toThrow(message)
	})

	// v0: b12e538c56
	it("data JSON cannot encode throws at send", () => {
		expect(() => encodeEvent({ data: { n: 1n }, event: "m" })).toThrow(TypeError)
	})
})

describe("sseBody: the stream a callback writes", () => {
	// v0: 58aa4627b2
	// v0: c5b44d84af
	it("sends defaultRetry first, then the events, and ends when the callback returns", async () => {
		const body = await bodyOf(
			async (stream) => {
				await stream.send({ data: "1", event: "tick" })
				await stream.send({ data: "2", event: "tick" })
			},
			{ defaultRetry: 2000 },
		)
		expect(body).toBe("retry: 2000\n\nevent: tick\ndata: 1\n\nevent: tick\ndata: 2\n\n")
	})

	it("leaves out a defaultRetry that is not a non-negative finite number", async () => {
		expect(await bodyOf(async () => {}, { defaultRetry: -5 })).toBe("")
	})

	// v0: cbc640a041
	// v0: 0d9898e42f
	// v0: 843546b6cc
	// v0: 6c23817c7f
	// v0: 3763829856
	it("exposes the lastEventId it was given, or undefined", async () => {
		const seen: unknown[] = []
		await bodyOf(async (stream) => void seen.push(stream.lastEventId), { lastEventId: "41" })
		await bodyOf(async (stream) => void seen.push(stream.lastEventId))
		expect(seen).toEqual(["41", undefined])
	})
})

describe("sseBody: ending, and sending to an ended stream", () => {
	// v0: 884b826e7a
	// v0: 63e99a9be1
	it("close() ends the stream once; closed and the signal report it", async () => {
		const states: unknown[] = []
		const body = await bodyOf(async (stream) => {
			await stream.send({ data: "x", event: "m" })
			stream.close()
			stream.close()
			states.push(stream.closed, stream.signal.aborted)
		})
		expect([body, states]).toEqual(["event: m\ndata: x\n\n", [true, false]])
	})

	// v0: ac93aea49b
	// v0: 7c48849ed1
	it("send() resolves when the reader asks for more, so events arrive in order", async () => {
		const sent: number[] = []
		const body = sseBody(
			async (stream) => {
				for (let i = 0; i < 10; i++) {
					await stream.send({ data: String(i), event: "n" })
					sent.push(i)
				}
			},
			{},
			{},
		)
		const reader = body.getReader()
		await reader.read()
		await new Promise((resolve) => setTimeout(resolve, 5))
		expect(sent).toEqual([])
		const text = new TextDecoder()
		let rest = ""
		for (let r = await reader.read(); r.done !== true; r = await reader.read()) rest += text.decode(r.value)
		expect([sent.length, rest.split("event: n").length - 1]).toEqual([10, 9])
	})

	// v0: 1282538d33
	it("send() after the end rejects for an awaiting loop, and never as an unhandled rejection", async () => {
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)
		const outcomes: string[] = []
		await bodyOf(async (stream) => {
			stream.close()
			void stream.send({ data: "lost", event: "m" })
			await stream.send({ data: "lost", event: "m" }).catch((error: Error) => outcomes.push(error.name))
		})
		await new Promise((resolve) => setTimeout(resolve, 10))
		process.off("unhandledRejection", unhandled)
		expect([outcomes, unhandled.mock.calls.length]).toEqual([["AbortError"], 0])
	})
})

describe("sseBody: keepalive heartbeats", () => {
	// v0: 56caa55f38
	// v0: 4d8be156fb
	it("writes a heartbeat comment each interval while the stream is idle", async () => {
		vi.useFakeTimers()
		const release = Promise.withResolvers<void>()
		const body = sseBody(() => release.promise, { keepalive: 1000 }, {})
		const reader = body.getReader()
		const first = reader.read()
		await vi.advanceTimersByTimeAsync(1000)
		const second = reader.read()
		await vi.advanceTimersByTimeAsync(1000)
		release.resolve()
		const text = new TextDecoder()
		expect([text.decode((await first).value), text.decode((await second).value), (await reader.read()).done]).toEqual([
			": heartbeat\n\n",
			": heartbeat\n\n",
			true,
		])
	})

	// v0: d1b063527a
	// v0: 8faf9658f2
	// v0: 4e02e66ad5
	it.each([undefined, 0, -100])("keepalive %s: no heartbeat timer at all", async (keepalive) => {
		vi.useFakeTimers()
		const spy = vi.spyOn(globalThis, "setInterval")
		const body = sseBody(async () => {}, { keepalive }, {})
		await new Response(body).text()
		expect(spy).not.toHaveBeenCalled()
	})

	it("never piles heartbeats up behind a reader that stopped reading", async () => {
		vi.useFakeTimers()
		const body = sseBody(() => new Promise(() => {}), { keepalive: 10 }, {})
		const reader = body.getReader()
		const first = reader.read()
		await vi.advanceTimersByTimeAsync(10)
		await first
		/* nobody reads for ten intervals: no heartbeat is queued behind the stalled reader */
		await vi.advanceTimersByTimeAsync(100)
		let arrived = false
		const second = reader.read().then((r) => {
			arrived = true
			return r
		})
		await vi.advanceTimersByTimeAsync(0)
		const queued = arrived
		await vi.advanceTimersByTimeAsync(10)
		expect([queued, new TextDecoder().decode((await second).value)]).toEqual([false, ": heartbeat\n\n"])
		await reader.cancel()
	})
})

/** How many times clearInterval ran once `end` ended a keepalive stream. */
async function liveAfter(end: (stream: SSEStream, reader: ReadableStreamDefaultReader<Uint8Array>) => Promise<void>) {
	vi.useFakeTimers()
	const cleared = vi.spyOn(globalThis, "clearInterval")
	const started = Promise.withResolvers<SSEStream>()
	const body = sseBody(
		(stream) => {
			started.resolve(stream)
			return new Promise((_resolve, reject) =>
				stream.signal.addEventListener("abort", () => reject(stream.signal.reason)),
			)
		},
		{ keepalive: 50 },
		{},
	)
	const reader = body.getReader()
	void reader.read().catch(() => {})
	await end(await started.promise, reader)
	return cleared.mock.calls.length
}

describe("sseBody: the heartbeat timer ends with the stream", () => {
	// v0: 1895334371
	// v0: fac63540f4
	// v0: 7445f56370
	// v0: f5033d6479
	// v0: 25dee73360
	it.each([
		["close()", (stream: SSEStream) => Promise.resolve(stream.close())],
		["the reader cancelling", (_stream: SSEStream, reader: ReadableStreamDefaultReader<Uint8Array>) => reader.cancel()],
	])("cleared on %s", async (_case, end) => {
		expect(await liveAfter(end)).toBe(1)
	})

	it("cleared when the callback throws, with the body broken", async () => {
		vi.useFakeTimers()
		const cleared = vi.spyOn(globalThis, "clearInterval")
		const body = sseBody(
			async (stream) => {
				await stream.send({ data: "x", event: "m" })
				throw new Error("callback failed")
			},
			{ keepalive: 50 },
			{},
		)
		await expect(new Response(body).text()).rejects.toThrow("callback failed")
		expect(cleared).toHaveBeenCalledTimes(1)
	})
})
