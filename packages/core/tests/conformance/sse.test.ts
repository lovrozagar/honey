import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseSSEStream } from "../../src/client/sse.ts"

type Chunk = string | { bytes: number[] }
type Vector = { chunks: Chunk[]; events: Array<Record<string, unknown>>; name: string }

const { vectors } = JSON.parse(readFileSync(new URL("./vectors/sse.json", import.meta.url), "utf8")) as {
	vectors: Vector[]
}

function streamOf(chunks: Chunk[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) controller.enqueue(typeof c === "string" ? encoder.encode(c) : new Uint8Array(c.bytes))
			controller.close()
		},
	})
}

describe("conformance: SSE parsing (client/*)", () => {
	for (const v of vectors) {
		it(v.name, async () => {
			const events: unknown[] = []
			for await (const e of parseSSEStream(streamOf(v.chunks))) events.push(e)
			expect(events).toEqual(v.events)
		})
	}
})
