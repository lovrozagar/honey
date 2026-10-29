/**
 * The Python target of the conformance grid (R1/G17): every `cellsFor("python")` cell through the package
 * `generatePythonSdk` emits from the spawned reference app's served document, gated once per content hash and
 * sent by the fixed reflection driver, one process per cell, `Observed[]` back. Four suites run the grid:
 * `AsyncSDK` at the pins; `SDK`, which has no method for the streams (G2, Fe1); `AsyncSDK` under the 3.11.4
 * floor with the floor constraints (Fe3); and `AsyncSDK` on the newest set the manifest's dependencies resolve
 * to online (Fe4). The safe variant (bit 21 i2, R-i6) runs `AsyncSDK`'s `client.safe` on one cell per response
 * kind, the driver reading each Result strictly, and its compile leg holds every operation's safe call on both
 * clients under mypy --strict. Opt-in: `vitest run --mode harness`.
 */
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { GateOptions } from "../../../src/emit/python/__fixtures__/compiled.ts"
import { type DrivenPythonSdk, servedPythonSdk } from "../../../src/emit/python/__fixtures__/driven.ts"
import { PY_FLOOR, resolve, withPython } from "../../../src/emit/python/__fixtures__/python-env.ts"
import type { PythonCallPlan } from "../../../src/emit/python/sdk-plan.ts"
import { generatePythonSdk, pythonCallPlans } from "../../../src/emit/python/sdk.ts"
import { originsOf, type ReferenceApp, SPAWN_TIMEOUT, type TargetRunner, targetSuite } from "./harness.ts"
import { type Cell, cellsFor, type Observed } from "./matrix.ts"
import { SAFE } from "./safe.ts"

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

/**
 * Whether `cell` reads an SSE, WebSocket or realtime stream (a stream's shape expected, or a call taking from one):
 * what `SDK` has no method for by design (G2).
 */
const streams = (cell: Cell): boolean =>
	cell.calls.some((call) => call.take !== undefined) ||
	cell.expect.some((shape) => {
		const kind = (shape as { readonly kind?: unknown } | null)?.kind
		return kind === "events" || kind === "frames"
	})

/** The keys of the grid's python cells that `keep` holds for, in grid order. */
const keysWhere = (keep: (cell: Cell) => boolean): string[] =>
	cellsFor("python")
		.filter(keep)
		.map((cell) => cell.key)

/** Which client a runner drives (its `safe` mirror when `safe`), under which gate, and how its suite is titled. */
type How = {
	readonly client: "async" | "sync"
	readonly safe?: boolean
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
			const ran = await sdk.runCalls(cell, originsOf(app), { client: how.client, safe: how.safe })
			if (ran.status !== 0) throw new Error(`driver exit ${ran.status}: ${ran.stderr}`)
			return ran.observed as readonly Observed[]
		},
		target: "python",
		...(how.titles === undefined ? {} : { titles: how.titles }),
		...(how.variant === undefined ? {} : { variant: how.variant }),
	}
}

/** The compile leg (R-i6 a): safeDriver over the safe suite's served SDK, clean under mypy, and not vacuous. */
function compileLeg(app: () => ReferenceApp) {
	describe("conformance × python (safe): every operation's safe call compiles", () => {
		const how = "type-checks each safe call against its normal twin and narrows it, on both clients"
		it(how, { timeout: SPAWN_TIMEOUT }, () => {
			const plans = Object.values(pythonCallPlans(app().document))
			const served = servedPythonSdk(app().document)
			const sse = plans.filter((plan) => plan.stream === "sse").length
			const connections = plans.filter((plan) => plan.stream === "ws" || plan.stream === "realtime").length
			expect({ calls: plans.length > 20, connections: connections > 0, streams: sse > 0 }).toEqual({
				calls: true,
				connections: true,
				streams: true,
			})
			expect(served.check(safeDriver(served.package, plans))).toEqual([])
		})
	})
}

