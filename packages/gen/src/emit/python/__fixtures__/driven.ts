/**
 * Emitted Python, driven (contract 28 §6.3, Fb8/G17): a package gated by `compiledFixture`, with `runCalls`
 * sending a grid cell through the fixed reflection driver (`driver/driver.py`, the shared driver protocol), one
 * process per cell. Nothing is generated for the driver: it walks the emitter's call plans (`pythonCallPlans`)
 * with `getattr`. `drivenPythonSdk` drives a registry entry (`FIXTURES`, Fb14); `servedPythonSdk` drives the
 * harness files' served document (the reference app's), outside the registry, which a structure test keeps to
 * those files (G17).
 */
import { join } from "node:path"
import type { PythonError, Script, Trace } from "../../shared/__fixtures__/protocol.ts"
import { pythonCallPlans } from "../sdk.ts"
import { compiledFixture, type GateOptions, type PythonSdk } from "./compiled.ts"
import { FIXTURES, type FixtureKey, type PythonFixture } from "./documents.ts"
import { execPython } from "./python-env.ts"

/** What `runCalls` takes: a grid Cell, or just its calls and setup (the grid's types stay in tests/, out of src's reach). */
export type DriverCell = { readonly calls: readonly { readonly operation: string }[]; readonly setup?: object }

/** One driver run: its exit status, its stderr, and on success the grid's `Observed`, one per call. */
export type DriverRun = {
	readonly observed: readonly unknown[] | undefined
	readonly status: number
	readonly stderr: string
}

/** The SDK with the driver aimed at it: under a script, the trace records each error as a `PythonError`. */
export type DrivenPythonSdk = PythonSdk & {
	/**
	 * run `cell` on one client ("async" or "sync") aimed at `origins.url` (`alt`, `drop`, `refused`: the other origins
	 * a call may name), under `script` when given, through the client's `safe` mirror when `safe` (bit 21 i2)
	 */
	runCalls(
		cell: DriverCell,
		origins: { readonly alt?: string; readonly drop?: string; readonly refused?: string; readonly url: string },
		run: { readonly client: "async" | "sync"; readonly safe?: boolean; readonly script?: Script },
	): Promise<DriverRun & { readonly trace?: Trace<PythonError> }>
}

/** The driver's entry point: it puts its own dir on sys.path, which `-I` leaves off. */
const driverEntry = () => join(import.meta.dirname, "driver", "driver.py")

/** A driver run's stdout as the caller reads it: `Observed[]`, or `{observed, trace}` under a script. */
function parsed(stdout: string, scripted: boolean): { observed: unknown[]; trace?: Trace<PythonError> } {
	if (!scripted) return { observed: JSON.parse(stdout) as unknown[] }
	return JSON.parse(stdout) as { observed: unknown[]; trace: Trace<PythonError> }
}

/**
 * `fixture`'s SDK gated under the pins, the floors or the newest set, and `runCalls` sending cells through the
 * driver by the emitter's call plans for the fixture's own options.
 */
function drivenFixture(fixture: PythonFixture, options: GateOptions): DrivenPythonSdk {
	const plans = "document" in fixture ? pythonCallPlans(fixture.document(), fixture.options) : {}
	const sdk = compiledFixture(fixture, options)
	/* the spread resolves the venv: every driver run needs it */
	return {
		...sdk,
		runCalls: async (cell, origins, run) => {
			const envelope = {
				alt: origins.alt,
				base: origins.url,
				drop: origins.drop,
				refused: origins.refused,
				cell,
				client: run.client,
				plans,
				safe: run.safe,
				script: run.script,
			}
			const input = { ...envelope, sdk: { package: sdk.package, root: sdk.root } }
			const ran = await execPython(sdk.venv, [driverEntry()], { cwd: sdk.dir, input: JSON.stringify(input) })
			const out = ran.status === 0 ? parsed(ran.stdout, run.script !== undefined) : { observed: undefined }
			return { ...out, status: ran.status, stderr: ran.stderr }
		},
	}
}

/** The registry SDK `key`, driven (`drivenFixture`). */
export const drivenPythonSdk = (key: FixtureKey, options: GateOptions = {}): DrivenPythonSdk =>
	drivenFixture(FIXTURES[key], options)

/** The SDK of `document` (the reference app's, served), driven with the emitter's default options: the harness files alone. */
export const servedPythonSdk = (
	document: Readonly<Record<string, unknown>>,
	options: GateOptions = {},
): DrivenPythonSdk => drivenFixture({ document: () => document }, options)
