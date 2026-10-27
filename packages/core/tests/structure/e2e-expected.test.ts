import { describe, expect, it } from "vitest"
import { type ExpectedSet, mismatches, type Outcomes } from "../e2e/expected.ts"

const cell = (passed: string[], failed: string[] = [], skipped: string[] = []): Outcomes => ({
	failed,
	passed,
	skipped,
})

const EXPECTED: ExpectedSet = {
	cells: {
		"bun/dev/kitchen": cell(["a > one", "a > two"]),
		"bun/prod/kitchen": cell(["a > one", "a > two", "a > @prod-only bundle"]),
		"cf/prod/kitchen": { capturedBy: "CI's cf-prod job (j3)" },
	},
}

describe("the e2e expected set holds every cell a run ran (j2)", () => {
	it("passes a run whose cells match, and leaves a CI-captured cell to CI", () => {
		expect(
			mismatches(EXPECTED, {
				"bun/dev/kitchen": cell(["a > one", "a > two"]),
				"bun/prod/kitchen": cell(["a > one", "a > two", "a > @prod-only bundle"]),
			}),
		).toEqual([])
	})

	it("fails one mismatched cell by its name, with the tests that moved", () => {
		expect(
			mismatches(EXPECTED, {
				"bun/dev/kitchen": cell(["a > one"], ["a > two"]),
				"bun/prod/kitchen": cell(["a > one", "a > two", "a > @prod-only bundle"]),
			}),
		).toEqual(["bun/dev/kitchen: passed lacks [a > two]; failed gains [a > two]"])
	})

	it("fails a test that appears or disappears, and a cell the set does not hold", () => {
		expect(
			mismatches(EXPECTED, {
				"bun/dev/kitchen": cell(["a > one", "a > two", "a > three"]),
				"node/dev/kitchen": cell(["a > one"]),
			}),
		).toEqual(["bun/dev/kitchen: passed gains [a > three]", "node/dev/kitchen: not in the expected set"])
	})
})
