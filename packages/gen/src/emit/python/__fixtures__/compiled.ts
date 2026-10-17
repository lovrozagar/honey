/**
 * Emitted Python, gated (contract 28 §6.2, Fb8): a registry package (`FIXTURES`, Fb14) lands under
 * `$HOME/.cache/honey-tmp/python/sdk/<content hash>/` and is byte-compiled and imported under the pinned
 * interpreter (or PY_FLOOR), in a venv holding its manifest's dependencies at the pinned (or floor) constraints,
 * or at the newest set they resolve to online (the harness alone, Fe4), once per content hash. Its `.complete`
 * marker holds the gate's outcome, and a gate that finds it reads it, touches it for CI's prune and spawns
 * nothing. `mypy()` runs once per package dir and `check(program)` once per program text, each on a private
 * copy of a per-venv base cache, so no two mypy processes write one cache (mypy has no cache locking).
 * `exec(program)` runs a program against the package, never cached.
 *
 * `compiledFixture` gates any fixture, `compiledPython` a registry entry; driven.ts runs the test driver
 * against a registry entry or the harness files' served document.
 */
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { generatePythonSdk } from "../sdk.ts"
import { FIXTURES, type FixtureKey, type PythonFixture } from "./documents.ts"
import {
	execPython,
	PY_FLOOR,
	pinnedPython,
	pythonCacheDir,
	type Ran,
	resolve,
	runMypy,
	runPython,
	venv,
	type VenvSpec,
} from "./python-env.ts"

export type { Ran } from "./python-env.ts"

/**
 * Which interpreter and dependency set a gate runs under: the pins (the default), the floors (G10.2, Fb11), or
 * the pinned interpreter with the newest set the manifest's dependencies resolve to online at gate time (Fe4,
 * the Python conformance runner alone: a structure test keeps the default run offline).
 */
export type GateOptions = { readonly python?: "pin" | "floor" | "newest" }

/** The ruff rules every emitted file and the committed runtime pass (Fb9), with E501 off: the formatter cannot wrap spec text. */
export const RUFF_SELECT = "E,F,W,I,UP,B,SIM,RUF,FA,PYI,BLE,S"
export const RUFF_IGNORE = "E501"

/** mypy's flags (Fb10): each extra error code its own `--enable-error-code` pair, since the comma form is rejected. */
export const MYPY_FLAGS: readonly string[] = [
	"--strict",
	"--python-version",
	"3.11",
	"--warn-unreachable",
	"--enable-error-code",
	"possibly-undefined",
	"--enable-error-code",
	"redundant-expr",
	"--enable-error-code",
	"truthy-bool",
	"--enable-error-code",
	"ignore-without-code",
	"--enable-error-code",
	"unused-awaitable",
	"--enable-error-code",
	"deprecated",
]

export type PythonSdk = {
	/** the project: pyproject.toml + src/ */
	readonly dir: string
	/** `<dir>/src`, the sys.path entry */
	readonly root: string
	/** the import name */
	readonly package: string
	/** the dependency venv it runs in */
	readonly venv: string
	/** compileall and `import <package>` succeeded under this interpreter */
	readonly imported: boolean
	/** true when this call spawned Python; a gate the cache answers never does */
	readonly fresh: boolean
	readonly stderr: string
	/** mypy's findings under MYPY_FLAGS (`path:line: error: … [code]`); [] when clean; one run per dir, kept in .mypy */
	mypy(): readonly string[]
	/** mypy's findings for a consumer program against this package; one run per program text */
	check(program: string): readonly string[]
	/** run a program with the package root as argv[1] and `input` on stdin, without blocking the event loop */
	exec(program: string, input: string): Promise<Ran>
}

/** A gate's outcome, as a package dir's marker keeps it. */
type Outcome = { readonly status: number; readonly stderr: string }

const sha = (text: string) => createHash("sha256").update(text).digest("hex")

/* in each content hash: a marker written under another layout is not trusted */
const LAYOUT = "src-layout"

const CONSTRAINTS = { floor: "constraints-floor.txt", pin: "constraints.txt" } as const

