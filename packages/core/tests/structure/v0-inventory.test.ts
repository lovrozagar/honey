import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { type Feature, FEATURES, unaccounted, type V0Case } from "./v0-inventory.ts"

const REPO = resolve(import.meta.dirname, "../../../..")

describe("FEATURES", () => {
	it("only names features a bit owns", () => {
		const bits = FEATURES.map((f) => f.slice(0, 2))
		expect(bits).toEqual([...bits].toSorted())
		expect(new Set(bits).size).toBe(bits.length)
	})
})

describe("unaccounted", () => {
	const cases: V0Case[] = [
		{ feature: "01-core-route-model", file: "a", id: "aaaaaaaaaa", name: "x" },
		{ feature: "01-core-route-model", file: "a", id: "bbbbbbbbbb", name: "y" },
		{ feature: "08-io", file: "b", id: "cccccccccc", name: "z" },
	]

	it("needs nothing before a feature's bit completes", () => {
		expect(unaccounted(cases, { complete: 0, ported: new Set(), retired: {} })).toEqual([])
	})

	it("lists the completed features' cases that are neither ported nor retired", () => {
		const ported = new Set(["aaaaaaaaaa"])
		expect(unaccounted(cases, { complete: 1, ported, retired: {} })).toEqual(["01-core-route-model bbbbbbbbbb y"])
		expect(unaccounted(cases, { complete: 1, ported, retired: { bbbbbbbbbb: "runtime removed" } })).toEqual([])
		expect(unaccounted(cases, { complete: 8, ported, retired: {} })).toEqual([
			"01-core-route-model bbbbbbbbbb y",
			"08-io cccccccccc z",
		])
	})

	it("follows a case a bit owner reassigned to another feature", () => {
		const reassigned = { bbbbbbbbbb: { feature: "08-io", reason: "asserts through input validation" } } as const
		expect(unaccounted(cases, { complete: 1, ported: new Set(["aaaaaaaaaa"]), reassigned, retired: {} })).toEqual([])
		expect(unaccounted(cases, { complete: 8, ported: new Set(["aaaaaaaaaa"]), reassigned, retired: {} })).toEqual([
			"08-io bbbbbbbbbb y",
			"08-io cccccccccc z",
		])
	})
})

describe("the committed inventory, frozen since _v0 went (bit 20 e)", () => {
	it("holds unique ids, each case under a feature a bit owns, and tallies that match its cases", () => {
		const committed = JSON.parse(readFileSync(join(REPO, "blueprint/baselines/v0-cases.json"), "utf8")) as {
			cases: V0Case[]
			features: Record<Feature, number>
		}
		const ids = committed.cases.map((c) => c.id)
		const tallies = Object.fromEntries(FEATURES.map((f) => [f, committed.cases.filter((c) => c.feature === f).length]))
		expect([
			new Set(ids).size === ids.length,
			committed.cases.filter((c) => !(FEATURES as readonly string[]).includes(c.feature)).map((c) => c.id),
			committed.features,
		]).toEqual([true, [], tallies])
	})
})
