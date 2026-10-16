import { describe, expect, it } from "vitest"
import { emittedApp } from "./__fixtures__/emitted.ts"

type Event = { data: string; event?: string; id?: string; retry?: number }
type Chunk = string | number[]
type Parse = (stream: ReadableStream<Uint8Array>) => AsyncIterable<Event>

/** The emitted runtime's `parseSSEStream`. */
async function parser(): Promise<Parse> {
	return (await emittedApp()).parseSSEStream as Parse
}

/** A stream delivering `chunks` in order: text as UTF-8, a number array as raw bytes. */
function streamOf(chunks: readonly Chunk[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(typeof c === "string" ? encoder.encode(c) : new Uint8Array(c))
			controller.close()
		},
	})
}

/** Every event the emitted parser dispatches for `stream`. */
async function parseStream(stream: ReadableStream<Uint8Array>): Promise<Event[]> {
	const events: Event[] = []
	for await (const event of (await parser())(stream)) events.push(event)
	return events
}

/** Every event the emitted parser dispatches for `chunks`. */
const parse = (...chunks: Chunk[]): Promise<Event[]> => parseStream(streamOf(chunks))

describe("parseSSEStream: fields", () => {
	// v0: 544ff1d388
	it("reads an event with its type and data", async () => {
		expect(await parse("event: message\ndata: hello\n\n")).toEqual([{ data: "hello", event: "message" }])
	})

	// v0: 0c640d5e83
	it("a data-only event has no event field", async () => {
		expect(await parse("data: bare\n\n")).toEqual([{ data: "bare" }])
	})

	// v0: 4acc532e92
	it("reads the id field, the Last-Event-ID resume source", async () => {
		expect(await parse("event: message\ndata: hello\nid: 1\n\n")).toEqual([
			{ data: "hello", event: "message", id: "1" },
		])
	})

	// v0: e11e4f0341
	it("reads a numeric retry field", async () => {
		expect(await parse("event: message\ndata: hello\nretry: 3000\n\n")).toEqual([
			{ data: "hello", event: "message", retry: 3000 },
		])
	})

	// v0: 11c2c26029
	it("ignores a non-numeric retry", async () => {
		expect(await parse("event: msg\ndata: x\nretry: abc\n\n")).toEqual([{ data: "x", event: "msg" }])
	})

	// v0: 4ffb3e398c
	it("joins multi-line data with a newline", async () => {
		expect(await parse("event: message\ndata: line1\ndata: line2\ndata: line3\n\n")).toEqual([
			{ data: "line1\nline2\nline3", event: "message" },
		])
	})
})

describe("parseSSEStream: values and empty fields", () => {
	// v0: 572976e41a
	it("strips the one space after the colon", async () => {
		expect(await parse("data: spaced\n\n")).toEqual([{ data: "spaced" }])
	})

	// v0: 53b5f85a78
	it("reads a value with no space after the colon", async () => {
		expect(await parse("data:nospace\n\n")).toEqual([{ data: "nospace" }])
	})

	// v0: d88076158c
	it("an empty data field yields an empty string", async () => {
		expect(await parse("event: ping\ndata:\n\n")).toEqual([{ data: "", event: "ping" }])
	})

	// v0: 5dfc2659fb
	it('a field-less "data" line (no colon) is data with an empty value', async () => {
		expect(await parse("data\n\n")).toEqual([{ data: "" }])
	})

	// v0: fe1df493dc
	it("a block with no data line dispatches nothing", async () => {
		expect(await parse("event: empty\n\nevent: real\ndata: ok\n\n")).toEqual([{ data: "ok", event: "real" }])
	})

	// v0: 79d5bf7c50
	it("skips comment and heartbeat lines", async () => {
		expect(await parse(": heartbeat\n\nevent: message\ndata: real\n\n: another comment\n\n")).toEqual([
			{ data: "real", event: "message" },
		])
	})
})

describe("parseSSEStream: framing", () => {
	// v0: 1db41a798e
	it("reads CRLF line endings", async () => {
		expect(await parse("event: msg\r\ndata: crlf\r\n\r\n")).toEqual([{ data: "crlf", event: "msg" }])
	})

	// v0: 8d6102d160
	it('splits blocks separated by \\r\\n\\n into "hello" and "world"', async () => {
		expect(await parse("data: hello\r\n\ndata: world\r\n\n")).toEqual([{ data: "hello" }, { data: "world" }])
	})

	// v0: 37a193d222
	it("reads several events from one chunk", async () => {
		expect(await parse("event: a\ndata: first\n\nevent: b\ndata: second\n\n")).toEqual([
			{ data: "first", event: "a" },
			{ data: "second", event: "b" },
		])
	})

	// v0: 9b05a0c1df
	it("reassembles an event split across chunks", async () => {
		expect(await parse("event: msg\nda", "ta: split\n\n")).toEqual([{ data: "split", event: "msg" }])
	})

	// v0: 1b6b5139bf
	it("bounds its buffer: 2 MB with no line end throws instead of growing without bound", async () => {
		const chunk = new TextEncoder().encode(`data: ${"x".repeat(1024)}`)
		let pushed = 0
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (pushed >= 2 * 1024 * 1024) return controller.close()
				controller.enqueue(chunk)
				pushed += chunk.byteLength
			},
		})
		await expect(parseStream(stream)).rejects.toThrow()
	})
})

