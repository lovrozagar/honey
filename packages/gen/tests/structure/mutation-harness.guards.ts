/**
 * The gen guard registry the mutation harness and the emit adversarial suite share: each guard, the module
 * that holds it, its mutant and the toolchain its cases need. It imports no toolchain env, so a suite that
 * looks a guard up reaches no language it does not run (toolchain-projects.test.ts); mutation-harness.ts
 * runs the suites.
 */
import type { GoRuntimeFeatures } from "../../src/emit/go/http.ts"
import type { RustRuntimeFeatures } from "../../src/emit/rust/http.ts"
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
	RUST_KEEP_CROSS_ORIGIN_HEADERS,
	RUST_LEAKY_LOG,
	RUST_RAW_PATH_PARAMS,
	variableTimeHelper,
} from "../security/mutants.ts"

/** A language toolchain a guard's cases compile with. */
export type Toolchain = "go" | "rust"

/** Which toolchains this machine runs. */
export type Present = { readonly [T in Toolchain]: boolean }

export type Guard = {
	/** what the suite must catch once this guard is gone */
	catches: string
	/** the module's exports with the guard switched off */
	disable(original: Record<string, unknown>): Record<string, unknown>
	id: string
	/** repo-relative path of the module that holds the guard */
	module: string
	/** a toolchain the suite needs to run this guard's cases; without it the guard is skipped, never killed */
	toolchain?: Toolchain
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
	{
		catches:
			"a cross-origin redirect hop, through the SDK's client or a caller's http_builder, that keeps the auth header, cookies and configured headers (H18.10, R3)",
		disable: (original) => ({
			runtimeFiles: patchedRuntimeFiles(rustRuntime(original), RUST_KEEP_CROSS_ORIGIN_HEADERS),
		}),
		id: "rust-cross-origin-auth",
		module: "packages/gen/src/emit/rust/http.ts",
		toolchain: "rust",
	},
	{
		catches: "an on_log entry carrying a path value, the query or the token",
		disable: (original) => ({ runtimeFiles: patchedRuntimeFiles(rustRuntime(original), RUST_LEAKY_LOG) }),
		id: "rust-auth-redaction",
		module: "packages/gen/src/emit/rust/http.ts",
		toolchain: "rust",
	},
	{
		catches: "a path param written raw: `..` or `/` in a value changing which resource the request addresses",
		disable: (original) => ({ runtimeFiles: patchedRuntimeFiles(rustRuntime(original), RUST_RAW_PATH_PARAMS) }),
		id: "rust-path-param-escape",
		module: "packages/gen/src/emit/rust/http.ts",
		toolchain: "rust",
	},
]

/** The emitted runtime's reader, as the guarded module exports it. */
const runtime = (original: Record<string, unknown>) => original.runtimeSource as () => string

/** The emitted Go runtime's reader, as the guarded module exports it. */
const goRuntime = (original: Record<string, unknown>) =>
	original.runtimeFiles as (features: GoRuntimeFeatures) => Record<string, string>

/** The emitted Rust runtime's reader, as the guarded module exports it. */
const rustRuntime = (original: Record<string, unknown>) =>
	original.runtimeFiles as (features: RustRuntimeFeatures) => Record<string, string>

export function guardNamed(id: string | undefined): Guard | undefined {
	if (id === undefined || id === "") return undefined
	const guard = GUARDS.find((g) => g.id === id)
	if (guard === undefined) throw new Error(`unknown guard "${id}"; known: ${GUARDS.map((g) => g.id).join(", ")}`)
	return guard
}

/** The guards to report skipped: each guard whose toolchain is not `present`. */
export function skippedFor(guards: readonly Guard[], present: Present): string[] {
	return guards.filter((g) => g.toolchain !== undefined && !present[g.toolchain]).map((g) => g.id)
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
