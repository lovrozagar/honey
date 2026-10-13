/**
 * The mutation check (00-rules "Security gate"): a guard is load-bearing only if the adversarial
 * suite goes red without it. For each registered guard, run the suite with that guard disabled
 * (HONEY_MUTANT=<id>, applied by the suite through vi.doMock) and require a failing run; with
 * every guard in place the suite must pass.
 *
 *     bun packages/core/tests/structure/mutation-harness.ts
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"

export type Guard = {
	/** what the suite must catch once this guard is gone */
	catches: string
	/** the module's exports with the guard switched off, built from its real exports */
	disable(original: Record<string, unknown>): Record<string, unknown>
	id: string
	/** repo-relative path of the module that holds the guard */
	module: string
}

type NormalizePath = (raw: string, encodedSlashes?: "allow" | "reject") => string | null

export const GUARDS: readonly Guard[] = [
	{
		/* the v0 guard that proves the mechanism until bit 07 registers v1's (H21: v0 serves until cutover) */
		catches: "an encoded / or \\ reaching a route param",
		disable: (original) => {
			const normalizePath = original.normalizePath as NormalizePath
			return { normalizePath: (raw: string) => normalizePath(raw, "allow") }
		},
		id: "encoded-separator",
		module: "_v0/src/request-path.ts",
	},
]

const CORE = resolve(import.meta.dirname, "../..")
const SUITE = "tests/integration/security"
const VITEST = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")

export function guardNamed(id: string | undefined): Guard | undefined {
	if (id === undefined || id === "") return undefined
	const guard = GUARDS.find((g) => g.id === id)
	if (guard === undefined) throw new Error(`unknown guard "${id}"; known: ${GUARDS.map((g) => g.id).join(", ")}`)
	return guard
}

/** The adversarial suite's exit status, with `mutant` disabled when given. */
export function runSuite(mutant: string | undefined): number {
	const env = { ...process.env, HONEY_MUTANT: mutant ?? "" }
	const run = spawnSync(process.execPath, [VITEST, "run", SUITE], { cwd: CORE, encoding: "utf8", env })
	return run.status ?? 1
}

export function survivors(results: ReadonlyArray<{ id: string; status: number }>): string[] {
	return results.filter((r) => r.status === 0).map((r) => r.id)
}

function main(): number {
	if (runSuite(undefined) !== 0) {
		process.stderr.write("mutation: the adversarial suite fails with every guard in place\n")
		return 1
	}
	const results = GUARDS.map((g) => ({ id: g.id, status: runSuite(g.id) }))
	for (const r of results) process.stdout.write(`${r.status === 0 ? "SURVIVED" : "killed  "} ${r.id}\n`)
	const left = survivors(results)
	if (left.length > 0) process.stderr.write(`mutation: no case catches ${left.join(", ")}\n`)
	return left.length === 0 ? 0 : 1
}

if (import.meta.main) process.exit(main())
