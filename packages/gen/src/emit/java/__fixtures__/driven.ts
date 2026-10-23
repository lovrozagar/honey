/**
 * Emitted Java, driven (bit 16 phase c1, C2): an SDK gated by `compiledJavaSdk`, with `runCalls` sending a grid cell
 * through the fixed reflection driver (`driver/`, compiled by driver-build.ts) on the pinned 21 JDK, one JVM per cell.
 * The driver walks the emitter's call plans (`javaCallPlans`) and reaches every SDK type by name, so the driver never
 * names an SDK type at compile time. The run is asynchronous (execJava) so the recording server answers the JVM.
 */
import { generateJavaSdk, javaCallPlans, type JavaSdkOptions } from "../sdk.ts"
import type { JavaError, Script, Trace } from "../../shared/__fixtures__/protocol.ts"
import { type CompiledJavaSdk, compiledJavaSdk } from "./compiled.ts"
import { driverClasses } from "./driver-build.ts"
import { FIXTURES, type FixtureKey, type JavaFixture } from "./documents.ts"
import { execJava } from "./java-env.ts"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

/** What `runCalls` takes: a grid Cell, or just its calls and setup (the grid's types stay in tests/, out of src's reach). */
export type DriverCell = { readonly calls: readonly { readonly operation: string }[]; readonly setup?: object }

/** One driver run: its exit status, its stderr, and on success the grid's Observed, one per call. */
export type DriverRun = {
	readonly observed: readonly unknown[] | undefined
	readonly status: number
	readonly stderr: string
}

/** The SDK with the driver aimed at it: under a script, the trace records each error as a JavaError. */
export type DrivenJavaSdk = CompiledJavaSdk & {
	/** the SDK's javac diagnostics, empty when it builds */
	readonly built: boolean
	readonly diagnostics: readonly string[]
	/**
	 * run `cell` on one client aimed at `origins.url` (`alt`: a call's other origin), under `script` when given, with
	 * `jvmArgs` on the JVM's command line, on the `jdk` release's java (21 by default; the SDK and the driver are
	 * `--release 17`, so 17 and 25 run the same classes). `probe` runs the probe class instead of the driver: the driver's run, then the
	 * process-global `jdk.httpclient.allowRestrictedHeaders` reported on stderr after it (`honey-probe …=`).
	 */
	runCalls(
		cell: DriverCell,
		origins: { readonly alt?: string; readonly url: string },
		run?: {
			readonly script?: Script
			readonly jvmArgs?: readonly string[]
			readonly jdk?: 17 | 21 | 25
			/** call plans laid over the emitter's: a refusal leg's hand-written ones, refused before the SDK loads */
			readonly plans?: Readonly<Record<string, unknown>>
			readonly probe?: true
		},
	): Promise<DriverRun & { readonly trace?: Trace<JavaError> }>
}

/** How long one driver run may take: its own stream watchdog fails a stalled stream at 10 s, so a hang ends here. */
const DRIVER_BOUND_MS = 30_000

/** The probe: the Driver under a shutdown hook that reports the process-global restricted-header property (Qc6). */
const PROBE = `public final class Probe {
  public static void main(String[] args) throws Exception {
    Runtime.getRuntime().addShutdownHook(new Thread(() -> System.err.println(
        "honey-probe allowRestrictedHeaders=" + System.getProperty("jdk.httpclient.allowRestrictedHeaders"))));
    Driver.main(args);
  }
}
`

/** The client class's simple name and its package, read from the emitted sources (the one holding `builder()`). */
function clientOf(files: Readonly<Record<string, string>>): { client: string; pkg: string } {
	const path = Object.keys(files).find((name) => files[name]?.includes("public static Builder builder()") === true)
	if (path === undefined) throw new Error("the emitted SDK has no client class")
	const parts = path.split("/")
	return {
		client: (parts.at(-1) as string).replace(/\.java$/, ""),
		pkg: parts.slice(parts.indexOf("java") + 1, -1).join("."),
	}
}

/** A driver run's stdout as the caller reads it: `Observed[]`, or `{observed, trace}` under a script. */
function parsed(stdout: string, scripted: boolean): { observed: unknown[]; trace?: Trace<JavaError> } {
	if (!scripted) return { observed: JSON.parse(stdout) as unknown[] }
	return JSON.parse(stdout) as { observed: unknown[]; trace: Trace<JavaError> }
}

/** `fixture`'s SDK compiled and gated, and `runCalls` sending cells through the driver by the emitter's call plans. */
function drivenFixture(fixture: JavaFixture): DrivenJavaSdk {
	const options: JavaSdkOptions = fixture.options ?? {}
	const files = generateJavaSdk(fixture.document(), options).files
	const plans = javaCallPlans(fixture.document(), options)
	const sdk = compiledJavaSdk(files)
	const { client, pkg } = clientOf(files)
	return {
		...sdk,
		built: sdk.javac.diagnostics.length === 0,
		diagnostics: sdk.javac.diagnostics,
		runCalls: async (cell, origins, opts = {}) => {
			const envelope = {
				alt: origins.alt,
				base: origins.url,
				cell,
				plans: { ...plans, ...opts.plans },
				script: opts.script,
				sdk: { client, package: pkg },
			}
			const classes = driverClasses(sdk.classpath)
			const main = opts.probe === true ? join(sdk.dir, "Probe.java") : "Driver"
			if (opts.probe === true) writeFileSync(main, PROBE)
			const cp = [classes, sdk.out, ...sdk.classpath].join(":")
			const ran = await execJava(opts.jdk ?? 21, [...(opts.jvmArgs ?? []), "-cp", cp, main], {
				cwd: sdk.dir,
				input: JSON.stringify(envelope),
				killAfterMs: DRIVER_BOUND_MS,
			})
			const out = ran.status === 0 ? parsed(ran.stdout, opts.script !== undefined) : { observed: undefined }
			return { ...out, status: ran.status ?? 1, stderr: ran.stderr }
		},
	}
}

/** The registry SDK `key`, driven (`drivenFixture`). */
export const drivenJavaSdk = (key: FixtureKey): DrivenJavaSdk => drivenFixture(FIXTURES[key])

/** The SDK of `document` (the reference app's, served), driven with `options`: the harness files alone. */
export const servedJavaSdk = (document: Readonly<Record<string, unknown>>, options?: JavaSdkOptions): DrivenJavaSdk =>
	drivenFixture({ document: () => document, ...(options === undefined ? {} : { options }) })
