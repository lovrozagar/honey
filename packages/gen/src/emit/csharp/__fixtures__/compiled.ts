/**
 * Emitted C#, gated (contract 45 §6.2, Fb9, Fb12): a registry SDK (`FIXTURES`) lands under
 * `$HOME/.cache/honey-tmp/dotnet/sdk/<content hash>/src`, and MSBuild builds it once per hash, offline, warnings as
 * errors, in a private partial dir renamed into place with its `.complete` marker: no worker sees half a dir or
 * builds into another's. Two slot files, taken by exclusive create and stale once their holder is gone, bound the
 * builds at once to two. A gate that finds the marker reads it, touches it for CI's prune and spawns nothing.
 * `format()` runs once per dir, `check(program)` (csc) once per program text; `exec(program)` compiles once and
 * runs beside a hard link of the SDK's dll. `compiledFixture` gates any fixture, `compiledCSharp` a registry
 * entry; driven.ts builds the test driver by the same step.
 */
import { createHash } from "node:crypto"
import {
	existsSync,
	linkSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { generateCSharpSdk } from "../sdk.ts"
import {
	csharpCacheDir,
	execDotnet,
	LEAN_BUILD,
	pinnedDotnet,
	type Ran,
	refPack,
	runCsc,
	runDotnet,
	runtimeConfig,
} from "./csharp-env.ts"
import { type CSharpFixture, FIXTURES, type FixtureKey } from "./documents.ts"

export type { Ran } from "./csharp-env.ts"

export type CSharpSdk = {
	/** `<cache>/sdk/<hash>` */
	readonly dir: string
	/** `<dir>/src`, the files as given */
	readonly src: string
	/** `<dir>/art/bin/<project>/release/<AssemblyName>.dll` */
	readonly dll: string
	/** the project's `AssemblyName` */
	readonly assembly: string
	/** MSBuild built it with no diagnostic (warnings are errors) */
	readonly built: boolean
	/** the build's `path(line,col): error|warning CODE: text` lines, `src/` and the project suffix removed; [] when clean */
	readonly diagnostics: readonly string[]
	/** true when this call spawned MSBuild; a gate the cache answers never does */
	readonly fresh: boolean
	/** `dotnet format whitespace src --folder --verify-no-changes`: its lines, `src/` removed; [] when clean; one run per dir, kept in .format */
	format(): readonly string[]
	/** csc's `(line,col): error CS…` lines for a consumer program against the dll, its path removed; one run per program text */
	check(program: string): readonly string[]
	/** compile once per program text (csc), then run it with `args` and `input` on stdin, without blocking the event loop */
	exec(program: string, input: string, args?: readonly string[]): Promise<Ran>
}

/** A project built once per dir: its outcome, its dll, and whether this call spawned the build. */
export type Built = Pick<CSharpSdk, "assembly" | "built" | "diagnostics" | "dll" | "fresh">

type Files = Readonly<Record<string, string>>

/** A build's outcome, as a dir's marker keeps it. */
type Outcome = { readonly diagnostics: readonly string[]; readonly status: number }

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/* in each content hash: a marker written under another layout is not trusted */
const LAYOUT = "net10-src"

/* csc's flags for a consumer program or check (Fb9): MSBuild's diagnostics for a consumer build, without MSBuild */
const CSC_FLAGS = ["-nologo", "-noconfig", "-nullable:enable", "-warnaserror", "-langversion:latest", "-target:exe"]

/* no package source: every restore is offline against the install's seeded cache (Fb11) */
const NUGET_CONFIG = "<configuration><packageSources><clear /></packageSources></configuration>\n"

/* the builds that may run at once (Fb12), and the age past which a slot's holder is presumed gone */
const SLOTS = 2
const STALE_MS = 10 * 60_000

/** The repo root's pin file: copied beside every gated dir, since SDK lookup walks up from the cwd. */
const globalJson = () => resolve(import.meta.dirname, "../../../../../../global.json")

/** Write `text` beside `path`, then rename: a parallel worker never reads half a file. */
function writeAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true })
	const partial = `${path}.${process.pid}.partial`
	writeFileSync(partial, text)
	renameSync(partial, path)
}

/** `path`'s JSON when it is there, else `make()`'s, written there last. */
function kept<T>(path: string, make: () => T): T {
	if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T
	const made = make()
	writeAtomic(path, JSON.stringify(made))
	return made
}

