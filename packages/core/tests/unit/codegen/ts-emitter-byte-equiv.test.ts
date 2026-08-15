import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { generateSDK } from "../../../src/codegen.ts"

const FIXTURES = [
	{ file: "crud.json", name: "crud" },
	{ file: "discriminated.json", name: "discriminated" },
	{ file: "invalidation.json", name: "invalidation" },
	{ file: "ws.json", name: "ws" },
	{ file: "sse.json", name: "sse" },
	{ file: "refs.json", name: "refs" },
	{ file: "reserved-words.json", name: "reserved-words" },
]

describe("ts-emitter byte-equivalence", () => {
	for (const f of FIXTURES) {
		const spec = JSON.parse(
			readFileSync(
				fileURLToPath(new URL(`./fixtures/python/${f.file}`, import.meta.url)),
				"utf-8",
			),
		)
		const out = generateSDK(spec, { name: "TestSDK" })

		it(`${f.name} — types file stable`, () => {
			expect(out.files.types).toMatchSnapshot()
		})

		it(`${f.name} — client file stable`, () => {
			expect(out.files.client).toMatchSnapshot()
		})

		it(`${f.name} — map file stable`, () => {
			expect(out.files.map).toMatchSnapshot()
		})

		it(`${f.name} — index file stable`, () => {
			expect(out.files.index).toMatchSnapshot()
		})
	}
})
