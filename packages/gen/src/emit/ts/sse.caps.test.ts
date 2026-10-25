/**
 * The TS event-stream parser's caps in bytes, the siblings' (bit 19 d2, sweep item 16): a line over 1 MiB of UTF-8 is
 * the line cap's error, an event's data over 8 MiB (its joining newlines counted) the event cap's, each after every
 * event completed before it. Before, one 1 MiB limit in characters bounded both, so a 2 MiB event of short lines
 * failed and a line of three-byte characters passed at three times the cap. Sizes are compared, never bodies.
 */
import { describe, expect, it } from "vitest"
import { emittedApp } from "./__fixtures__/emitted.ts"

type Event = { data: string }
type Parse = (stream: ReadableStream<Uint8Array>, opts?: Record<string, number>) => AsyncIterable<Event>

const MiB = 1 << 20

/** A stream of `chunks`, each text as UTF-8, enqueued one at a time. */
function streamOf(chunks: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	let next = 0
	return new ReadableStream({
		pull(controller) {
			if (next === chunks.length) return controller.close()
			controller.enqueue(encoder.encode(chunks[next++]))
		},
	})
}

/** Each event's data length, in order, and the error that ended the stream (its message), or null. */
async function drained(chunks: readonly string[], opts?: Record<string, number>) {
	const parse = (await emittedApp()).parseSSEStream as Parse
	const sizes: number[] = []
	try {
		for await (const event of parse(streamOf(chunks), opts)) sizes.push(event.data.length)
		return { error: null, sizes }
	} catch (error) {
		return { error: (error as Error).message, sizes }
	}
}

/** A data line whose whole line, `data: ` included, is `bytes` long in ASCII. */
const line = (bytes: number) => `data: ${"x".repeat(bytes - 6)}\n`

describe("parseSSEStream's caps, in bytes (bit 19 d2)", () => {
	it("delivers a 2 MiB event of lines each under 1 MiB", async () => {
		expect(await drained([line(700_000), line(700_000), line(700_000), "\n"])).toEqual({
			error: null,
			sizes: [3 * (700_000 - 6) + 2],
		})
	})

	it("delivers a line of exactly 1 MiB, and ends one byte longer with the line cap's error after the events before it", async () => {
		expect(await drained(["data: a\n\n", line(MiB), "\n", line(MiB + 1), "\n"])).toEqual({
			error: `SSE line exceeds ${MiB} bytes`,
			sizes: [1, MiB - 6],
		})
	})

	it("counts bytes, not characters: a line of 600,000 three-byte characters is over the 1 MiB cap", async () => {
		expect(await drained(["data: a\n\n", `data: ${"€".repeat(600_000)}\n`, "\n"])).toEqual({
			error: `SSE line exceeds ${MiB} bytes`,
			sizes: [1],
		})
	})

	it("delivers an event of exactly 8 MiB, its joining newlines counted, and ends one over it with the event cap's error after the event before it", async () => {
		/* eight lines of 1 MiB - 7 data bytes and seven joining newlines: 8 MiB - 49 + 7, topped up by a last short line */
		const lines = Array.from({ length: 8 }, () => line(MiB - 1))
		const exact = 8 * MiB - 8 * (MiB - 7) - 8
		const full = [...lines, `data: ${"y".repeat(exact)}\n`, "\n"]
		expect(await drained(["data: a\n\n", ...full])).toEqual({ error: null, sizes: [1, 8 * MiB] })
		const over = [...lines, `data: ${"y".repeat(exact + 1)}\n`, "\n"]
		expect(await drained(["data: a\n\n", ...over])).toEqual({ error: `SSE event exceeds ${8 * MiB} bytes`, sizes: [1] })
	})

	it("takes smaller caps by name: maxLineBytes and maxEventBytes", async () => {
		expect([
			await drained(["data: a\n\n", line(65), "\n"], { maxLineBytes: 64 }),
			await drained(["data: a\n\n", "data: 1234\n", "data: 1234\n", "\n"], { maxEventBytes: 8 }),
		]).toEqual([
			{ error: "SSE line exceeds 64 bytes", sizes: [1] },
			{ error: "SSE event exceeds 8 bytes", sizes: [1] },
		])
	})
})
