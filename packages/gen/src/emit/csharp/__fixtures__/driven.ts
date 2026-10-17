/**
 * Emitted C#, driven (contract 45 §6.3, Fb10, G17): an SDK gated by `compiledFixture`, with `runCalls` sending a
 * grid cell through the fixed reflection driver (`driver/`, the shared driver protocol), one process per cell.
 * Nothing is generated for the driver, and it holds no reference to any SDK: it is built once per driver-source
 * hash by the gates' own build step, loads the SDK's dll at run time, walks the emitter's call plans
 * (`csharpCallPlans`) by reflection, and binds every argument through the SDK's own `JsonSerializerContext`. C# has
 * one client, so a run names none. `drivenCSharpSdk` drives a registry entry (`FIXTURES`); `servedCSharpSdk`
 * drives the harness files' served document (the reference app's), outside the registry, which a structure test
 * keeps to those files (G17).
 */
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { CsError, Script, Trace } from "../../shared/__fixtures__/protocol.ts"
import { csharpCallPlans, type CSharpSdkOptions } from "../sdk.ts"
import { buildOnce, compiledFixture, type CSharpSdk } from "./compiled.ts"
import { clientOf } from "./consumer.ts"
import { csharpCacheDir, execDotnet, pinnedDotnet } from "./csharp-env.ts"
import { type CSharpFixture, FIXTURES, type FixtureKey } from "./documents.ts"

/** What `runCalls` takes: a grid Cell, or just its calls and setup (the grid's types stay in tests/, out of src's reach). */
export type DriverCell = { readonly calls: readonly { readonly operation: string }[]; readonly setup?: object }

/** One driver run: its exit status, its stderr, and on success the grid's `Observed`, one per call. */
export type DriverRun = {
	readonly observed: readonly unknown[] | undefined
	readonly status: number
	readonly stderr: string
}

/** The SDK with the driver aimed at it: under a script, the trace records each error as a `CsError`. */
export type DrivenCSharpSdk = CSharpSdk & {
	/** run `cell` on one client aimed at `origins.url` (`alt`: a call's other origin), under `script` when given */
	runCalls(
		cell: DriverCell,
		origins: { readonly alt?: string; readonly url: string },
		run?: { readonly script?: Script },
	): Promise<DriverRun & { readonly trace?: Trace<CsError> }>
}

/** The driver's sources, by their path under `driver/`. */
function driverSources(): Record<string, string> {
	const dir = join(import.meta.dirname, "driver")
	return Object.fromEntries(
		readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
			.sort()
			.map((name) => [name, readFileSync(join(dir, name), "utf8")]),
	)
}

/**
 * The driver's dll, built once per hash of its sources and the SDK pin by the gates' build step and slot, with no
 * reference to any SDK; a driver that does not build throws its diagnostics.
 */
export function driverDll(): string {
	const sources = driverSources()
	const hash = createHash("sha256")
		.update(JSON.stringify({ sdk: pinnedDotnet(), sources: Object.entries(sources) }))
		.digest("hex")
		.slice(0, 20)
	const built = buildOnce(join(csharpCacheDir("driver"), hash), sources)
	if (!built.built) throw new Error(`the C# test driver does not build:\n${built.diagnostics.join("\n")}`)
	return built.dll
}

/** A driver run's stdout as the caller reads it: `Observed[]`, or `{observed, trace}` under a script. */
function parsed(stdout: string, scripted: boolean): { observed: unknown[]; trace?: Trace<CsError> } {
	if (!scripted) return { observed: JSON.parse(stdout) as unknown[] }
	return JSON.parse(stdout) as { observed: unknown[]; trace: Trace<CsError> }
}

/** `fixture`'s SDK gated, and `runCalls` sending cells through the driver by the emitter's call plans for its own options. */
function drivenFixture(fixture: CSharpFixture): DrivenCSharpSdk {
	const plans = "document" in fixture ? csharpCallPlans(fixture.document(), fixture.options) : {}
	const sdk = compiledFixture(fixture)
	return {
		...sdk,
		runCalls: async (cell, origins, run = {}) => {
			const target = { ...clientOf(sdk), dll: sdk.dll }
			const envelope = { alt: origins.alt, base: origins.url, cell, plans, script: run.script, sdk: target }
			const ran = await execDotnet([driverDll()], { cwd: sdk.dir, input: JSON.stringify(envelope) })
			const out = ran.status === 0 ? parsed(ran.stdout, run.script !== undefined) : { observed: undefined }
			return { ...out, status: ran.status, stderr: ran.stderr }
		},
	}
}

/** The registry SDK `key`, driven (`drivenFixture`). */
export const drivenCSharpSdk = (key: FixtureKey): DrivenCSharpSdk => drivenFixture(FIXTURES[key])

/** The SDK of `document` (the reference app's, served), driven with `options`: the harness files alone. */
export const servedCSharpSdk = (
	document: Readonly<Record<string, unknown>>,
	options?: CSharpSdkOptions,
): DrivenCSharpSdk => drivenFixture({ document: () => document, ...(options === undefined ? {} : { options }) })
