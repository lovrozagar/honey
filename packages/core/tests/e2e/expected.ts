/**
 * The e2e expected set (blueprint/baselines/e2e-expected.json): per cell, `env/mode/app`, the Playwright tests that
 * pass, skip and fail. run.ts holds every cell it runs to it, so a test that stops passing, or one that appears or
 * disappears, fails the run by the cell's name instead of going unnoticed.
 */

/** One cell's tests by outcome, each named `file > describe … > title`, sorted. */
export type Outcomes = { failed: string[]; passed: string[]; skipped: string[] }

export type ExpectedSet = { cells: Record<string, Outcomes> }

const OUTCOMES = ["passed", "failed", "skipped"] as const

/** What `got` lacks and gains against `want`, one clause each, empty when equal. */
function moved(kind: string, want: readonly string[], got: readonly string[]): string[] {
	const lacks = want.filter((name) => !got.includes(name))
	const gains = got.filter((name) => !want.includes(name))
	return [
		...(lacks.length > 0 ? [`${kind} lacks [${lacks.join(", ")}]`] : []),
		...(gains.length > 0 ? [`${kind} gains [${gains.join(", ")}]`] : []),
	]
}

/** Each cell in `ran` that differs from `expected`, by name: the outcome lists that differ, or its absence. */
export function mismatches(expected: ExpectedSet, ran: Readonly<Record<string, Outcomes>>): string[] {
	return Object.entries(ran).flatMap(([name, got]) => {
		const want = expected.cells[name]
		if (want === undefined) return [`${name}: not in the expected set`]
		const clauses = OUTCOMES.flatMap((kind) => moved(kind, want[kind], got[kind]))
		return clauses.length > 0 ? [`${name}: ${clauses.join("; ")}`] : []
	})
}