/** A run's non-empty output lines, stdout then stderr, its spawn error last. */
const linesOf = (run: { error?: Error; stderr: string | null; stdout: string | null }) =>
	`${run.stdout ?? ""}${run.stderr ?? ""}${run.error === undefined ? "" : String(run.error)}`
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.trim() !== "")

/** The lines matching `pattern`, `prefix` and MSBuild's ` [project]` suffix removed, each once; all lines when none match and `failed`. */
function located(lines: readonly string[], pattern: RegExp, prefix: string, failed: boolean): string[] {
	const found = lines
		.filter((line) => pattern.test(line))
		.map((line) => line.replace(/ \[[^\]]*\]$/, "").replaceAll(prefix, ""))
	return found.length > 0 || !failed ? [...new Set(found)] : [...lines]
}

/** Sleep `ms` without yielding: the gates are synchronous. */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Whether the slot at `path` belongs to no live build: its holder's process is gone, or it is older than any build. */
function stale(path: string): boolean {
	try {
		const pid = Number(readFileSync(path, "utf8"))
		if (Date.now() - statSync(path).mtimeMs > STALE_MS) return true
		process.kill(pid, 0)
		return false
	} catch (error) {
		/* a slot freed since is no slot to clear; a live holder we may not signal (EPERM) is alive */
		return (error as NodeJS.ErrnoException).code === "ESRCH"
	}
}

/** `work` run holding one of the build slots, waiting for one to free. */
function inSlot<T>(work: () => T): T {
	const lock = csharpCacheDir("lock")
	for (;;) {
		for (let i = 0; i < SLOTS; i++) {
			const slot = join(lock, `slot-${i}`)
			try {
				writeFileSync(slot, String(process.pid), { flag: "wx" })
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
				if (stale(slot)) rmSync(slot, { force: true })
				continue
			}
			try {
				return work()
			} finally {
				rmSync(slot, { force: true })
			}
		}
		pause(50)
	}
}

/** The one top-level project of `files`, its `AssemblyName` (its file name without one), and where its dll lands. */
function projectOf(dir: string, files: Files) {
	const projects = Object.keys(files).filter((name) => name.endsWith(".csproj") && !name.includes("/"))
	if (projects.length !== 1)
		throw new Error(`a gated project holds one top-level .csproj, not [${projects.join(", ")}]`)
	const project = projects[0] as string
	const name = basename(project, ".csproj")
	const assembly = /<AssemblyName>([^<]+)<\/AssemblyName>/.exec(files[project] as string)?.[1] ?? name
	return { assembly, dll: join(dir, "art/bin", name, "release", `${assembly}.dll`), project }
}

/** MSBuild on `project` in `dir`, offline and lean, into `<dir>/art`: its status and its diagnostics. */
function build(dir: string, project: string): Outcome {
	const args = ["build", `src/${project}`, "-c", "Release", "--artifacts-path", join(dir, "art"), ...LEAN_BUILD]
	const run = runDotnet([...args, "-v", "q", "-clp:NoSummary"], { cwd: dir })
	const status = run.status ?? 1
	const diagnostics = located(linesOf(run), /: (?:error|warning) [A-Z]+\d+: /, `${join(dir, "src")}/`, status !== 0)
	return { diagnostics, status }
}

/**
 * `files` written into `<dir>/src` and built once per dir: in a private partial dir beside it, with the repo's
 * `global.json` and an offline `NuGet.Config`, holding a build slot, then renamed into place with its marker. A
 * lost race keeps the winner's dir; a found marker is read and touched for CI's prune, and nothing is spawned.
 */
export function buildOnce(dir: string, files: Files): Built {
	const { assembly, dll, project } = projectOf(dir, files)
	const complete = join(dir, ".complete")
	const outcome = (fresh: boolean): Built => {
		const { diagnostics, status } = JSON.parse(readFileSync(complete, "utf8")) as Outcome
		return { assembly, built: status === 0 && diagnostics.length === 0, diagnostics, dll, fresh }
	}
	if (existsSync(complete)) {
		utimesSync(complete, new Date(), new Date())
		return outcome(false)
	}
	const partial = `${dir}.${process.pid}.partial`
	rmSync(partial, { force: true, recursive: true })
	for (const [name, text] of Object.entries(files)) writeAtomic(join(partial, "src", name), text)
	writeFileSync(join(partial, "global.json"), readFileSync(globalJson()))
	writeFileSync(join(partial, "NuGet.Config"), NUGET_CONFIG)
	const built = inSlot(() => build(partial, project))
	writeFileSync(join(partial, ".complete"), JSON.stringify(built).replaceAll(partial, dir))
	try {
		renameSync(partial, dir)
	} catch (error) {
		rmSync(partial, { force: true, recursive: true })
		if (!existsSync(complete)) throw error
	}
	return outcome(true)
}

