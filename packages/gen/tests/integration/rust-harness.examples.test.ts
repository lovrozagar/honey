/**
 * The docs' Rust example (docs/examples/rust/example.rs) in harness mode (bit 20 c2): built as a bin beside an SDK
 * generated from the docs' API, the async SDK called from blocking code included, and run (without a base URL it
 * returns at once). An executed SDK runs here, out of the default run, as bit 13 placed them.
 */
import { describe, expect, it } from "vitest"
import { servedRustSdk } from "../../src/emit/rust/__fixtures__/driven.ts"
import { withRust } from "../../src/emit/rust/__fixtures__/rust-env.ts"
import { docsDocument, exampleOf } from "../../src/emit/shared/__fixtures__/docs-blocks.ts"

const RUST = withRust()
const SLOW = { timeout: 600_000 }

describe.skipIf(!RUST)("the docs' Rust example, built and run", SLOW, () => {
	// v0: 5db1548e11
	it("builds against the generated SDK and runs", async () => {
		const crate = servedRustSdk(docsDocument(), { programs: { example: exampleOf("rust", "example.rs") } })
		const ran = crate.built ? await crate.exec("example", "") : undefined
		expect([crate.built, crate.built ? "" : crate.stderr, ran?.status]).toEqual([true, "", 0])
	})
})
