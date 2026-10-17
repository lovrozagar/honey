/**
 * The Python target of the conformance grid (R1/G17): every `cellsFor("python")` cell through the package
 * `generatePythonSdk` emits from the spawned reference app's served document, gated once per content hash and
 * sent by the fixed reflection driver, one process per cell, `Observed[]` back. Four suites run the grid:
 * `AsyncSDK` at the pins; `SDK`, which has no method for the streams (G2, Fe1); `AsyncSDK` under the 3.11.4
 * floor with the floor constraints (Fe3); and `AsyncSDK` on the newest set the manifest's dependencies resolve
 * to online (Fe4). Opt-in: `vitest run --mode harness`.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { GateOptions } from "../../../src/emit/python/__fixtures__/compiled.ts"
import { type DrivenPythonSdk, servedPythonSdk } from "../../../src/emit/python/__fixtures__/driven.ts"
import { PY_FLOOR, resolve, withPython } from "../../../src/emit/python/__fixtures__/python-env.ts"
import { generatePythonSdk, pythonCallPlans } from "../../../src/emit/python/sdk.ts"
import { type TargetRunner, targetSuite } from "./harness.ts"
import { type Cell, cellsFor, type Observed } from "./matrix.ts"

const PY = withPython()
const FLOOR = withPython(PY_FLOOR)

/**
 * Each titled cell's v0 port: the suite names its `it` `<key> (<title>)`. The reference request is
 * 0b64837f4e's live half; its URL vectors are pinned in emit/python/http.test.ts (path params, the base URL,
 * the refused dot segments) and its SSE vectors in emit/python/sse.parse.test.ts.
 */
const V0_PORTS: Readonly<Record<string, string>> = {
	// v0: 0b64837f4e
	"verbs/reference-request": "v0 0b64837f4e",
}

/** Whether `cell` reads an SSE or WebSocket stream: what `SDK` has no method for by design (G2). */
const streams = (cell: Cell): boolean =>
	cell.expect.some((shape) => {
		const kind = (shape as { readonly kind?: unknown } | null)?.kind
		return kind === "events" || kind === "frames"
	})

/** The keys of the grid's python cells that `keep` holds for, in grid order. */
const keysWhere = (keep: (cell: Cell) => boolean): string[] =>
	cellsFor("python")
		.filter(keep)
		.map((cell) => cell.key)

/** Which client a runner drives, under which gate, and how its suite is titled. */
type How = {
	readonly client: "async" | "sync"
	readonly python?: GateOptions["python"]
	readonly titles?: Readonly<Record<string, string>>
	readonly variant?: string
}

/**
 * The Python runner: the served SDK gated once, imported, and mypy-clean under MYPY_FLAGS (whose
 * `--python-version 3.11` makes it the static floor too) everywhere but the floor suite, which gates on the
 * import alone (Fe2). `SDK`'s runner drops the stream cells, and its prepare cross-checks them against the
 * emitter's plans, so a fifth cell without a sync method is never dropped silently. A cell the driver cannot
 * express exits non-zero with the reason on stderr, and the runner throws it: the cell is red, never skipped.
 */
function pythonRunner(how: How): TargetRunner {
	let sdk: DrivenPythonSdk | undefined
	const sync = how.client === "sync"
	return {
		...(sync ? { lacks: streams } : {}),
		async prepare(app) {
			const served = servedPythonSdk(app.document, { python: how.python ?? "pin" })
			if (!served.imported) throw new Error(served.stderr)
			if (how.python !== "floor") {
				const findings = served.mypy()
				if (findings.length > 0) throw new Error(findings.join("\n"))
			}
			if (sync) {
				const plans = pythonCallPlans(app.document)
				const unsynced = keysWhere((cell) => cell.calls.some((call) => plans[call.operation]?.sync === false))
				expect(keysWhere(streams), "SDK drops exactly the cells whose plans have no sync method").toEqual(unsynced)
			}
			sdk = served
		},
		async run(cell, app) {
			if (sdk === undefined) throw new Error("the Python runner ran a cell before prepare")
			const ran = await sdk.runCalls(cell, { alt: app.alt, url: app.url }, { client: how.client })
			if (ran.status !== 0) throw new Error(`driver exit ${ran.status}: ${ran.stderr}`)
			return ran.observed as readonly Observed[]
		},
		target: "python",
		...(how.titles === undefined ? {} : { titles: how.titles }),
		...(how.variant === undefined ? {} : { variant: how.variant }),
	}
}

/** The committed floor constraints, as the floor gate installs them. */
const FLOOR_CONSTRAINTS = new URL("../../../src/emit/python/__fixtures__/constraints-floor.txt", import.meta.url)

/** The lines of a constraints text that pin the direct dependency and the transport it is built on. */
const direct = (text: string): string[] => text.split("\n").filter((line) => /^(?:httpx2|httpcore2)==/.test(line))

describe.skipIf(!PY)("python toolchain", () => {
	targetSuite(pythonRunner({ client: "async", titles: V0_PORTS }))
	targetSuite(pythonRunner({ client: "sync", variant: "SDK" }))

	/*
	 * format.test.ts imports the omnibus under the floor; this suite runs the served SDK's every cell there,
	 * so httpx2 2.12.0's own behavior on the app's wire is pinned: the cross-origin strip, SSE, the WebSocket
	 * upgrade. The floor resolve fails when the floor the manifest declares no longer resolves to the
	 * committed floor constraints (a yanked or unresolvable floor).
	 */
	describe.skipIf(!FLOOR)("python 3.11.4 floor", () => {
		const floor = targetSuite(pythonRunner({ client: "async", python: "floor", variant: "floor 3.11.4" }))

		it("the floor constraints resolve today as committed", () => {
			const manifest = generatePythonSdk(floor().document).files["pyproject.toml"] ?? ""
			const requirements = JSON.parse(/^dependencies = (\[.*\])$/m.exec(manifest)?.[1] ?? "[]") as string[]
			const resolved = resolve(requirements, { python: PY_FLOOR, resolution: "lowest-direct" })
			const committed = direct(readFileSync(FLOOR_CONSTRAINTS, "utf8"))
			expect({ committed: committed.length, resolved: direct(resolved) }).toEqual({ committed: 2, resolved: committed })
		})
	})

	/*
	 * The drift canary (Fe4): the pinned interpreter with the newest set the manifest's dependencies allow,
	 * resolved online at gate time. While it equals constraints.txt the gate is the pins' cache hit; it goes
	 * red only when a newer allowed set breaks a cell or mypy, a break consumers would hit.
	 */
	targetSuite(pythonRunner({ client: "async", python: "newest", variant: "newest httpx2" }))

	describe("conformance × python titles and lacks", () => {
		it("titles only cells the grid holds for python", () => {
			const keys = new Set(cellsFor("python").map((cell) => cell.key))
			expect(Object.keys(V0_PORTS).filter((key) => !keys.has(key))).toEqual([])
		})

		it("SDK lacks exactly the stream cells", () => {
			expect(keysWhere(streams)).toEqual([
				"sse/typed-events",
				"reconnect/sse-last-event-id",
				"reconnect/ws-reconnect-token",
				"reconnect/sse-from-start",
			])
		})
	})
})
