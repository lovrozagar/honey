/**
 * The safe variant's cells (bit 21 i, R-i6 b/c): one cell per distinct response kind the grid has, the kinds derived
 * from the grid's own cell definitions (features.ts), never hand-listed. A language's safe variant runs once its phase
 * enables it here (i1 TS ... i6 Java); until then it runs no cell, and the coverage leg holds it vacuously.
 */
import { SDKS } from "./features.ts"
import { type Call, type Cell, cellsFor, type Expected, type Scenario } from "./matrix.ts"

export type Sdk = (typeof SDKS)[number]

/** The variant name a target's safe-style runner carries (TargetRunner.variant). */
export const SAFE = "safe"

/** The SDKs whose safe variant runs: each of i1–i6 added its language, so all six run it. */
export const SAFE_ENABLED: ReadonlySet<Sdk> = new Set<Sdk>(["ts", "python", "go", "rust", "csharp", "java"])

/**
 * Whether a runner's `variant` is the safe style: SAFE itself, or SAFE on one of the target's other axes, titled
 * `safe <axis>` (Java's `safe JDK 17`: the safe style on every JDK the grid runs, bit 21 i6).
 */
export const isSafeVariant = (variant: string | undefined): boolean =>
	variant === SAFE || variant?.startsWith(`${SAFE} `) === true

/** An expectation as a record of its members, or null for one that is no record (a matcher list, a literal). */
const recordOf = (value: Expected | undefined): Readonly<Record<string, unknown>> | null =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: null

type Expectation = Readonly<Record<string, unknown>>

/** A data answer's kind by its body: none (a 204 or null), text, or JSON. */
function dataKind(expected: Expectation): string {
	if (expected.status === 204 || expected.data === null) return "empty"
	return typeof expected.data === "string" ? "text" : "json"
}

/** An error status's kind: its status, and where it arrived (a realtime dial, a stream's opening answer, a call). */
function errorKind(expected: Expectation, scenario: Scenario, call: Call): string {
	const status = String(expected.status)
	if (scenario.dials !== undefined) return `realtime refusal ${status}`
	return call.take === undefined ? `error ${status}` : `stream open error ${status}`
}

/** Each Observed kind an SDK answers, to the response kind of one expectation of it. */
const KINDS: Readonly<Record<string, (expected: Expectation, scenario: Scenario, call: Call) => string>> = {
	bytes: () => "binary",
	data: dataKind,
	/* a 2xx whose body does not decode, or one past the cell's response cap */
	decode: (_, scenario) => (scenario.setup?.maxResponseBytes === undefined ? "decode" : "decode over cap"),
	error: errorKind,
	events: (expected) => (expected.failed === undefined ? "events" : `events failed ${String(expected.failed)}`),
	frames: () => "frames",
	raw: () => "raw",
	timeout: () => "timeout",
	transport: () => "transport",
}

/**
 * The response kind call `index` of `scenario` expects: a data answer by its body (json, text or empty), bytes, a raw
 * response, an event stream (and how it failed), frames, a timeout, an undecodable 2xx, no answer, or an error status
 * by its status and where it arrived (a plain call, a stream's opening answer, a realtime dial). Throws on a shape no
 * SDK answers (a CLI's or an MCP read's): only the SDK targets' cells have kinds.
 */
export function responseKindOf(scenario: Scenario, index: number): string {
	const expected = recordOf(scenario.expect[index])
	const call = scenario.calls[index]
	if (expected === null || call === undefined) throw new Error(`${scenario.id}: call ${index} has no expectation`)
	const named = typeof expected.kind === "string" && Object.hasOwn(KINDS, expected.kind) ? expected.kind : null
	const kind = named === null ? undefined : KINDS[named]
	if (kind === undefined)
		throw new Error(`${scenario.id}: call ${index} expects ${JSON.stringify(expected.kind)}, which no SDK answers`)
	return kind(expected, scenario, call)
}

/** Each distinct response kind of `cells`, in grid order, with the cells holding it. */
export function responseKinds(cells: readonly Cell[]): ReadonlyMap<string, readonly Cell[]> {
	const kinds = new Map<string, Cell[]>()
	for (const cell of cells)
		for (let i = 0; i < cell.calls.length; i++) {
			const kind = responseKindOf(cell, i)
			const holders = kinds.get(kind) ?? []
			if (!holders.includes(cell)) holders.push(cell)
			kinds.set(kind, holders)
		}
	return kinds
}

/**
 * The safe variant's cells out of `cells`: for each kind, a cell holding it that the runner does not lack, one already
 * chosen when it holds the kind too, in grid order; and the kinds no such cell holds (`uncovered`), each a gap.
 */
export function safeSelection(
	cells: readonly Cell[],
	lacks: (cell: Cell) => boolean = () => false,
): { readonly cells: readonly Cell[]; readonly uncovered: readonly string[] } {
	const chosen = new Set<Cell>()
	const uncovered: string[] = []
	for (const [kind, holders] of responseKinds(cells)) {
		const runnable = holders.filter((cell) => !lacks(cell))
		const pick = runnable.find((cell) => chosen.has(cell)) ?? runnable[0]
		if (pick === undefined) uncovered.push(kind)
		else chosen.add(pick)
	}
	return { cells: cells.filter((cell) => chosen.has(cell)), uncovered }
}

/** The cells `target`'s safe variant runs: none until its phase enables it, then one per kind it does not lack. */
export function safeCellsFor(target: Sdk, lacks?: (cell: Cell) => boolean): ReturnType<typeof safeSelection> {
	if (!SAFE_ENABLED.has(target)) return { cells: [], uncovered: [] }
	return safeSelection(cellsFor(target), lacks)
}

/**
 * One line per enabled SDK whose safe variant leaves a kind uncovered (R-i6 c): `enabled` and `lacksOf` are the real
 * SAFE_ENABLED and runner lacks, or a synthetic set proving the leg reds.
 */
export function safeCoverageProblems(
	enabled: ReadonlySet<Sdk>,
	lacksOf: (target: Sdk) => ((cell: Cell) => boolean) | undefined = () => undefined,
): string[] {
	return SDKS.filter((target) => enabled.has(target)).flatMap((target) =>
		safeSelection(cellsFor(target), lacksOf(target)).uncovered.map((kind) => `${target}: no safe cell answers ${kind}`),
	)
}
