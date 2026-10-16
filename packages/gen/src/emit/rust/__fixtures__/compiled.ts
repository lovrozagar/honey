/**
 * Emitted Rust, compiled (contract 18 §7.2): a registry crate (`FIXTURES`, Fb5) lands under
 * `$HOME/.cache/honey-tmp/rust/sdk/<content hash>/` and builds with the pinned toolchain (rust-env) into the
 * shared target dir, once per content hash. Its `.complete` marker holds the build's outcome, and a compile
 * that finds it reads it, touches it for CI's prune and spawns no cargo. Builds run `--locked --offline`
 * after one `cargo fetch` per lock and toolchain. A floor leg passes `toolchain: RUST_FLOOR` with `check`;
 * `clippy()` runs once per crate dir under `-D clippy::incompatible_msrv`.
 *
 * A program (the driver, a consumer) builds as a bin in a copy of the crate (Fb6), a content-hashed dir of
 * its own, so the shipped crate stays exactly as emitted and its lock stays valid under `--locked`: a bin
 * uses only the package's own dependencies. The copy's hash names the bin, which keeps the binaries of
 * every copy apart in the shared target dir.
 *
 * `drivenRustSdk` is that with the test driver (`driver/*.rs` and a `dispatch.rs` written from the entry's
 * call plans) as the program, `runCalls` sending a grid cell through it (the shared driver protocol).
 */
import { spawn, type SpawnSyncReturns } from "node:child_process"
import { createHash } from "node:crypto"
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import type { Script, Trace } from "../../shared/__fixtures__/protocol.ts"
import type { RustCallPlan } from "../sdk-plan.ts"
import { generateRustSdk, rustCallPlans } from "../sdk.ts"
import { dispatchRs } from "./dispatch.ts"
import { FIXTURES, type FixtureKey, type RustFixture } from "./documents.ts"
import { runCargo, rustCacheDir, rustEnv } from "./rust-env.ts"

/** A program's run: its exit status and output. */
export type Ran = { status: number; stderr: string; stdout: string }

/** A program: one `main.rs`, or its files by name (`main.rs` among them). */
export type Program = string | Readonly<Record<string, string>>

/** How a crate compiles: a toolchain in place of the pin, `cargo check` in place of a build, programs beside it. */
export type CompileOptions = {
	readonly check?: true
	readonly programs?: Readonly<Record<string, Program>>
	/** the Rust version (`1.85.0`) every cargo command runs under in place of the pin: the floor legs pass RUST_FLOOR */
	readonly toolchain?: string
}

export type RustCrate = {
	readonly built: boolean
	readonly dir: string
	/** true when this call spawned cargo; a compile the cache answers never does */
	readonly fresh: boolean
	readonly stderr: string
	/** clippy's findings under `-D warnings -D clippy::incompatible_msrv`, short form; [] when clean (one spawn per dir) */
	clippy(): readonly string[]
	/** run program `name` with `input` on stdin, without blocking the event loop */
	exec(name: string, input: string): Promise<Ran>
}

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
	): Promise<DriverRun & { readonly trace?: Trace }>
}

/** A cargo command's outcome, as a crate dir's marker keeps it. */
type Outcome = { readonly status: number; readonly stderr: string }

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

const outcomeOf = (run: SpawnSyncReturns<string>): Outcome => ({
	status: run.status ?? 1,
	stderr: (run.stderr ?? "") + (run.error === undefined ? "" : String(run.error)),
})

/** A fixture's crate: a dependency-free crate's own files (no call plans), or the emitter's crate and call plans for a document. */
function emitted(fixture: RustFixture): {
	readonly files: Readonly<Record<string, string>>
	readonly plans: Readonly<Record<string, RustCallPlan>>
} {
	if ("files" in fixture) return { files: fixture.files, plans: {} }
	const document = fixture.document()
	return { files: generateRustSdk(document, fixture.options).files, plans: rustCallPlans(document, fixture.options) }
}

