import { describe, expect, it } from "vitest"
import { GUARDS, guardNamed, runSuite, survivors } from "./mutation-harness.ts"

/* the suite reruns whole, its fuzz included, once per guard */
const RUN = 180_000

describe("the gen guard registry", () => {
	it("names each guard once, with the gen module it lives in", () => {
		const ids = GUARDS.map((g) => g.id)
		expect(new Set(ids).size).toBe(ids.length)
		expect(GUARDS.every((g) => g.module.startsWith("packages/gen/src/"))).toBe(true)
		expect(guardNamed("escape-bypass")).toMatchObject({ module: "packages/gen/src/emit/shared/escape.ts" })
	})

	it("runs the plain suite when no mutant is named, and refuses one it does not know", () => {
		expect([guardNamed(undefined), guardNamed("")]).toEqual([undefined, undefined])
		expect(() => guardNamed("escape-bypas")).toThrow(/unknown guard "escape-bypas"/)
	})

	it("lists the guards whose removal left the suite green", () => {
		expect(
			survivors([
				{ id: "a", status: 1 },
				{ id: "b", status: 0 },
			]),
		).toEqual(["b"])
	})
})

describe("the emit adversarial suite against each guard", () => {
	it(
		"passes with every guard in place",
		() => {
			expect(runSuite(undefined)).toBe(0)
		},
		RUN,
	)

	it.each(GUARDS.map((g) => g.id))(
		"goes red with the %s guard disabled",
		(id) => {
			expect(runSuite(id)).not.toBe(0)
		},
		RUN,
	)
})
