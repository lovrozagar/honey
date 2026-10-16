/**
 * Gen's mutation check, the same mechanism as core's and none of its code (H2): a guard is
 * load-bearing only if the emit adversarial suite goes red without it. For each guard, run
 * `tests/security` with that guard disabled (HONEY_MUTANT=<id>, applied by the suite through
 * vi.doMock) and require a failing run; with every guard in place the suite must pass. A guard
 * whose toolchain is absent is reported skipped, never killed; where the toolchain is required
 * (HONEY_REQUIRE_GO, HONEY_REQUIRE_TOOLCHAINS) its absence fails the run instead.
 *
 *     bun packages/gen/tests/structure/mutation-harness.ts
 */
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { withGo } from "../../src/emit/go/__fixtures__/go-env.ts"
import type { GoRuntimeFeatures } from "../../src/emit/go/http.ts"
import {
	bypassedEscapes,
	GO_KEEP_CROSS_ORIGIN_HEADERS,
	GO_LEAKY_LOG,
	GO_RAW_PATH_PARAMS,
	KEEP_CROSS_ORIGIN_HEADERS,
	LEAKY_LOG,
	localeOrder,
	patchedRuntime,
	patchedRuntimeFiles,
	RAW_PATH_PARAMS,
	rawKey,
	variableTimeHelper,
} from "../security/mutants.ts"

export type Guard = {
	/** what the suite must catch once this guard is gone */
	catches: string
	/** the module's exports with the guard switched off */
	disable(original: Record<string, unknown>): Record<string, unknown>
	id: string
	/** repo-relative path of the module that holds the guard */
	module: string
	/** a toolchain the suite needs to run this guard's cases; without it the guard is skipped, never killed */
	toolchain?: "go"
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
	{
		catches: "a cross-origin redirect hop that keeps the auth header, cookies and configured headers (H18.10)",
		disable: (original) => ({ runtimeSource: patchedRuntime(runtime(original), KEEP_CROSS_ORIGIN_HEADERS) }),
		id: "ts-cross-origin-auth",
		module: "packages/gen/src/emit/ts/http.ts",
	},
	{
		catches: "an onLog entry carrying the request URL's query or the auth header value",
		disable: (original) => ({ runtimeSource: patchedRuntime(runtime(original), LEAKY_LOG) }),
		id: "ts-auth-redaction",
		module: "packages/gen/src/emit/ts/http.ts",
	},
	{
		catches: "a path param written raw: `..` or `/` in a value changing which resource the request addresses",
		disable: (original) => ({ runtimeSource: patchedRuntime(runtime(original), RAW_PATH_PARAMS) }),
		id: "ts-path-param-escape",
		module: "packages/gen/src/emit/ts/http.ts",
	},
	{
		catches:
			"a cross-origin redirect hop, through the SDK's client or a caller's HTTPClient, that keeps the auth header, cookies and configured headers (H18.10, R3)",
		disable: (original) => ({ runtimeFiles: patchedRuntimeFiles(goRuntime(original), GO_KEEP_CROSS_ORIGIN_HEADERS) }),
		id: "go-cross-origin-auth",
		module: "packages/gen/src/emit/go/http.ts",
		toolchain: "go",
	},
	{
		catches: "an OnLog entry carrying a path value, the query or the auth header value",
		disable: (original) => ({ runtimeFiles: patchedRuntimeFiles(goRuntime(original), GO_LEAKY_LOG) }),
		id: "go-auth-redaction",
		module: "packages/gen/src/emit/go/http.ts",
		toolchain: "go",
	},
	{
		catches: "a path param written raw: `..` or `/` in a value changing which resource the request addresses",
		disable: (original) => ({ runtimeFiles: patchedRuntimeFiles(goRuntime(original), GO_RAW_PATH_PARAMS) }),
		id: "go-path-param-escape",
		module: "packages/gen/src/emit/go/http.ts",
		toolchain: "go",
	},
]

/** The emitted runtime's reader, as the guarded module exports it. */
const runtime = (original: Record<string, unknown>) => original.runtimeSource as () => string

/** The emitted Go runtime's reader, as the guarded module exports it. */
const goRuntime = (original: Record<string, unknown>) =>
	original.runtimeFiles as (features: GoRuntimeFeatures) => Record<string, string>

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

/** The guards to report skipped: the Go guards where no Go runs, none where it does. */
export function skippedFor(guards: readonly Guard[], go: boolean): string[] {
	return go ? [] : guards.filter((g) => g.toolchain === "go").map((g) => g.id)
}

export type Verdicts = { killed: string[]; skipped: string[]; survived: string[] }

/** Each guard's verdict from `run` (its suite's exit status); a skipped guard never runs and is neither killed nor survived. */
export function verdicts(guards: readonly Guard[], skipped: readonly string[], run: (id: string) => number): Verdicts {
	const ran = guards.filter((g) => !skipped.includes(g.id)).map((g) => ({ id: g.id, status: run(g.id) }))
	return {
		killed: ran.filter((r) => r.status !== 0).map((r) => r.id),
		skipped: [...skipped],
		survived: ran.filter((r) => r.status === 0).map((r) => r.id),
	}
}

function main(): number {
	/* throws where Go is required and absent, before any suite run: a required toolchain never skips */
	const go = withGo()
	if (runSuite(undefined) !== 0) {
		process.stderr.write("mutation: the emit adversarial suite fails with every guard in place\n")
		return 1
	}
	const { killed, skipped, survived } = verdicts(GUARDS, skippedFor(GUARDS, go), runSuite)
	for (const id of killed) process.stdout.write(`killed   ${id}\n`)
	for (const id of skipped) process.stdout.write(`skipped  ${id} (no Go toolchain)\n`)
	for (const id of survived) process.stdout.write(`SURVIVED ${id}\n`)
	process.stdout.write(`mutation: ${killed.length} killed, ${skipped.length} skipped, ${survived.length} survived\n`)
	if (survived.length > 0) process.stderr.write(`mutation: no case catches ${survived.join(", ")}\n`)
	return survived.length === 0 ? 0 : 1
}

if (import.meta.main) process.exit(main())
