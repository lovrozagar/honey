import { describe, expect, it } from "vitest"
import { GUARDS, guardNamed, runSuite, survivors } from "./mutation-harness.ts"

describe("the guard registry", () => {
	it("names each guard once, with the module it lives in", () => {
		const ids = GUARDS.map((g) => g.id)
		expect(new Set(ids).size).toBe(ids.length)
		expect(guardNamed("encoded-separator")).toMatchObject({ module: "_v0/src/request-path.ts" })
	})

	it("runs the plain suite when no mutant is named", () => {
		expect(guardNamed(undefined)).toBeUndefined()
		expect(guardNamed("")).toBeUndefined()
	})

	it("refuses a mutant it does not know, so a typo never runs the plain suite", () => {
		expect(() => guardNamed("encoded-seperator")).toThrow(/unknown guard "encoded-seperator"/)
	})
})

describe("survivors", () => {
	it("lists the guards whose removal left the suite green", () => {
		expect(
			survivors([
				{ id: "a", status: 1 },
				{ id: "b", status: 0 },
				{ id: "c", status: 1 },
			]),
		).toEqual(["b"])
	})
})

describe("the adversarial suite against each guard", () => {
	it("passes with every guard in place", () => {
		expect(runSuite(undefined)).toBe(0)
	}, 60_000)

	it("goes red with the encoded-separator guard disabled", () => {
		expect(runSuite("encoded-separator")).not.toBe(0)
	}, 60_000)
})