/** The shared SSE parse vectors (WHATWG event stream interpretation): chunks in, events out. */
const VECTORS: ReadonlyArray<readonly [name: string, chunks: Chunk[], events: Event[]]> = [
	["single event", ["data: hello\n\n"], [{ data: "hello" }]],
	["multi-line data", ["data: a\ndata: b\n\n"], [{ data: "a\nb" }]],
	["CRLF line endings", ["data: a\r\n\r\n"], [{ data: "a" }]],
	["CR-only line endings", ["data: a\r\rdata: b\r\r"], [{ data: "a" }, { data: "b" }]],
	["CRLF split across chunks", ["data: a\r", "\n\r", "\n"], [{ data: "a" }]],
	["mixed endings do not merge events", ["data: a\n\ndata: b\r\n\r\n"], [{ data: "a" }, { data: "b" }]],
	["event type", ["event: ping\ndata: 1\n\n"], [{ data: "1", event: "ping" }]],
	[
		"id is sticky",
		["id: 7\ndata: a\n\ndata: b\n\n"],
		[
			{ data: "a", id: "7" },
			{ data: "b", id: "7" },
		],
	],
	["empty id resets", ["id: 7\ndata: a\n\nid:\ndata: b\n\n"], [{ data: "a", id: "7" }, { data: "b" }]],
	[
		"id with NUL ignored",
		["id: 1\ndata: a\n\nid: x\u0000y\ndata: b\n\n"],
		[
			{ data: "a", id: "1" },
			{ data: "b", id: "1" },
		],
	],
	[
		"retry digits only",
		["retry: 3000\ndata: a\n\nretry: 0x10\ndata: b\n\nretry:\ndata: c\n\n"],
		[{ data: "a", retry: 3000 }, { data: "b" }, { data: "c" }],
	],
	["comment lines ignored", [": keepalive\n\ndata: a\n\n"], [{ data: "a" }]],
	["no space after colon", ["data:a\n\n"], [{ data: "a" }]],
	["only first space stripped", ["data:  a \n\n"], [{ data: " a " }]],
	["trailing spaces kept", ["data: hello \n\n"], [{ data: "hello " }]],
	["empty data dispatches empty string", ["data:\n\n"], [{ data: "" }]],
	["no data, no event", ["event: x\n\n"], []],
	["BOM stripped", ["﻿data: a\n\n"], [{ data: "a" }]],
	[
		"U+2028 is not a line break",
		['data: {"t":"a event: admin id: 9"}\n\n'],
		[{ data: '{"t":"a event: admin id: 9"}' }],
	],
	["truncated final event discarded", ["data: a\n\ndata: partial"], [{ data: "a" }]],
	["truncated final event with newline discarded", ["data: a\n\ndata: partial\n"], [{ data: "a" }]],
	["unknown field ignored", ["foo: bar\ndata: a\n\n"], [{ data: "a" }]],
	["field without colon", ["data\n\n"], [{ data: "" }]],
	[
		"multibyte UTF-8 split across chunks",
		[
			[100, 97, 116, 97, 58, 32, 240, 159],
			[141, 175, 10, 10],
		],
		[{ data: "🍯" }],
	],
]

describe("parseSSEStream: shared vectors", () => {
	// v0: a2d14412a5
	// v0: 33342d4cdc
	it.each(VECTORS)("%s", async (_name, chunks, events) => {
		expect(await parse(...chunks)).toEqual(events)
	})
})

const ALPHABET = [..."aZ0 :#\n\r\t\"'%\\é", "🍯", "\u2028", "\u0085", "\u007f", ..."-?~{[*&!"]

/** A seeded PRNG in [0, 1), so a failing round reproduces. */
function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0
		return s / 0x100000000
	}
}

/** A random field stream of up to 12 lines, mixing LF, CRLF and CR endings and blank lines. */
function randomStream(next: () => number): string {
	const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T
	let text = ""
	for (let i = 0, lines = Math.floor(next() * 12); i < lines; i++) {
		let value = ""
		for (let n = 0, len = Math.floor(next() * 10); n < len; n++) value += pick(ALPHABET)
		text += `${pick(["data", "event", "id", "retry", ":", "data"])}: ${value.replace(/[\r\n]/g, "")}`
		text += pick(["\n", "\r\n", "\r"])
		if (next() < 0.3) text += "\n"
	}
	return text
}

describe("parseSSEStream: chunk boundaries", () => {
	// v0: 61d8c80345
	it("yields the same events for any chunk split of an LF, CRLF or CR stream (seeded fuzz)", async () => {
		const next = rng(1)
		const parseBytes = async (chunks: Uint8Array[]) => parse(...chunks.map((c) => [...c]))
		for (let round = 0; round < 200; round++) {
			const bytes = new TextEncoder().encode(randomStream(next))
			const chunks: Uint8Array[] = []
			for (let i = 0; i < bytes.length;) {
				const size = 1 + Math.floor(next() * 5)
				chunks.push(bytes.slice(i, i + size))
				i += size
			}
			expect(await parseBytes(chunks)).toEqual(await parseBytes([bytes]))
		}
	})
})
