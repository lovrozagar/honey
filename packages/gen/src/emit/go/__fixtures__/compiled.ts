/**
 * Emitted Go, compiled: the files an emitter writes land under
 * `$HOME/.cache/honey-tmp/go/sdk/<content hash>/` and are built and vetted with the pinned toolchain
 * (go-env), so a test proves the text it asserts is Go the pinned compiler accepts — vet included,
 * which is what enforces the module's `go` floor. A floor leg passes `toolchain: GO_FLOOR` to build
 * and vet under that oldest admitted Go itself. An optional consumer program (`main`, under
 * `cmd/check`) is built beside the SDK into one binary per content hash, run as is.
 *
 * `compiledSdk` is that with the test driver (`driver/*.go`, G8.3-4) as the program: the unit
 * behavior tests, the conformance runner and the harness run cells through it by the emitter's own
 * call plans (`goCallPlans`), one process per cell, `Observed[]` back. A unit test or the harness
 * may add a `Script` (client extras, recorders, per-call directives, stream controls, opt-in trace
 * members) and gets a `Trace` beside the observed, both the shared driver protocol
 * (shared/__fixtures__/protocol.ts). `drivenSdk` is the same over given files and plans.
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { GoCallPlan } from "../sdk-client.ts"
import { type GoSdkOptions, generateGoSdk, goCallPlans } from "../sdk.ts"
import type { Script, Trace } from "../../shared/__fixtures__/protocol.ts"
import { goCacheDir, goEnv, runGo } from "./go-env.ts"

/** A run of the check program: its exit status and output. */
export type Ran = { status: number; stderr: string; stdout: string }

export type Compiled = {
	readonly built: boolean
	readonly dir: string
	readonly stderr: string
	/** `go vet ./...` findings, one per line; empty when clean */
	readonly vet: readonly string[]
	/** run the `main` check program; its status and output */
	run(): Ran
	/** run the `main` check program with `input` on stdin, without blocking the event loop */
	exec(input: string): Promise<Ran>
}

/** What `runCalls` takes: a grid Cell, or just its calls and setup (the grid's types stay in tests/, out of src's reach). */
export type DriverCell = { readonly calls: readonly { readonly operation: string }[]; readonly setup?: object }

/** One driver run: its exit status, its stderr, and on success the grid's `Observed`, one per call. */
export type DriverRun = {
	/** with a script, a call ending in a Go error the grid has no `Observed` for is null */
	readonly observed: readonly unknown[] | undefined
	readonly status: number
	readonly stderr: string
}

/** The SDK compiled with the driver beside it. */
export type DrivenSdk = Compiled & {
	/** run `cell` on one client aimed at `origins.url` (`alt`: a call's other origin), under `script` when given */
	runCalls(
		cell: DriverCell,
		origins: { readonly alt?: string; readonly url: string },
		script?: Script,
	): Promise<DriverRun & { readonly trace?: Trace }>
}

/* the check program's binary, beside the module it is built from */
const BINARY = "check"
/* the import path the driver's sources name the SDK by, replaced with the SDK's module path */
const DRIVER_IMPORT = '"honey.test/driver/sdk"'

