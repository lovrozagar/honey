/**
 * The Rust target of the conformance grid (R1/G11): every `cellsFor("rust")` cell through the SDK
 * `generateRustSdk` emits from the spawned reference app's served document, compiled once per content
 * hash with the test driver beside it and sent by it, one process per cell, `Observed[]` back. That
 * crate also builds clippy-clean at the pin and checks under the rust 1.85.0 floor toolchain. Opt-in:
 * `vitest run --mode harness`.
 */
import { describe, expect, it } from "vitest"
import { type DrivenRustSdk, servedRustSdk } from "../../../src/emit/rust/__fixtures__/driven.ts"
import { RUST_FLOOR, withRust } from "../../../src/emit/rust/__fixtures__/rust-env.ts"
import { type TargetRunner, targetSuite } from "./harness.ts"
import { cellsFor, type Observed } from "./matrix.ts"

const RUST = withRust()
const FLOOR = withRust(RUST_FLOOR)

/**
 * Each titled cell's v0 port: the suite names its `it` `<key> (<title>)`. The reference request is
 * 3d0dbca04b's live half; its URL vectors are pinned in emit/rust/http.test.ts (path params, the base
 * URL) and its SSE vectors in emit/rust/sse.parse.test.ts.
 */
const V0_PORTS: Readonly<Record<string, string>> = {
	// v0: 3d0dbca04b
	"verbs/reference-request": "v0 3d0dbca04b",
}

/**
 * The Rust runner: the SDK and the driver built once from the served document, and the SDK clippy-clean
 * at the pin (Fe2). A cell the driver cannot express exits non-zero with the reason on stderr, and the
 * runner throws it: the cell is red, never skipped. A cold dependency build runs past the harness
 * hookTimeout, so prepare gets the Rust unit tests' 10 minutes (Fe3).
 */
function rustRunner(): TargetRunner {
	let sdk: DrivenRustSdk | undefined
	return {
		async prepare(app) {
			const compiled = servedRustSdk(app.document)
			if (!compiled.built) throw new Error(compiled.stderr)
			const lint = compiled.clippy()
			if (lint.length > 0) throw new Error(lint.join("\n"))
			sdk = compiled
		},
		prepareTimeoutMs: 600_000,
		async run(cell, app) {
			if (sdk === undefined) throw new Error("the Rust runner ran a cell before prepare")
			const ran = await sdk.runCalls(cell, { alt: app.alt, url: app.url })
			if (ran.status !== 0) throw new Error(`driver exit ${ran.status}: ${ran.stderr}`)
			return ran.observed as readonly Observed[]
		},
		target: "rust",
		titles: V0_PORTS,
	}
}

describe.skipIf(!RUST)("rust toolchain", () => {
	const app = targetSuite(rustRunner())

	describe("conformance × rust titles", () => {
		it("titles only cells the grid holds for rust", () => {
			const keys = new Set(cellsFor("rust").map((cell) => cell.key))
			expect(Object.keys(V0_PORTS).filter((key) => !keys.has(key))).toEqual([])
		})
	})

	/*
	 * format.test.ts checks every runtime file under the floor; this leg adds the conformance crate's own
	 * client.rs, resources and types.rs there: error-only methods, binary in and out, form and text bodies,
	 * typed response headers, ws.echo's query. The served document is the one fetched at start, as is.
	 */
	describe("rust 1.85 floor", () => {
		it.skipIf(!FLOOR)(
			"checks the conformance SDK clean under the floor toolchain itself",
			() => {
				const floor = servedRustSdk(app().document, { check: true, toolchain: RUST_FLOOR })
				expect(floor.built, floor.stderr).toBe(true)
			},
			600_000,
		)
	})
})