/** One operation's lines in the compile leg's program, the `i`th. */
function safeOp(plan: PythonCallPlan, i: number): string[] {
	const path = [...plan.accessors, plan.method].join(".")
	const connection = plan.stream === "ws" || plan.stream === "realtime"
	const body = connection
		? [`    ident([a.safe.${path}], [a.${path}])`]
		: [
				`    same_async([a.safe.${path}], [a.${path}])`,
				`    narrow(await a.safe.${path}(*args, **kwargs))`,
				...(plan.sync
					? [`    same_sync([c.safe.${path}], [c.${path}])`, `    narrow(c.safe.${path}(*args, **kwargs))`]
					: []),
			]
	return ["", "", `async def op_${i}(a: sdk.AsyncSDK, c: sdk.SDK, *args: Any, **kwargs: Any) -> None:`, ...body]
}

/**
 * The compile leg's program (R-i6 a): for every operation, each client's safe twin held to its normal method by
 * `same` (the same parameters, and `Result[T]` of the very `T` the normal call answers: the lists make both exact) and
 * its answer narrowed by `match`, Ok's response a RawResponse, Err's error the base status error or DecodeError; a
 * connection the very same method on the mirror.
 */
function safeDriver(pkg: string, plans: readonly PythonCallPlan[]): string {
	return [
		"from collections.abc import Callable, Coroutine",
		"from typing import Any, ParamSpec, TypeVar, assert_type",
		"",
		`import ${pkg} as sdk`,
		"",
		'P = ParamSpec("P")',
		'T = TypeVar("T")',
		'R = TypeVar("R")',
		"",
		"",
		"def same_async(",
		"    safe: list[Callable[P, Coroutine[Any, Any, sdk.Result[T]]]], normal: list[Callable[P, Coroutine[Any, Any, T]]]",
		") -> None: ...",
		"",
		"",
		"def same_sync(safe: list[Callable[P, sdk.Result[T]]], normal: list[Callable[P, T]]) -> None: ...",
		"",
		"",
		"def ident(safe: list[Callable[P, R]], normal: list[Callable[P, R]]) -> None: ...",
		"",
		"",
		"def narrow(r: sdk.Result[T]) -> T | None:",
		"    match r:",
		"        case sdk.Ok(data, response):",
		"            assert_type(response, sdk.RawResponse)",
		"            return data",
		"        case sdk.Err(error, response):",
		"            assert_type(error, sdk.APIStatusError | sdk.DecodeError)",
		"            assert_type(response, sdk.RawResponse)",
		"            return None",
		...plans.flatMap(safeOp),
		"",
	].join("\n")
}

/** The committed floor constraints, as the floor gate installs them. */
const FLOOR_CONSTRAINTS = new URL("../../../src/emit/python/__fixtures__/constraints-floor.txt", import.meta.url)

/** The lines of a constraints text that pin the direct dependency and the transport it is built on. */
const direct = (text: string): string[] => text.split("\n").filter((line) => /^(?:httpx2|httpcore2)==/.test(line))

describe.skipIf(!PY)("python toolchain", () => {
	targetSuite(pythonRunner({ client: "async", titles: V0_PORTS }))
	targetSuite(pythonRunner({ client: "sync", variant: "SDK" }))
	const safe = targetSuite(pythonRunner({ client: "async", safe: true, variant: SAFE }))

	compileLeg(safe)

	/*
	 * format.test.ts imports the omnibus under the floor; this suite runs the served SDK's every cell there,
	 * so httpx2 2.12.0's own behavior on the app's wire is pinned: the cross-origin strip, SSE, the WebSocket
	 * upgrade. The floor resolve fails when the floor the manifest declares no longer resolves to the
	 * committed floor constraints (a yanked or unresolvable floor).
	 */
	describe.skipIf(!FLOOR)("python 3.11.4 floor", () => {
		const floor = targetSuite(pythonRunner({ client: "async", python: "floor", variant: "floor 3.11.4" }))

		it("the floor constraints resolve today as committed", { timeout: SPAWN_TIMEOUT }, () => {
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
				"json-status/realtime-send-non-ascii",
				"json-status/realtime-send-raw-text",
				"sse/typed-events",
				"reconnect/sse-last-event-id",
				"reconnect/ws-reconnect-token",
				"reconnect/sse-from-start",
				"reconnect/refusal-terminal",
				"reconnect/refusal-mixed-retries",
				"stream/initial-error",
				"stream/mid-drop",
			])
		})
	})
})