/** The reference pack's assemblies as csc references. */
const references = () =>
	readdirSync(refPack())
		.filter((name) => name.endsWith(".dll"))
		.sort()
		.map((name) => `-r:${join(refPack(), name)}`)

/** csc on `source` against `dll` into `out`, in its dir: its `error CS…` lines, the file's name removed. */
function compile(source: string, dll: string, out: string): { errors: string[]; status: number } {
	const name = basename(source)
	const run = runCsc([...CSC_FLAGS, `-out:${out}`, `-r:${dll}`, ...references(), name], { cwd: dirname(source) })
	const status = run.status ?? 1
	return { errors: located(linesOf(run), /error CS\d+: /, name, status !== 0), status }
}

/** A consumer check: `program` compiled against `dll`, its errors kept in `<dir>/checks/<sha12>.json`. */
function checked(dir: string, dll: string, program: string): readonly string[] {
	const name = sha(program).slice(0, 12)
	return kept(join(dir, "checks", `${name}.json`), () => {
		const source = join(dir, "checks", `${name}.cs`)
		writeAtomic(source, program)
		const out = join(dir, "checks", `${name}.${process.pid}.dll`)
		const { errors } = compile(source, dll, out)
		rmSync(out, { force: true })
		return errors
	})
}

/**
 * `program` compiled once into `<dir>/programs/<sha12>/p.dll` beside its runtime config and a hard link of the
 * SDK's dll, then run there: a program that does not compile answers its errors as stderr, with status 1.
 */
async function executed(dir: string, dll: string, run: { args: readonly string[]; input: string; program: string }) {
	const home = join(dir, "programs", sha(run.program).slice(0, 12))
	if (!existsSync(join(home, ".complete"))) {
		const partial = `${home}.${process.pid}.partial`
		rmSync(partial, { force: true, recursive: true })
		writeAtomic(join(partial, "Program.cs"), run.program)
		const { errors, status } = compile(join(partial, "Program.cs"), dll, join(partial, "p.dll"))
		if (status !== 0) return { status: 1, stderr: errors.join("\n"), stdout: "" }
		writeFileSync(join(partial, "p.runtimeconfig.json"), runtimeConfig())
		linkSync(dll, join(partial, basename(dll)))
		writeFileSync(join(partial, ".complete"), "")
		try {
			renameSync(partial, home)
		} catch {
			rmSync(partial, { force: true, recursive: true })
		}
	}
	return execDotnet(["p.dll", ...run.args], { cwd: home, input: run.input })
}

/** `fixture`'s SDK files: a dependency-free project's own, or the emitter's for a document. */
const sdkFiles = (fixture: CSharpFixture): Files =>
	"files" in fixture ? fixture.files : generateCSharpSdk(fixture.document(), fixture.options).files

/** `fixture`'s SDK written and built under the pinned SDK, once per content hash. */
export function compiledFixture(fixture: CSharpFixture): CSharpSdk {
	const files = sdkFiles(fixture)
	const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	const hash = sha(JSON.stringify({ files: entries, layout: LAYOUT, sdk: pinnedDotnet() })).slice(0, 20)
	const dir = join(csharpCacheDir("sdk"), hash)
	const src = join(dir, "src")
	const gate = buildOnce(dir, files)
	const formatted = () => {
		const run = runDotnet(["format", "whitespace", "src", "--folder", "--verify-no-changes", "-v", "q"], { cwd: dir })
		return run.status === 0 ? [] : located(linesOf(run), / error WHITESPACE: /, `${src}/`, true)
	}
	return {
		assembly: gate.assembly,
		built: gate.built,
		check: (program) => checked(dir, gate.dll, program),
		diagnostics: gate.diagnostics,
		dir,
		dll: gate.dll,
		exec: (program, input, args = []) => executed(dir, gate.dll, { args, input, program }),
		format: () => kept(join(dir, ".format"), formatted),
		fresh: gate.fresh,
		src,
	}
}

/** The registry SDK `key` gated (`compiledFixture`). */
export const compiledCSharp = (key: FixtureKey): CSharpSdk => compiledFixture(FIXTURES[key])
