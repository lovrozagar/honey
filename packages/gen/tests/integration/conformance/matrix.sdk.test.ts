/**
 * The grid's SDK-only rows (bit 21 i0, features-sdk.ts), in the default run: they reach the six SDKs and no other
 * target, so the CLI and the MCP server keep exactly their cells, and every SDK holds the same five; the over-cap row
 * (i2, go since i3, rust since i4, csharp since i5) reaches OVER_CAP_SDKS alone, until i7 has it at all six.
 */
import { describe, expect, it } from "vitest"
import { OVER_CAP_SDKS, SDK_ROWS } from "./features-sdk.ts"
import { SDKS } from "./features.ts"
import { cellsFor, FEATURES, TARGETS } from "./matrix.ts"

const SDK_CELLS = [
	"decode/undecodable-2xx",
	"stream/initial-error",
	"stream/mid-drop",
	"text/plain",
	"transport/refused",
]

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
			"text",
		])
		expect(SDK_ROWS.map((row) => row.id)).toEqual(["decode", "transport", "stream", "text", "over-cap"])
	})

	it("give every SDK the same five cells, OVER_CAP_SDKS the over-cap one too, and the CLI and the MCP server none", () => {
		const capped = [...SDK_CELLS, "over-cap/over-cap-2xx"].sort()
		expect(OVER_CAP_SDKS).toEqual(["ts", "python", "go", "rust", "csharp"])
		expect(Object.fromEntries(TARGETS.map((target) => [target, sdkCellsOf(target)]))).toEqual({
			cli: [],
			csharp: capped,
			go: capped,
			java: SDK_CELLS,
			mcp: [],
			python: capped,
			rust: capped,
			ts: capped,
		})
	})
})