/** Write `text` beside `path`, then rename: a parallel worker never reads half a file. */
function writeAtomic(path: string, text: string | Buffer): void {
	mkdirSync(dirname(path), { recursive: true })
	const partial = `${path}.${process.pid}.partial`
	writeFileSync(partial, text)
	renameSync(partial, path)
}

/**
 * `dir`'s outcome: read from its `.complete` marker, touched for CI's prune (ci.yml keeps only the dirs a run
 * used), with no spawn; or `build` run and its outcome written last.
 */
function once(dir: string, build: () => Outcome): Outcome & { readonly fresh: boolean } {
	const complete = join(dir, ".complete")
	if (existsSync(complete)) {
		utimesSync(complete, new Date(), new Date())
		return { ...(JSON.parse(readFileSync(complete, "utf8")) as Outcome), fresh: false }
	}
	const outcome = build()
	writeAtomic(complete, JSON.stringify(outcome))
	return { ...outcome, fresh: true }
}

/**
 * The lock's crates fetched once per lock and toolchain, online: every build after it runs `--offline`. A
 * failed fetch is the network's, not the crate's, so it throws and no marker keeps it.
 */
function fetch(dir: string, lock: string, toolchain: string | undefined): void {
	const marker = join(rustCacheDir("cargo"), `.fetched-${sha(JSON.stringify({ lock, toolchain })).slice(0, 12)}`)
	if (existsSync(marker)) return
	const fetched = outcomeOf(runCargo(["fetch", "--locked"], { cwd: dir, toolchain }))
	if (fetched.status !== 0) throw new Error(`cargo fetch --locked failed in ${dir}:\n${fetched.stderr}`)
	writeAtomic(marker, "")
}

/** `files` written into `dir` (fetched first if the lock is new) and built or checked as a library. */
function buildCrate(dir: string, files: Readonly<Record<string, string>>, options: CompileOptions): Outcome {
	for (const [name, text] of Object.entries(files)) writeAtomic(join(dir, name), text)
	fetch(dir, files["Cargo.lock"] ?? "", options.toolchain)
	const verb = options.check ? "check" : "build"
	return outcomeOf(runCargo([verb, "--locked", "--offline", "--lib"], { cwd: dir, toolchain: options.toolchain }))
}

/** A built program: the copy it built in, and its outcome. */
type Built = Outcome & { readonly dir: string; readonly fresh: boolean }

/** The crate a program builds beside: its content hash, its files, the toolchain in place of the pin. */
type Crate = { readonly files: Readonly<Record<string, string>>; readonly hash: string; readonly toolchain?: string }

/**
 * Program `name` built as a bin in a copy of the crate `files` (its own dir, keyed by the crate's hash and the
 * program), its binary copied out of the shared target dir to `<copy>/bin/<name>`.
 */
function buildProgram({ files, hash: crate, toolchain }: Crate, name: string, program: Program): Built {
	const hash = sha(JSON.stringify({ crate, name, program })).slice(0, 20)
	const dir = rustCacheDir("sdk", hash)
	const bin = `${name}_${hash.slice(0, 10)}`
	const outcome = once(dir, () => {
		const sources =
			typeof program === "string"
				? { [`${bin}.rs`]: program }
				: Object.fromEntries(Object.entries(program).map(([file, text]) => [`${bin}/${file}`, text]))
		for (const [file, text] of Object.entries(files)) writeAtomic(join(dir, file), text)
		for (const [file, text] of Object.entries(sources)) writeAtomic(join(dir, "src/bin", file), text)
		const build = outcomeOf(runCargo(["build", "--locked", "--offline", "--bin", bin], { cwd: dir, toolchain }))
		if (build.status === 0) {
			const partial = join(dir, "bin", `${name}.${process.pid}.partial`)
			mkdirSync(dirname(partial), { recursive: true })
			copyFileSync(join(rustEnv(toolchain).CARGO_TARGET_DIR as string, "debug", bin), partial)
			renameSync(partial, join(dir, "bin", name))
		}
		return build
	})
	return { ...outcome, dir }
}