/** The files to write: the SDK, and the check program under `cmd/check` when one is given. */
function withMain(files: Readonly<Record<string, string>>, main: Main | undefined): [string, string][] {
	const entries = Object.entries(files)
	const program = typeof main === "string" ? { "main.go": main } : (main ?? {})
	for (const [name, text] of Object.entries(program)) entries.push([`cmd/check/${name}`, text])
	return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

/** Write each file beside its final name, then rename: a parallel worker never reads half a file. */
function writeOnce(dir: string, entries: readonly [string, string][]): void {
	if (existsSync(join(dir, ".complete"))) return
	for (const [name, text] of entries) {
		const path = join(dir, name)
		mkdirSync(dirname(path), { recursive: true })
		const partial = `${path}.${process.pid}.partial`
		writeFileSync(partial, text)
		renameSync(partial, path)
	}
	writeFileSync(join(dir, ".complete"), "")
}

/** Link the check program once per content hash (with the race detector for `race`), beside its final name then renamed; its link errors, if any. */
function linkOnce(dir: string, options: CompileOptions): string {
	if (existsSync(join(dir, BINARY))) return ""
	const partial = `${BINARY}.${process.pid}.partial`
	const race = options.race ? ["-race"] : []
	const link = runGo(["build", ...race, "-o", partial, "./cmd/check"], { cwd: dir, toolchain: options.toolchain })
	if (link.status !== 0) return link.stderr
	renameSync(join(dir, partial), join(dir, BINARY))
	return ""
}

/** The check program's run with `input` on stdin, as a promise: an in-process server keeps answering meanwhile. */
function execIn(dir: string, input: string): Promise<Ran> {
	return new Promise((resolve, reject) => {
		const child = spawn(join(dir, BINARY), [], { cwd: dir, env: goEnv() })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.once("error", reject)
		child.once("close", (status) => resolve({ status: status ?? 1, stderr, stdout }))
		child.stdin.end(input)
	})
}

/** A check program: one `main.go`, or its files by name. */
type Main = string | Readonly<Record<string, string>>

/** How `compileGo` builds: the check program, the race detector on its link, a toolchain in place of the pin. */
export type CompileOptions = {
	readonly main?: Main
	readonly race?: true
	/** the Go version (`1.24.0`) every go command runs under in place of the pin: the floor legs pass GO_FLOOR */
	readonly toolchain?: string
}

/** The cache dir name for `entries` under `options`: a race link or another toolchain never shares a dir (its `.complete`, its binary) with the plain build. */
function contentHash(entries: readonly [string, string][], { race, toolchain }: CompileOptions): string {
	const keyed = race === undefined && toolchain === undefined ? entries : { entries, race, toolchain }
	return createHash("sha256").update(JSON.stringify(keyed)).digest("hex").slice(0, 20)
}

/**
 * `files` (a module with its `go.mod`) built and vetted at the pinned toolchain (or `toolchain`),
 * with `main` beside it; `race` links `main` with the race detector (the build and vet stay as they are).
 */
export function compileGo(files: Readonly<Record<string, string>>, options: CompileOptions = {}): Compiled {
	const entries = withMain(files, options.main)
	const dir = goCacheDir("sdk", contentHash(entries, options))
	writeOnce(dir, entries)
	const { toolchain } = options
	const build = runGo(["build", "./..."], { cwd: dir, toolchain })
	const vet = build.status === 0 ? runGo(["vet", "./..."], { cwd: dir, toolchain }) : undefined
	const findings = (vet?.stderr ?? "").split("\n").filter((line) => line !== "" && !line.startsWith("#"))
	const linked = build.status === 0 && options.main !== undefined ? linkOnce(dir, options) : ""
	return {
		built: build.status === 0 && linked === "",
		dir,
		exec: (input) => execIn(dir, input),
		run: () => {
			const result = spawnSync(join(dir, BINARY), [], { cwd: dir, encoding: "utf8", env: goEnv() })
			return { status: result.status ?? 1, stderr: result.stderr, stdout: result.stdout }
		},
		stderr: build.stderr + linked,
		vet: vet?.status === 0 ? [] : findings,
	}
}

/**
 * targets.go: `headerTarget`, `WithHeadersInto` over a new `<Op>Headers` for each plan with typed
 * response headers (F3). Reflection cannot name a Go type by string, so the plans write the code.
 */
function headerTargets(plans: Readonly<Record<string, GoCallPlan>>): string {
	const cases = Object.values(plans).flatMap(({ operation, responseHeaders }) =>
		responseHeaders === null
			? []
			: [
					`\tcase ${JSON.stringify(operation)}:`,
					`\t\th := &sdk.${responseHeaders.type}{}`,
					"\t\treturn sdk.WithHeadersInto(h), h, true",
				],
	)
	return [
		"package main",
		"",
		`import sdk ${DRIVER_IMPORT}`,
		"",
		"// headerTarget is WithHeadersInto over a new <Op>Headers for operation, and that struct; false when",
		"// the operation declares no response headers.",
		"func headerTarget(operation string) (sdk.RequestOption, any, bool) {",
		"\tswitch operation {",
		...cases,
		"\t}",
		"\treturn nil, nil, false",
		"}",
		"",
	].join("\n")
}

/** The driver's sources by file name, with targets.go from `plans`, importing the SDK as `module`. */
function driverSources(module: string, plans: Readonly<Record<string, GoCallPlan>>): Record<string, string> {
	const dir = join(import.meta.dirname, "driver")
	const files = readdirSync(dir)
		.filter((name) => name.endsWith(".go"))
		.map((name) => [name, readFileSync(join(dir, name), "utf8")])
	files.push(["targets.go", headerTargets(plans)])
	return Object.fromEntries(files.map(([name, text]) => [name, text.replaceAll(DRIVER_IMPORT, JSON.stringify(module))]))
}

/** A driver run's stdout as the caller reads it: `Observed[]`, or `{observed, trace}` under a script. */
function parsed(stdout: string, scripted: boolean): { observed: unknown[]; trace?: Trace } {
	if (!scripted) return { observed: JSON.parse(stdout) as unknown[] }
	return JSON.parse(stdout) as { observed: unknown[]; trace: Trace }
}

/**
 * The Go SDK for `document` compiled with the test driver beside it, once per content hash, and
 * `runCalls` sending cells through it by the emitter's call plans for the same options.
 */
export function compiledSdk(document: Record<string, unknown>, options: GoSdkOptions = {}): DrivenSdk {
	return drivenSdk(generateGoSdk(document, options).files, goCallPlans(document, options))
}

/**
 * An SDK module's `files` compiled with the test driver beside it, `runCalls` sending cells by
 * `plans`: for a test that drives files beside the emitted ones (a method of a shape the emitter
 * does not write yet) by plans it derives from the emitter's.
 */
export function drivenSdk(
	files: Readonly<Record<string, string>>,
	plans: Readonly<Record<string, GoCallPlan>>,
): DrivenSdk {
	const module = /^module (\S+)$/m.exec(files["go.mod"] as string)?.[1] as string
	const compiled = compileGo(files, { main: driverSources(module, plans) })
	return {
		...compiled,
		runCalls: async (cell, origins, script) => {
			const input = { alt: origins.alt, base: origins.url, cell, plans, script }
			const ran = await compiled.exec(JSON.stringify(input))
			const out = ran.status === 0 ? parsed(ran.stdout, script !== undefined) : { observed: undefined }
			return { ...out, status: ran.status, stderr: ran.stderr }
		},
	}
}
