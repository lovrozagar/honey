/**
 * Every Rust block on a docs page is a verbatim excerpt of the docs' Rust example (bit 20). The example itself builds
 * and runs in harness mode (tests/integration/rust-harness.examples.test.ts), an executed SDK as bit 13 placed them,
 * so the default run's Rust budget holds.
 */
import { describe, expect, it } from "vitest"
import { allBlocks, exampleOf, strayExcerpts } from "../shared/__fixtures__/docs-blocks.ts"

const program = exampleOf("rust", "example.rs")

describe("the docs' Rust example", () => {
	it("is where every Rust block on a docs page comes from", () => {
		expect(strayExcerpts(allBlocks(), "rust", program)).toEqual([])
	})

	it("reports a Rust block the example does not hold", () => {
		const block = { at: "fixture.md:3", code: "let elsewhere = 1;\n", info: "rust" }
		expect(strayExcerpts([block], "rust", program)).toEqual(["fixture.md:3"])
	})
})
