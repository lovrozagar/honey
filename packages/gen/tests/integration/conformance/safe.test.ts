/**
 * The safe variant's coverage (bit 21 i0, R-i6 c): the response kinds come from the grid's own cells, a safe variant
 * runs one cell per kind, and an enabled language whose safe variant leaves a kind uncovered reds. i1 enables TS, i2 Python, so
 * the real leg holds over it; the synthetic legs prove it reds for a language missing a kind.
 */
import { describe, expect, it } from "vitest"
import { SDKS } from "./features.ts"
import { OVER_CAP_SDKS } from "./features-sdk.ts"
import { type Cell, cellsFor, FEATURES } from "./matrix.ts"
import {
	responseKindOf,
	responseKinds,
	SAFE_ENABLED,
	type Sdk,
	safeCellsFor,
	safeCoverageProblems,
	safeSelection,
} from "./safe.ts"

const keysOf = (cells: readonly Cell[]) => cells.map((cell) => cell.key)

/** Whether `sdk`'s over-cap 2xx is its decode error yet (bit 21 i2): the over-cap row reaches it. */
const capped = (sdk: Sdk) => (OVER_CAP_SDKS as readonly Sdk[]).includes(sdk)

describe("response kinds, derived from features.ts", () => {
	it("are the grid's 17 distinct answers, in grid order", () => {
		expect([...responseKinds(cellsFor("ts")).keys()]).toEqual([
			"json",
			"empty",
			"frames",
			"error 404",
			"error 400",
			"error 409",
			"binary",
			"events",
			"realtime refusal 403",
			"timeout",
			"raw",
			"decode",
			"transport",
			"stream open error 403",
			"events failed transport",
			"text",
			"decode over cap",
		])
	})

	it("are the same for every SDK: the six run one grid, the over-cap kind on OVER_CAP_SDKS alone (i2)", () => {
		const kinds = (sdk: Sdk) => [...responseKinds(cellsFor(sdk)).keys()]
		for (const sdk of SDKS)
			expect(kinds(sdk), sdk).toEqual(kinds("ts").filter((kind) => capped(sdk) || kind !== "decode over cap"))
	})

	it("follow the cells, with no list to edit: the text row is the text kind, and without it there is none", () => {
		const kindsOf = (cells: readonly Cell[]) => [...responseKinds(cells).keys()]
		expect(
			responseKinds(cellsFor("ts"))
				.get("text")
				?.map((cell) => cell.key),
		).toEqual(["text/plain"])
		expect(kindsOf(cellsFor("ts").filter((cell) => cell.feature !== "text"))).not.toContain("text")
	})

	it("refuse an answer no SDK gives: a CLI's or an MCP read's", () => {
		const foreign = FEATURES.filter((feature) => !feature.targets.some((t) => (SDKS as readonly string[]).includes(t)))
		expect(foreign.length).toBeGreaterThan(0)
		for (const feature of foreign)
			expect(() => responseKindOf(feature.scenarios[0] as Cell, 0)).toThrow(/no SDK answers/)
	})
})

describe("the safe selection", () => {
	it("holds every kind, with no more cells than kinds", () => {
		const { cells, uncovered } = safeSelection(cellsFor("go"))
		expect(uncovered).toEqual([])
		const covered = new Set(cells.flatMap((cell) => cell.calls.map((_, i) => responseKindOf(cell, i))))
		expect([...covered].sort()).toEqual([...responseKinds(cellsFor("go")).keys()].sort())
		expect(cells.length).toBeLessThanOrEqual(responseKinds(cellsFor("go")).size)
	})

	it("names a kind uncovered when the runner lacks every cell holding it", () => {
		const lacks = (cell: Cell) => cell.feature === "decode"
		const { cells, uncovered } = safeSelection(cellsFor("python"), lacks)
		expect(uncovered).toEqual(["decode"])
		expect(keysOf(cells)).not.toContain("decode/undecodable-2xx")
	})

	it("runs no cell for a language its phase has not enabled", () => {
		for (const sdk of SDKS.filter((s) => !SAFE_ENABLED.has(s)))
			expect(safeCellsFor(sdk)).toEqual({ cells: [], uncovered: [] })
	})
})

describe("every enabled language's safe variant covers every kind", () => {
	/* i1 enables TS and i2 Python; every phase after adds its language */
	it.each(["ts", "python"] as const)("holds for SAFE_ENABLED, %s among it with one cell per kind", (sdk) => {
		expect(safeCoverageProblems(SAFE_ENABLED)).toEqual([])
		const { cells, uncovered } = safeCellsFor(sdk)
		const kinds = new Set(cells.flatMap((cell) => cell.calls.map((_, i) => responseKindOf(cell, i))))
		expect([SAFE_ENABLED.has(sdk), uncovered, kinds.size, cells.length]).toEqual([true, [], 17, 17])
	})

	it("reds a synthetic enabled language missing a kind", () => {
		const lacksOf = (target: string) => (target === "rust" ? (cell: Cell) => cell.feature === "stream" : undefined)
		expect(safeCoverageProblems(new Set<Sdk>(["rust", "java"]), lacksOf)).toEqual([
			"rust: no safe cell answers stream open error 403",
			"rust: no safe cell answers events failed transport",
		])
	})

	it("reds a synthetic enabled language whose safe variant lacks the text cell", () => {
		const lacksOf = (target: string) => (target === "go" ? (cell: Cell) => cell.key === "text/plain" : undefined)
		expect(safeCoverageProblems(new Set<Sdk>(["go"]), lacksOf)).toEqual(["go: no safe cell answers text"])
	})

	it("passes every SDK enabled with nothing lacked: the grid itself has a cell per kind", () => {
		expect(safeCoverageProblems(new Set(SDKS))).toEqual([])
	})
})
