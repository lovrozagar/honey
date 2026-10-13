import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { parseSSEStream } from "../../src/client/sse.ts"
import { parseCookieHeader, serializeCookie } from "../../src/cookie.ts"
import { toYaml } from "../../src/yaml.ts"

/* Deterministic PRNG so failures reproduce. */
function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0
		return s / 0x100000000
	}
}

const ALPHABET = [
	"a",
	"Z",
	"0",
	" ",
	":",
	"#",
	"\n",
	"\r",
	"\t",
	'"',
	"'",
	"%",
	"\\",
	"é",
	"🍯",
	" ",
	"\u0085",
	"\u007f",
	"-",
	"?",
	"~",
	"{",
	"[",
	"*",
	"&",
	"!",
]

function randomString(next: () => number, max: number): string {
	let out = ""
	const len = Math.floor(next() * max)
	for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)]
	return out
}

async function collect(chunks: Uint8Array[]): Promise<unknown[]> {
	const stream = new ReadableStream<Uint8Array>({
		start(c) {
			for (const chunk of chunks) c.enqueue(chunk)
			c.close()
		},
	})
	const out: unknown[] = []
	for await (const e of parseSSEStream(stream)) out.push(e)
	return out
}

describe("fuzz: SSE parsing is independent of chunk boundaries", () => {
	it("any split of a stream yields the same events", async () => {
		const next = rng(1)
		for (let round = 0; round < 200; round++) {
			let text = ""
			const lines = Math.floor(next() * 12)
			for (let i = 0; i < lines; i++) {
				const field = ["data", "event", "id", "retry", ":", "data"][Math.floor(next() * 6)]
				const value = randomString(next, 10).replace(/[\r\n]/g, "")
				text += `${field}: ${value}${["\n", "\r\n", "\r"][Math.floor(next() * 3)]}`
				if (next() < 0.3) text += "\n"
			}
			const bytes = new TextEncoder().encode(text)
			const whole = await collect([bytes])
			const chunks: Uint8Array[] = []
			for (let i = 0; i < bytes.length;) {
				const size = 1 + Math.floor(next() * 5)
				chunks.push(bytes.slice(i, i + size))
				i += size
			}
			expect(await collect(chunks)).toEqual(whole)
		}
	})
})

describe("fuzz: YAML matches JSON for random strings", () => {
	const jsYaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown }
	it("keys and values round-trip", () => {
		const next = rng(2)
		for (let round = 0; round < 500; round++) {
			const key = randomString(next, 8)
			const value = randomString(next, 12)
			const doc = { [key]: value, list: [value, { [value]: key }] }
			expect(jsYaml.load(toYaml(doc))).toEqual(JSON.parse(JSON.stringify(doc)))
		}
	})
})

describe("fuzz: cookie values round-trip", () => {
	it("random strings survive serialize → parse", () => {
		const next = rng(3)
		for (let round = 0; round < 500; round++) {
			const value = randomString(next, 16)
			const header = serializeCookie("c", { value }).split(";")[0] ?? ""
			expect(parseCookieHeader(header).c).toBe(value)
		}
	})
})
