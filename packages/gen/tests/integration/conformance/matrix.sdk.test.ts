/**
 * The grid's SDK-only rows (bit 21 i0, features-sdk.ts), in the default run: they reach the six SDKs and no other
 * target, so the CLI and the MCP server keep exactly their cells, and every SDK holds the same four.
 */
import { describe, expect, it } from "vitest"
import { SDK_ROWS } from "./features-sdk.ts"
import { SDKS } from "./features.ts"
import { cellsFor, FEATURES, TARGETS } from "./matrix.ts"

const SDK_CELLS = ["decode/undecodable-2xx", "stream/initial-error", "stream/mid-drop", "transport/refused"]

/** The keys of `target`'s cells from the SDK-only rows, sorted. */
const sdkCellsOf = (target: (typeof TARGETS)[number]) =>
	cellsFor(target)
		.filter((cell) => SDK_ROWS.some((row) => row.id === cell.feature))
		.map((cell) => cell.key)
		.sort()

describe("the SDK-only rows", () => {
	it("are the grid's rows targeting the six SDKs alone", () => {
		expect(FEATURES.filter((f) => f.targets.join() === SDKS.join()).map((f) => f.id)).toEqual([
			"decode",
			"transport",
			"stream",
		])
		expect(SDK_ROWS.map((row) => row.id)).toEqual(["decode", "transport", "stream"])
	})

	it("give every SDK the same four cells and the CLI and the MCP server none", () => {
		expect(Object.fromEntries(TARGETS.map((target) => [target, sdkCellsOf(target)]))).toEqual({
			cli: [],
			csharp: SDK_CELLS,
			go: SDK_CELLS,
			java: SDK_CELLS,
			mcp: [],
			python: SDK_CELLS,
			rust: SDK_CELLS,
			ts: SDK_CELLS,
		})
	})
})
