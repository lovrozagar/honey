/**
 * The docs' Python example (docs/examples/python/example.py) type-checks under mypy --strict against an SDK generated
 * from the docs' API, and every Python block on a docs page is a verbatim excerpt of it (bit 20).
 */
import { describe, expect, it } from "vitest"
import { allBlocks, exampleOf, strayExcerpts } from "../shared/__fixtures__/docs-blocks.ts"
import { compiledPython } from "./__fixtures__/compiled.ts"
import { withPython } from "./__fixtures__/python-env.ts"

const PY = withPython()
const SLOW = { timeout: 600_000 }
const program = exampleOf("python", "example.py")

describe("the docs' Python example", () => {
	it("is where every Python block on a docs page comes from", () => {
		expect(strayExcerpts(allBlocks(), "python", program)).toEqual([])
	})

	it("reports a Python block the example does not hold", () => {
		const block = { at: "fixture.md:3", code: "elsewhere = 1\n", info: "python" }
		expect(strayExcerpts([block], "python", program)).toEqual(["fixture.md:3"])
	})

	// v0: cdb910286e
	it.skipIf(!PY)("type-checks against the generated SDK", SLOW, () => {
		expect(compiledPython("docs").check(program)).toEqual([])
	})
})
