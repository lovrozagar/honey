/**
 * The lose-nothing gate (H13): every v0 case of a feature whose bit has completed is either ported
 * (a v1 test carries `// v0: <id>`) or retired with a reason in the inventory. At bit 20, before
 * `_v0` is deleted, that covers every feature, so nothing v0 tested goes unaccounted.
 */
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { COMPLETE } from "./check-tree.ts"
import { type Reassignment, unaccounted, type V0Case } from "./v0-inventory.ts"

const REPO = resolve(import.meta.dirname, "../../../..")
const V1_ROOTS = [
	"packages/core/src",
	"packages/core/tests",
	"packages/core/lint",
	"packages/gen/src",
	"packages/gen/tests",
]
const TAG = /\/\/ v0: ([0-9a-f]{10})\b/g

type Inventory = { cases: V0Case[]; reassigned: Record<string, Reassignment>; retired: Record<string, string> }

const inventory = JSON.parse(readFileSync(join(REPO, "blueprint/baselines/v0-cases.json"), "utf8")) as Inventory
const known = new Set(inventory.cases.map((c) => c.id))

function portedIds(): Set<string> {
	const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "--", ...V1_ROOTS], {
		cwd: REPO,
		encoding: "utf8",
	})
		.split("\n")
		.filter((f) => f.endsWith(".ts"))
	return new Set(
		files.flatMap((f) => [...readFileSync(join(REPO, f), "utf8").matchAll(TAG)].map((m) => m[1] as string)),
	)
}

describe(`v0 cases accounted for through bit ${String(COMPLETE).padStart(2, "0")}`, () => {
	it("knows which bit construction has completed", () => {
		/* a missing constant would make every comparison below false and the gate vacuous */
		expect(Number.isInteger(COMPLETE)).toBe(true)
	})

	it("every port tag names a real v0 case", () => {
		expect([...portedIds()].filter((id) => !known.has(id))).toEqual([])
	})

	it("every retirement and reassignment names a real v0 case", () => {
		const listed = [...Object.keys(inventory.retired), ...Object.keys(inventory.reassigned)]
		expect(listed.filter((id) => !known.has(id))).toEqual([])
	})

	it("every case of a completed feature is ported or retired", () => {
		const accounting = {
			complete: COMPLETE,
			ported: portedIds(),
			reassigned: inventory.reassigned,
			retired: inventory.retired,
		}
		expect(unaccounted(inventory.cases, accounting)).toEqual([])
	})
})
