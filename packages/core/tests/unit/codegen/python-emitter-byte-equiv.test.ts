import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { generatePythonSDK } from "../../../src/codegen-python"

const FIXTURES = ["crud", "discriminated", "invalidation", "ws", "sse", "refs", "reserved-words"]

describe("python-emitter byte-equivalence", () => {
	for (const name of FIXTURES) {
		it(`${name} client + types stable`, () => {
			const url = new URL(`./fixtures/python/${name}.json`, import.meta.url)
			const spec = JSON.parse(readFileSync(fileURLToPath(url), "utf8"))
			const out = generatePythonSDK(spec, { name: "TestSDK" })

			expect(out.files["client.py"]).toMatchSnapshot(`${name} client.py`)
			expect(out.files["types.py"]).toMatchSnapshot(`${name} types.py`)
		})
	}
})
