/**
 * Gen's mutation check, the same mechanism as core's and none of its code (H2): a guard is
 * load-bearing only if the emit adversarial suite goes red without it. For each guard, run
 * `tests/security` with that guard disabled (HONEY_MUTANT=<id>, applied by the suite through
 * vi.doMock) and require a failing run; with every guard in place the suite must pass.
 *
 *     bun packages/gen/tests/structure/mutation-harness.ts
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { bypassedEscapes, localeOrder, rawKey, variableTimeHelper } from "../security/mutants.ts"

export type Guard = {
	/** what the suite must catch once this guard is gone */
	catches: string
	/** the module's exports with the guard switched off */
	disable(original: Record<string, unknown>): Record<string, unknown>
	id: string
	/** repo-relative path of the module that holds the guard */
	module: string
}

export const GUARDS: readonly Guard[] = [
	{
		catches: "a string literal written without its target's escape policy (U+2028, the BOM, NUL raw or misspelled)",
		disable: () => bypassedEscapes,
		id: "escape-bypass",
		module: "packages/gen/src/emit/shared/escape.ts",
	},
	{
		catches: "emitted names ordered by the machine's locale instead of by code unit",
		disable: () => ({ compareCodeUnits: localeOrder }),
		id: "nondeterministic-naming",
		module: "packages/gen/src/emit/shared/lang.ts",
	},
	{
		catches: "a spec's property name written into source as it came",
		disable: () => ({ quoteKey: rawKey }),
		id: "spec-text-to-source",
		module: "packages/gen/src/emit/shared/literals.ts",
	},
	{
		catches: "a webhook verify helper comparing the digest by value, a timing oracle on the signature (H18.9)",
		disable: (original) => ({
			verifyHelper: variableTimeHelper(original.verifyHelper as (language: string) => string),
		}),
		id: "webhook-ct-compare",
		module: "packages/gen/src/emit/shared/webhooks.ts",
	},
]

const GEN = resolve(import.meta.dirname, "../..")
const SUITE = "tests/security"
const VITEST = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs")

export function guardNamed(id: string | undefined): Guard | undefined {
	if (id === undefined || id === "") return undefined
	const guard = GUARDS.find((g) => g.id === id)
	if (guard === undefined) throw new Error(`unknown guard "${id}"; known: ${GUARDS.map((g) => g.id).join(", ")}`)
	return guard
}

/** The emit adversarial suite's exit status, with `mutant` disabled when given. */
export function runSuite(mutant: string | undefined): number {
	const env = { ...process.env, HONEY_MUTANT: mutant ?? "" }
	const run = spawnSync(process.execPath, [VITEST, "run", SUITE], { cwd: GEN, encoding: "utf8", env })
	return run.status ?? 1
}

export function survivors(results: ReadonlyArray<{ id: string; status: number }>): string[] {
	return results.filter((r) => r.status === 0).map((r) => r.id)
}

function main(): number {
	if (runSuite(undefined) !== 0) {
		process.stderr.write("mutation: the emit adversarial suite fails with every guard in place\n")
		return 1
	}
	const results = GUARDS.map((g) => ({ id: g.id, status: runSuite(g.id) }))
	for (const r of results) process.stdout.write(`${r.status === 0 ? "SURVIVED" : "killed  "} ${r.id}\n`)
	const left = survivors(results)
	if (left.length > 0) process.stderr.write(`mutation: no case catches ${left.join(", ")}\n`)
	return left.length === 0 ? 0 : 1
}

if (import.meta.main) process.exit(main())