/** clippy's findings in `dir`, kept in `<dir>/.clippy`: its short-form diagnostics, or its whole stderr when it fails without one. */
function clippyOnce(dir: string, toolchain: string | undefined): readonly string[] {
	const kept = join(dir, ".clippy")
	if (!existsSync(kept)) {
		const args = ["clippy", "--locked", "--offline", "--lib", "--message-format", "short"]
		const run = outcomeOf(
			runCargo([...args, "--", "-D", "warnings", "-D", "clippy::incompatible_msrv"], { cwd: dir, toolchain }),
		)
		const lines = run.stderr.split("\n").filter((line) => line.trim() !== "")
		const located = lines.filter((line) => /^[^\s:]+:\d+:\d+: (?:error|warning)/.test(line))
		writeAtomic(kept, JSON.stringify(run.status === 0 ? [] : located.length > 0 ? located : lines))
	}
	return JSON.parse(readFileSync(kept, "utf8")) as string[]
}

/** `binary` run with `input` on stdin, as a promise: an in-process server keeps answering meanwhile. */
function execIn(binary: string, input: string): Promise<Ran> {
	return new Promise((resolve, reject) => {
		const child = spawn(binary, [], { cwd: dirname(binary), env: process.env })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.once("error", reject)
		child.once("close", (status) => resolve({ status: status ?? 1, stderr, stdout }))
		child.stdin.on("error", () => {
			/* a program that exits without reading all its input: its exit status answers */
		})
		child.stdin.end(input)
	})
}

/**
 * The registry crate `key` built (or checked) at the pinned toolchain (or `toolchain`), once per content hash,
 * with each of `programs` built in a copy of it.
 */
export function compiledRust(key: FixtureKey, options: CompileOptions = {}): RustCrate {
	if (options.check && options.programs !== undefined) throw new Error("compiledRust: a check builds no programs")
	const { files } = emitted(FIXTURES[key])
	const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	const hash = sha(JSON.stringify({ check: options.check, files: entries, toolchain: options.toolchain })).slice(0, 20)
	const dir = rustCacheDir("sdk", hash)
	const crate = once(dir, () => buildCrate(dir, files, options))
	const programs = new Map<string, Built>()
	for (const [name, program] of Object.entries(crate.status === 0 ? (options.programs ?? {}) : {}))
		programs.set(name, buildProgram({ files, hash, toolchain: options.toolchain }, name, program))
	const all = [crate, ...programs.values()]
	return {
		built: all.every(({ status }) => status === 0),
		clippy: () => clippyOnce(dir, options.toolchain),
		dir,
		exec: (name, input) => {
			const program = programs.get(name)
			if (program?.status !== 0)
				return Promise.reject(new Error(`no program ${name} built here: ${[...programs.keys()].join(", ")}`))
			return execIn(join(program.dir, "bin", name), input)
		},
		fresh: all.some(({ fresh }) => fresh),
		stderr: all.map(({ stderr }) => stderr).join(""),
	}
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
function parsed(stdout: string, scripted: boolean): { observed: unknown[]; trace?: Trace } {
	if (!scripted) return { observed: JSON.parse(stdout) as unknown[] }
	return JSON.parse(stdout) as { observed: unknown[]; trace: Trace }
}

/**
 * The registry SDK `key` compiled with the test driver beside it, and `runCalls` sending cells through it by
 * the emitter's call plans for the entry's own options.
 */
export function drivenRustSdk(key: FixtureKey): DrivenRustSdk {
	const fixture: RustFixture = FIXTURES[key]
	const { plans } = emitted(fixture)
	const throwOnError = !("document" in fixture && fixture.options?.throwOnError === false)
	const crate = compiledRust(key, { programs: { driver: driverSources(plans, throwOnError) } })
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
