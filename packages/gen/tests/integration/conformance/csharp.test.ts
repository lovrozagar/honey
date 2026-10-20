/**
 * The C# target of the conformance grid (R1/G17): every `cellsFor("csharp")` cell through the SDK
 * `generateCSharpSdk` emits from the spawned reference app's served document, built once per content hash and
 * format-clean, and sent by the fixed reflection driver, one process per cell, `Observed[]` back. C# has one
 * client, one SDK pin and no dependency to drift, so the file holds no variant, floor or drift suite (bits/15).
 * Opt-in: `vitest run --mode harness`.
 */
import { describe } from "vitest"
import { type DrivenCSharpSdk, servedCSharpSdk } from "../../../src/emit/csharp/__fixtures__/driven.ts"
import { withDotnet } from "../../../src/emit/csharp/__fixtures__/csharp-env.ts"
import { type TargetRunner, targetSuite } from "./harness.ts"
import type { Observed } from "./matrix.ts"

const DOTNET = withDotnet()

/* ported: rust.test.ts:33-53, python.test.ts:59-88 (the runner); the grid is shared */
/**
 * The C# runner: the SDK built once from the served document, under warnings as errors, nullable and the trim/AOT
 * analyzers, and `dotnet format`-clean (Fe1). A cell the driver cannot express exits non-zero with the reason on
 * stderr, and the runner throws it: the cell is red, never skipped. A cold prepare fits the default hook timeout.
 */
function csharpRunner(): TargetRunner {
	let sdk: DrivenCSharpSdk | undefined
	return {
		async prepare(app) {
			const served = servedCSharpSdk(app.document)
			if (!served.built) throw new Error(served.diagnostics.join("\n"))
			const findings = served.format()
			if (findings.length > 0) throw new Error(findings.join("\n"))
			sdk = served
		},
		async run(cell, app) {
			if (sdk === undefined) throw new Error("the C# runner ran a cell before prepare")
			const ran = await sdk.runCalls(cell, { alt: app.alt, url: app.url })
			if (ran.status !== 0) throw new Error(`driver exit ${ran.status}: ${ran.stderr}`)
			return ran.observed as readonly Observed[]
		},
		target: "csharp",
	}
}

describe.skipIf(!DOTNET)("csharp toolchain", () => {
	targetSuite(csharpRunner())
})