/** Write `text` beside `path`, then rename: a parallel worker never reads half a file. */
function writeAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true })
	const partial = `${path}.${process.pid}.partial`
	writeFileSync(partial, text)
	renameSync(partial, path)
}

/** `pattern`'s first group in the package's `pyproject.toml`; throws naming what is missing. */
function manifest(files: Readonly<Record<string, string>>, pattern: RegExp, what: string): string {
	const found = pattern.exec(files["pyproject.toml"] ?? "")?.[1]
	if (found === undefined) throw new Error(`compiledFixture: the pyproject.toml names no ${what}`)
	return found
}

/**
 * The newest set `requirements` resolve to under the pinned interpreter, online, written by its content: a gate's
 * hash covers the text as it covers a committed file's, so a set equal to the pins' is the pins' cache hit.
 */
function resolved(requirements: readonly string[]): string {
	const text = resolve(requirements, { python: pinnedPython(), resolution: "highest" })
	const path = join(pythonCacheDir("resolved"), `${sha(text).slice(0, 20)}.txt`)
	if (!existsSync(path)) writeAtomic(path, text)
	return path
}

/** What a gate runs in: the interpreter, the dependency strings the manifest declares, and their constraints file. */
function venvSpec(files: Readonly<Record<string, string>>, python: NonNullable<GateOptions["python"]>): VenvSpec {
	const requirements = JSON.parse(manifest(files, /^dependencies = (\[.*\])$/m, "dependencies line")) as string[]
	const interpreter = python === "floor" ? PY_FLOOR : pinnedPython()
	if (requirements.length === 0) return { python: interpreter, requirements }
	const constraints = python === "newest" ? resolved(requirements) : join(import.meta.dirname, CONSTRAINTS[python])
	return { constraints, python: interpreter, requirements }
}

/** `run`'s exit status and stderr, its spawn error included. */
const outcomeOf = (run: { error?: Error; status: number | null; stderr: string | null }): Outcome => ({
	status: run.status ?? 1,
	stderr: (run.stderr ?? "") + (run.error === undefined ? "" : String(run.error)),
})

/** compileall over `root`, then `import <package>` with `root` on sys.path: the first failure's outcome, or both clean. */
function gate(env: string, root: string, pkg: string): Outcome {
	const compiled = outcomeOf(runPython(env, ["-m", "compileall", "-q", root]))
	if (compiled.status !== 0) return compiled
	return outcomeOf(runPython(env, ["-c", `import sys; sys.path.insert(0, sys.argv[1]); import ${pkg}`, root]))
}

/** `path`'s JSON when it is there, else `make()`'s, written there last. */
function kept<T>(path: string, make: () => T): T {
	if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as T
	const made = make()
	writeAtomic(path, JSON.stringify(made))
	return made
}

/**
 * The mypy cache every gate of `env`'s packages starts from: the stdlib, typeshed and the venv's dependencies,
 * analyzed once over a seed module into a partial dir that is then renamed into place (a lost race keeps the winner's).
 */
function mypyBase(env: string, dependencies: boolean): string {
	const tools = readFileSync(join(import.meta.dirname, "tools.txt"), "utf8")
	const base = join(pythonCacheDir("mypy"), sha(JSON.stringify({ env, python: pinnedPython(), tools })).slice(0, 20))
	if (existsSync(join(base, ".complete"))) return base
	const partial = `${base}.${process.pid}.partial`
	rmSync(partial, { force: true, recursive: true })
	mkdirSync(partial, { recursive: true })
	const imports = ["asyncio", "contextlib", "dataclasses", "json", "random", "threading", "typing", "urllib.parse"]
	writeFileSync(
		join(partial, "seed.py"),
		imports
			.concat(dependencies ? ["httpx2"] : [])
			.map((m) => `import ${m}\n`)
			.join(""),
	)
	const seeded = outcomeOf(mypyIn(env, join(partial, "cache"), ["seed.py"], partial))
	if (seeded.status !== 0) throw new Error(`mypy's base cache failed to seed:\n${seeded.stderr}`)
	writeFileSync(join(partial, ".complete"), "")
	try {
		renameSync(partial, base)
	} catch (error) {
		rmSync(partial, { force: true, recursive: true })
		if (!existsSync(join(base, ".complete"))) throw error
	}
	return base
}

