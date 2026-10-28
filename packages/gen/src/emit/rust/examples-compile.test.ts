/**
 * The docs' Rust example (docs/examples/rust/example.rs) builds as a bin beside an SDK generated from the docs' API,
 * the async SDK called from blocking code included, and every Rust block on a docs page is a verbatim excerpt of it
 * (bit 20).
 */
import { describe, expect, it } from "vitest"
import { allBlocks, exampleOf, strayExcerpts } from "../shared/__fixtures__/docs-blocks.ts"
import { compiledRust } from "./__fixtures__/compiled.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

const RUST = withRust()
const SLOW = { timeout: 600_000 }
const program = exampleOf("rust", "example.rs")

describe("the docs' Rust example", () => {
	it("is where every Rust block on a docs page comes from", () => {
		expect(strayExcerpts(allBlocks(), "rust", program)).toEqual([])
	})

	it("reports a Rust block the example does not hold", () => {
		const block = { at: "fixture.md:3", code: "let elsewhere = 1;\n", info: "rust" }
		expect(strayExcerpts([block], "rust", program)).toEqual(["fixture.md:3"])
	})

	// v0: 5db1548e11
	it.skipIf(!RUST)("builds against the generated SDK", SLOW, () => {
		const crate = compiledRust("docs", { programs: { example: program } })
		expect([crate.built, crate.built ? "" : crate.stderr]).toEqual([true, ""])
	})
})
