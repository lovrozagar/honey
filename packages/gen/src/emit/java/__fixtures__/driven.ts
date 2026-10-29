/**
 * Emitted Java, driven (bit 16 phase c1, C2): an SDK gated by `compiledJavaSdk`, with `runCalls` sending a grid cell
 * through the fixed reflection driver (`driver/`, compiled by driver-build.ts) on the pinned 21 JDK, one JVM per cell.
 * The driver walks the emitter's call plans (`javaCallPlans`) and reaches every SDK type by name, so the driver never
 * names an SDK type at compile time. The run is asynchronous (execJava) so the recording server answers the JVM.
 * `safe` sends every call through the client's `safe()` mirror, each answering a `Result` (bit 21 i6); a `session`
 * keeps one JVM for many runs, the safe grid's batch.
 */
import { generateJavaSdk, javaCallPlans, type JavaSdkOptions } from "../sdk.ts"
import type { JavaError, Script, Trace } from "../../shared/__fixtures__/protocol.ts"
import { type CompiledJavaSdk, compiledJavaSdk } from "./compiled.ts"
import { driverClasses } from "./driver-build.ts"
import { FIXTURES, type FixtureKey, type JavaFixture } from "./documents.ts"
import { execJava, spawnJava } from "./java-env.ts"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

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
	 * run `cell` on one client aimed at `origins.url` (`alt`, `drop`, `refused`: the other origins a call may name), under `script` when given, with
	 * `jvmArgs` on the JVM's command line, on the `jdk` release's java (21 by default; the SDK and the driver are
	 * `--release 17`, so 17 and 25 run the same classes). `probe` runs the probe class instead of the driver: the driver's run, then the
	 * process-global `jdk.httpclient.allowRestrictedHeaders` reported on stderr after it (`honey-probe …=`).
	 */
	runCalls(
		cell: DriverCell,
		origins: { readonly alt?: string; readonly drop?: string; readonly refused?: string; readonly url: string },
		run?: {
			readonly script?: Script
			readonly jvmArgs?: readonly string[]
			readonly jdk?: 17 | 21 | 25
			/** call plans laid over the emitter's: a refusal leg's hand-written ones, refused before the SDK loads */
			readonly plans?: Readonly<Record<string, unknown>>
			readonly probe?: true
			/** every call through `client.safe()`, read as its `Result` (the driver's Observe.settle) */
			readonly safe?: boolean
		},
	): Promise<DriverRun & { readonly trace?: Trace<JavaError> }>
	/**
	 * one JVM on `jdk` kept for many runs (the driver's serve mode, bit 21 i6): each `run` sends one envelope as
	 * runCalls does, on a fresh client, under the same bound, and `close` ends the JVM; a bound passed kills it, so
	 * every later run fails. The safe grid sends its cells this way, since a JVM's start is most of a cell.
	 */
	session(jdk?: 17 | 21 | 25): DriverSession
}

/** A kept JVM's runs: runCalls' cell, origins and `safe`, one envelope each, in order. */
export type DriverSession = {
	run(cell: DriverCell, origins: Origins, safe?: boolean): Promise<DriverRun>
	close(): void
}

type Origins = { readonly alt?: string; readonly drop?: string; readonly refused?: string; readonly url: string }

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

/**
 * The client class's simple name and its package, read from the emitted sources: the one its javadoc names the client
 * (a Params record or RequestOptions holds a `builder()` too, and `AnyGetParams` sorts before `AnyrowClient`).
 */
export function clientOf(files: Readonly<Record<string, string>>): { client: string; pkg: string } {
	const path = Object.keys(files).find(
		(name) => files[name]?.includes("/** The client for the API. Build one with {@link #builder()}. */") === true,
	)
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
	const envelopeOf = (
		cell: DriverCell,
		origins: Origins,
		opts: { plans?: object; safe?: boolean; script?: Script },
	) => ({
		alt: origins.alt,
		base: origins.url,
		cell,
		drop: origins.drop,
		plans: { ...plans, ...opts.plans },
		refused: origins.refused,
		safe: opts.safe === true,
		script: opts.script,
		sdk: { client, package: pkg },
	})
	return {
		...sdk,
		built: sdk.javac.diagnostics.length === 0,
		diagnostics: sdk.javac.diagnostics,
		session: (jdk = 21) =>
			session(
				spawnJava(
					jdk,
					["-cp", [driverClasses(sdk.classpath), sdk.out, ...sdk.classpath].join(":"), "Driver", "serve"],
					{ cwd: sdk.dir },
				),
				envelopeOf,
			),
		runCalls: async (cell, origins, opts = {}) => {
			const envelope = envelopeOf(cell, origins, opts)
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

/** A kept JVM's session: each run one envelope line, its reply the next stdout line, each under DRIVER_BOUND_MS. */
function session(
	jvm: ReturnType<typeof spawnJava>,
	envelopeOf: (cell: DriverCell, origins: Origins, opts: { safe?: boolean }) => object,
): DriverSession {
	const waiting: ((line: string | null) => void)[] = []
	let stderr = ""
	let ended = false
	jvm.stderr.setEncoding("utf8").on("data", (chunk: string) => {
		stderr += chunk
	})
	createInterface({ input: jvm.stdout }).on("line", (line) => waiting.shift()?.(line))
	jvm.on("close", () => {
		ended = true
		for (const reply of waiting.splice(0)) reply(null)
	})
	return {
		close: () => jvm.stdin.end(),
		run: (cell, origins, safe) =>
			new Promise((done) => {
				if (ended) return done({ observed: undefined, status: 1, stderr: `the session's JVM ended: ${stderr}` })
				const bound = setTimeout(() => jvm.kill("SIGKILL"), DRIVER_BOUND_MS)
				waiting.push((line) => {
					clearTimeout(bound)
					if (line === null)
						return done({ observed: undefined, status: 1, stderr: `the session's JVM ended: ${stderr}` })
					const reply = JSON.parse(line) as { status: number; stdout?: string; stderr?: string }
					const observed = reply.status === 0 ? (JSON.parse(reply.stdout as string) as unknown[]) : undefined
					done({ observed, status: reply.status, stderr: reply.stderr ?? "" })
				})
				jvm.stdin.write(`${JSON.stringify(envelopeOf(cell, origins, { safe }))}\n`)
			}),
	}
}

/** The registry SDK `key`, driven (`drivenFixture`). */
export const drivenJavaSdk = (key: FixtureKey): DrivenJavaSdk => drivenFixture(FIXTURES[key])

/** The SDK of `document` (the reference app's, served), driven with `options`: the harness files alone. */
export const servedJavaSdk = (document: Readonly<Record<string, unknown>>, options?: JavaSdkOptions): DrivenJavaSdk =>
	drivenFixture({ document: () => document, ...(options === undefined ? {} : { options }) })
