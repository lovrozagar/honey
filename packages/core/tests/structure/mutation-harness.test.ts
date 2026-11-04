import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { CHILD_FLAGS, GUARDS, guardNamed, runSuite, survivors } from "./mutation-harness.ts"
import { runVitest } from "./suite-run.ts"

const POOLS = resolve(import.meta.dirname, "fixtures/pools")

describe("the guard registry", () => {
	it("names each guard once, with the module it lives in", () => {
		const ids = GUARDS.map((g) => g.id)
		expect(new Set(ids).size).toBe(ids.length)
		expect(guardNamed("v1-encoded-separator")).toMatchObject({ module: "packages/core/src/routing/request-path.ts" })
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

describe("the suite's child run", () => {
	it("holds at most four forks at once, so a coverage run that runs the harness does not double its own", () => {
		const pools = runVitest(POOLS, CHILD_FLAGS, process.env).failures.map((f) =>
			Number(/expected '(\d+)'/.exec(f)?.[1]),
		)
		expect(pools).toHaveLength(8)
		expect(Math.max(...pools)).toBeLessThanOrEqual(4)
	}, 60_000)
})

describe("the adversarial suite against each guard", () => {
	it("passes with every guard in place", () => {
		expect(runSuite(undefined)).toEqual({ failures: [], status: 0 })
	}, 60_000)

	it.each(GUARDS.map((g) => g.id))(
		"goes red with the %s guard disabled",
		(id) => {
			expect(runSuite(id).status).not.toBe(0)
		},
		60_000,
	)
})