/** mypy under MYPY_FLAGS against `env`'s interpreter, on `targets`, with its cache at `cache`. */
const mypyIn = (env: string, cache: string, targets: readonly string[], cwd: string) =>
	runMypy([...MYPY_FLAGS, "--python-executable", join(env, "bin", "python"), "--cache-dir", cache, ...targets], { cwd })

/** mypy's findings on `targets` in `cwd`, on a private copy of `base`'s cache that is removed after. */
function findings(env: string, base: string, targets: readonly string[], cwd: string): string[] {
	const copy = join(cwd, `.mypy_cache.${process.pid}`)
	cpSync(join(base, "cache"), copy, { recursive: true })
	try {
		const run = mypyIn(env, copy, targets, cwd)
		if (run.status === 0) return []
		const lines = `${run.stdout ?? ""}${run.stderr ?? ""}`.split("\n").filter((line) => line.trim() !== "")
		const located = lines.filter((line) => /^[^\s:][^:]*:\d+: error: /.test(line))
		return located.length > 0 ? located : lines
	} finally {
		rmSync(copy, { force: true, recursive: true })
	}
}

/** `fixture`'s package files: a dependency-free package's own, or the emitter's for a document. */
const packageFiles = (fixture: PythonFixture): Readonly<Record<string, string>> =>
	"files" in fixture ? fixture.files : generatePythonSdk(fixture.document(), fixture.options).files

/** `fixture`'s package written and gated under the pins (or the floors), once per content hash. */
export function compiledFixture(fixture: PythonFixture, options: GateOptions = {}): PythonSdk {
	const files = packageFiles(fixture)
	const python = options.python ?? "pin"
	const spec = venvSpec(files, python)
	const pkg = manifest(files, /^packages = \["src\/([^"]+)"\]$/m, "wheel package")
	const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	const constraints = spec.constraints === undefined ? null : readFileSync(spec.constraints, "utf8")
	const hash = sha(JSON.stringify({ constraints, files: entries, layout: LAYOUT, python: spec.python })).slice(0, 20)
	const dir = pythonCacheDir("sdk", hash)
	const root = join(dir, "src")
	let env: string | undefined
	/* resolved on first use: a gate the cache answers needs no venv, and a pruned one is rebuilt only when used */
	const venvDir = () => (env ??= venv(spec))
	const complete = join(dir, ".complete")
	/* touched for CI's prune, which keeps only the dirs a run used */
	if (existsSync(complete)) utimesSync(complete, new Date(), new Date())
	let fresh = false
	const outcome = kept<Outcome>(complete, () => {
		fresh = true
		for (const [name, text] of entries) writeAtomic(join(dir, name), text)
		return gate(venvDir(), root, pkg)
	})
	const base = () => mypyBase(venvDir(), spec.requirements.length > 0)
	return {
		check: (program) => {
			const name = sha(program).slice(0, 12)
			return kept(join(dir, "checks", `${name}.json`), () => {
				writeAtomic(join(dir, "checks", `${name}.ini`), `[mypy]\nmypy_path = ${root}\n`)
				writeAtomic(join(dir, "checks", `${name}.py`), program)
				return findings(venvDir(), base(), ["--config-file", `checks/${name}.ini`, `checks/${name}.py`], dir)
			})
		},
		dir,
		exec: (program, input) => {
			const path = join(dir, "programs", `${sha(program).slice(0, 12)}.py`)
			if (!existsSync(path)) writeAtomic(path, program)
			return execPython(venvDir(), [path, root], { cwd: dir, input })
		},
		fresh,
		imported: outcome.status === 0,
		mypy: () => kept(join(dir, ".mypy"), () => findings(venvDir(), base(), ["-p", pkg], root)),
		package: pkg,
		root,
		stderr: outcome.stderr,
		get venv() {
			return venvDir()
		},
	}
}

/** The registry package `key` gated (`compiledFixture`). */
export const compiledPython = (key: FixtureKey, options: GateOptions = {}): PythonSdk =>
	compiledFixture(FIXTURES[key], options)
