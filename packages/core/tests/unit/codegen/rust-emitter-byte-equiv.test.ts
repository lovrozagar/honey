import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { generateRustSDK } from "../../../src/codegen-rust"

const FIXTURES = ["crud", "discriminated", "invalidation", "ws", "sse", "refs", "reserved-words"]

/** Keys whose content varies per fixture (types, client, resource modules). */
function variantKeys(files: Record<string, string>): string[] {
	return Object.keys(files).filter(
		(k) =>
			k === "src/types.rs" ||
			k === "src/client.rs" ||
			k.startsWith("src/resources/"),
	)
}

describe("rust-emitter byte-equivalence", () => {
	for (const name of FIXTURES) {
		it(`${name} types + client + resources stable`, () => {
			const url = new URL(`./fixtures/python/${name}.json`, import.meta.url)
			const spec = JSON.parse(readFileSync(fileURLToPath(url), "utf8"))
			const out = generateRustSDK(spec)

			for (const key of variantKeys(out.files)) {
				expect(out.files[key]).toMatchSnapshot(`${name} ${key}`)
			}
		})
	}
})
