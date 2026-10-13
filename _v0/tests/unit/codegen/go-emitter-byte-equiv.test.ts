import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { generateGoSDK } from "../../../src/codegen-go"

const FIXTURES = ["crud", "discriminated", "invalidation", "ws", "sse", "refs", "reserved-words"]

describe("go-emitter byte-equivalence", () => {
	for (const name of FIXTURES) {
		it(`${name} client + types stable`, () => {
			const url = new URL(`./fixtures/python/${name}.json`, import.meta.url)
			const spec = JSON.parse(readFileSync(fileURLToPath(url), "utf8"))
			const out = generateGoSDK(spec)

			expect(out.files["client.go"]).toMatchSnapshot(`${name} client.go`)
			expect(out.files["types.go"]).toMatchSnapshot(`${name} types.go`)
		})
	}
})
