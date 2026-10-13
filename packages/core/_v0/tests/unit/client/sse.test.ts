import { describe, expect, it } from "vitest"
import type { SSEEvent } from "../../../src/client/sse.ts"
import { parseSSEStream } from "../../../src/client/sse.ts"

function createStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk))
			}
			controller.close()
		},
	})
}

async function collectEvents(stream: AsyncIterable<SSEEvent>): Promise<SSEEvent[]> {
	const events: SSEEvent[] = []
	for await (const event of stream) {
		events.push(event)
	}
	return events
}

describe("parseSSEStream", () => {
	it("parses basic event with data", async () => {
		const stream = createStream(["event: message\ndata: hello\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "hello", event: "message" }])
	})

	it("parses event with id", async () => {
		const stream = createStream(["event: message\ndata: hello\nid: 1\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "hello", event: "message", id: "1" }])
	})

	it("parses event with retry", async () => {
		const stream = createStream(["event: message\ndata: hello\nretry: 3000\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "hello", event: "message", retry: 3000 }])
	})

	it("handles multi-line data", async () => {
		const stream = createStream(["event: message\ndata: line1\ndata: line2\ndata: line3\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "line1\nline2\nline3", event: "message" }])
	})

	it("handles multiple events in single chunk", async () => {
		const stream = createStream(["event: a\ndata: first\n\nevent: b\ndata: second\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toHaveLength(2)
		expect(events[0]).toEqual({ data: "first", event: "a" })
		expect(events[1]).toEqual({ data: "second", event: "b" })
	})

	it("handles events split across chunks", async () => {
		const stream = createStream(["event: msg\nda", "ta: split\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "split", event: "msg" }])
	})

	it("skips heartbeat comments", async () => {
		const stream = createStream([": heartbeat\n\nevent: message\ndata: real\n\n: another comment\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "real", event: "message" }])
	})

	it("handles data-only events (no event field)", async () => {
		const stream = createStream(["data: bare\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "bare" }])
	})

	it("ignores retry with non-numeric value", async () => {
		const stream = createStream(["event: msg\ndata: x\nretry: abc\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "x", event: "msg" }])
	})

	it("handles empty data field", async () => {
		const stream = createStream(["event: ping\ndata:\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "", event: "ping" }])
	})

	it("ignores events with no data field at all", async () => {
		const stream = createStream(["event: empty\n\nevent: real\ndata: ok\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "ok", event: "real" }])
	})

	it("handles \\r\\n line endings", async () => {
		const stream = createStream(["event: msg\r\ndata: crlf\r\n\r\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "crlf", event: "msg" }])
	})

	it("handles data field with space after colon", async () => {
		const stream = createStream(["data: spaced\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "spaced" }])
	})

	it("handles data field without space after colon", async () => {
		const stream = createStream(["data:nospace\n\n"])
		const events = await collectEvents(parseSSEStream(stream))

		expect(events).toEqual([{ data: "nospace" }])
	})
})
