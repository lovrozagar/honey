/**
 * The Go target of the conformance grid (R1/G11): every `cellsFor("go")` cell through the SDK
 * `generateGoSdk` emits from the spawned reference app's served document, compiled once per content
 * hash with the test driver beside it and sent by it, one process per cell, `Observed[]` back. That
 * SDK also builds and vets under the go 1.24 floor toolchain. Opt-in: `vitest run --mode harness`.
 */
import { describe, expect, it } from "vitest"
import { compileGo, compiledSdk, type DrivenSdk } from "../../../src/emit/go/__fixtures__/compiled.ts"
import { GO_FLOOR, withGo } from "../../../src/emit/go/__fixtures__/go-env.ts"
import { generateGoSdk } from "../../../src/emit/go/sdk.ts"
import { originsOf, safeVariant, type TargetRunner, targetSuite } from "./harness.ts"
import { cellsFor, type Observed } from "./matrix.ts"

/* the module path both Go harness files compile the conformance SDK under, so they share one cache dir */
const MODULE = "example.com/conformance"

/** Each titled cell's v0 port: the suite names its `it` `<key> (<title>)`. */
const V0_PORTS: Readonly<Record<string, string>> = {
	// v0: 4ac6a2896c
	"verbs/reference-request": "v0 4ac6a2896c",
}

/**
 * The Go runner: the SDK and the driver built and vetted once from the served document. A cell the
 * driver cannot express exits non-zero with the reason on stderr, and the runner throws it: the
 * cell is red, never skipped.
 */
function goRunner(): TargetRunner {
	let sdk: DrivenSdk | undefined
	return {
		async prepare(app) {
			const compiled = compiledSdk(app.document, { modulePath: MODULE })
			if (!compiled.built || compiled.vet.length > 0) throw new Error(`${compiled.stderr}${compiled.vet.join("\n")}`)
			sdk = compiled
		},
		async run(cell, app) {
			if (sdk === undefined) throw new Error("the Go runner ran a cell before prepare")
			const ran = await sdk.runCalls(cell, originsOf(app))
			if (ran.status !== 0) throw new Error(`driver exit ${ran.status}: ${ran.stderr}`)
			return ran.observed as readonly Observed[]
		},
		target: "go",
		titles: V0_PORTS,
	}
}

describe.skipIf(!withGo())("go toolchain", () => {
	const app = targetSuite(goRunner())
	targetSuite(safeVariant(goRunner(), "i3"))

	describe("conformance × go titles", () => {
		it("titles only cells the grid holds for go", () => {
			const keys = new Set(cellsFor("go").map((cell) => cell.key))
			expect(Object.keys(V0_PORTS).filter((key) => !keys.has(key))).toEqual([])
		})
	})

	/*
	 * format.test.ts compiles every runtime file under the floor; this leg adds the conformance SDK's
	 * own client.go and types.go there: error-only methods, binary in and out, form and text bodies,
	 * typed response headers, error envelopes. The served document is the one fetched at start.
	 */
	describe("go 1.24 floor", () => {
		it("builds and vets the conformance SDK clean under the floor toolchain itself", () => {
			const files = generateGoSdk(app().document, { modulePath: MODULE }).files
			const floor = compileGo(files, { toolchain: GO_FLOOR })
			expect({ built: floor.built, vet: floor.vet }, floor.stderr).toEqual({ built: true, vet: [] })
		}, 600_000)
	})
})
