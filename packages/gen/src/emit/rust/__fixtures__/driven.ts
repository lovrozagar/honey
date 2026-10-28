/**
 * Emitted Rust, driven (contract 18 §7.2; split from compiled.ts at the 300 cap): a crate compiled by
 * `compiledFixture` with the test driver (`driver/*.rs` and a `dispatch.rs` written from the crate's call plans)
 * as its program, `runCalls` sending a grid cell through it (the shared driver protocol). `drivenRustSdk`
 * drives a registry entry (`FIXTURES`, Fb5); `servedRustSdk` the reference app's served document, which only
 * the harness files compile (contract 21 Fe1, held by rust-toolchain.test.ts): it is no FIXTURES entry, so the
 * default run's budget never counts it.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { RustError, Script, Trace } from "../../shared/__fixtures__/protocol.ts"
import type { RustCallPlan } from "../sdk-plan.ts"
import { rustCallPlans } from "../sdk.ts"
import { compiledFixture, type Program, type RustCrate } from "./compiled.ts"
import { dispatchRs } from "./dispatch.ts"
import { FIXTURES, type FixtureKey, type RustFixture } from "./documents.ts"

/** What `runCalls` takes: a grid Cell, or just its calls and setup (the grid's types stay in tests/, out of src's reach). */
export type DriverCell = { readonly calls: readonly { readonly operation: string }[]; readonly setup?: object }

/** One driver run: its exit status, its stderr, and on success the grid's `Observed`, one per call. */
export type DriverRun = {
	readonly observed: readonly unknown[] | undefined
	readonly status: number
	readonly stderr: string
}

/** The SDK compiled with the driver beside it. */
export type DrivenRustSdk = RustCrate & {
	/** run `cell` on one client aimed at `origins.url` (`alt`: a call's other origin), under `script` when given */
	runCalls(
		cell: DriverCell,
		origins: { readonly alt?: string; readonly url: string },
		script?: Script,
	): Promise<DriverRun & { readonly trace?: Trace<RustError> }>
}

/** The driver's sources by file name: the fixed ones, and `dispatch.rs` written from `plans`. */
function driverSources(plans: Readonly<Record<string, RustCallPlan>>, throwOnError: boolean): Record<string, string> {
	const dir = join(import.meta.dirname, "driver")
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".rs"))
		.map((name) => [name, readFileSync(join(dir, name), "utf8")] as const)
	return Object.fromEntries([...files, ["dispatch.rs", dispatchRs(plans, throwOnError)]])
}

/** A driver run's stdout as the caller reads it: `Observed[]`, or `{observed, trace}` under a script. */
function parsed(stdout: string, scripted: boolean): { observed: unknown[]; trace?: Trace<RustError> } {
	if (!scripted) return { observed: JSON.parse(stdout) as unknown[] }
	return JSON.parse(stdout) as { observed: unknown[]; trace: Trace<RustError> }
}

/**
 * `fixture`'s SDK compiled with the test driver beside it, and `runCalls` sending cells through it by the
 * emitter's call plans for the fixture's own options (none for a dependency-free crate).
 */
function drivenFixture(fixture: RustFixture): DrivenRustSdk {
	const plans = "document" in fixture ? rustCallPlans(fixture.document(), fixture.options) : {}
	const throwOnError = !("document" in fixture && fixture.options?.throwOnError === false)
	const crate = compiledFixture(fixture, { programs: { driver: driverSources(plans, throwOnError) } })
	return {
		...crate,
		runCalls: async (cell, origins, script) => {
			const input = { alt: origins.alt, base: origins.url, cell, plans, script }
			const ran = await crate.exec("driver", JSON.stringify(input))
			const out = ran.status === 0 ? parsed(ran.stdout, script !== undefined) : { observed: undefined }
			return { ...out, status: ran.status, stderr: ran.stderr }
		},
	}
}

/** The registry SDK `key` compiled with the test driver beside it. */
export const drivenRustSdk = (key: FixtureKey): DrivenRustSdk => drivenFixture(FIXTURES[key])

/**
 * A document a harness file serves or holds (the reference app's `GET /v1/openapi.json`, the docs' API) as an SDK,
 * at the default options: driven; with `{check, toolchain}` checked as a library under that toolchain (the floor
 * leg); or with `{programs}` built with those bins beside it (the docs' example). Compiled once per content hash like
 * a registry entry, so the harness files that compile it share one build.
 */
export function servedRustSdk(document: Readonly<Record<string, unknown>>): DrivenRustSdk
export function servedRustSdk(
	document: Readonly<Record<string, unknown>>,
	options:
		| { readonly check: true; readonly toolchain: string }
		| { readonly programs: Readonly<Record<string, Program>> },
): RustCrate
export function servedRustSdk(
	document: Readonly<Record<string, unknown>>,
	options?:
		| { readonly check: true; readonly toolchain: string }
		| { readonly programs: Readonly<Record<string, Program>> },
): DrivenRustSdk | RustCrate {
	const fixture: RustFixture = { document: () => document }
	return options === undefined ? drivenFixture(fixture) : compiledFixture(fixture, options)
}
