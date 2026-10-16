/**
 * The one way gen runs Python (G10, G11): every uv, python, ruff and mypy a test, the conformance runner or the
 * harness spawns goes through here. It runs the uv `uv.toml` pins, installed into `$HOME/.cache/honey-tmp/python/uv`
 * by `uvInstall` (never the user's own uv, which it leaves alone), and only the uv-managed interpreters that uv
 * installed under `$HOME/.cache/honey-tmp/python/pythons` with `--no-bin`, so nothing lands in `~/.local/bin`. All
 * caches stay under that dir (never /tmp, 00-rules). Downloads are manual: a missing uv or interpreter fails
 * where Python is required, naming its install, and is never fetched by a run. A structure test forbids a Python
 * spawn elsewhere.
 */
import { type SpawnSyncReturns, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

/** `file` at the repo root. */
const atRoot = (file: string) => resolve(import.meta.dirname, "../../../../../..", file)

/* the cache root as the install commands spell it, for a shell to expand */
const SHELL_ROOT = "$HOME/.cache/honey-tmp/python"

/** `pattern`'s first group in `<repo>/<file>`; throws naming the file when it does not match. */
function pinIn(file: string, pattern: RegExp, what: string): string {
	const text = readFileSync(atRoot(file), "utf8")
	const pin = pattern.exec(text)?.[1]
	if (pin === undefined) throw new Error(`${file} names no ${what}:\n${text}`)
	return pin
}

/** The pinned interpreter, as the repo root's `.python-version` holds it (`3.14.8`). */
export const pinnedPython = (): string => pinIn(".python-version", /^(\d+\.\d+\.\d+)\n?$/, "x.y.z version")

/** The pinned uv, as the repo root's `uv.toml` requires it (`required-version = "==0.13.1"`). */
export const pinnedUv = (): string => pinIn("uv.toml", /^required-version = "==(\d+\.\d+\.\d+)"$/m, "exact uv version")

/**
 * The interpreter the floor legs run under (G10): the oldest the emitted SDK supports. It is not x.y.0: uv has no
 * 3.11.0 build, and 3.11.1 and 3.11.3 need `libcrypt.so.1` (P7). Its minor is the emitted `requires-python`.
 */
export const PY_FLOOR = "3.11.4"

/** Where gen's Python lives: one area under the toolchain cache, made on first use. */
export function pythonCacheDir(...parts: string[]): string {
	const dir = join(process.env.HOME ?? homedir(), ".cache/honey-tmp/python", ...parts)
	mkdirSync(dir, { recursive: true })
	return dir
}

/**
 * The command that installs uv `version` into the honey cache, run by any uv (the user's, or CI's setup-uv), which
 * it leaves as it is: no `uv.toml` (the user's or the repo's) steers it, no Python downloads for the tool's own
 * venv, and its links go in the cache's `uv/bin`, never `~/.local/bin`.
 */
export const uvInstall = (version: string): string =>
	`UV_CACHE_DIR="${SHELL_ROOT}/uv-cache" UV_TOOL_DIR="${SHELL_ROOT}/uv/tools" UV_TOOL_BIN_DIR="${SHELL_ROOT}/uv/bin" uv tool install --no-config --no-python-downloads uv==${version}`

/** The command that installs `versions` with the pinned uv, under the cache and linked nowhere (`--no-bin`). */
export const pythonInstall = (versions: readonly string[]): string =>
	`UV_CACHE_DIR="${SHELL_ROOT}/uv-cache" UV_PYTHON_INSTALL_DIR="${SHELL_ROOT}/pythons" UV_PYTHON_BIN_DIR="${SHELL_ROOT}/pybin" "${SHELL_ROOT}/uv/bin/uv" python install --no-bin ${versions.join(" ")}`

/* the variables a caller's shell may set that would steer a uv, an interpreter or a tool */
const STEERING = /^(?:PYTHON|VIRTUAL_ENV$|CONDA_|UV_|PIP_|MYPY|RUFF_)/

/**
 * The environment every Python command runs with. A caller's `PYTHONPATH`, active venv, conda env or uv, pip,
 * mypy and ruff settings are removed, not blanked. uv reads the repo's `uv.toml` from any cwd, so its pin holds
 * under a cache cwd, and finds only the interpreters it installed: never mise's or the system's.
 */
export function pythonEnv(): NodeJS.ProcessEnv {
	const kept = Object.entries(process.env).filter(([key]) => !STEERING.test(key))
	return {
		...Object.fromEntries(kept),
		NO_COLOR: "1",
		PYTHONNOUSERSITE: "1",
		PYTHONPYCACHEPREFIX: pythonCacheDir("pycache"),
		PYTHONSAFEPATH: "1",
		RUFF_CACHE_DIR: pythonCacheDir("ruff"),
		TMPDIR: pythonCacheDir("tmp"),
		UV_CACHE_DIR: pythonCacheDir("uv-cache"),
		UV_CONFIG_FILE: atRoot("uv.toml"),
		UV_NO_PROGRESS: "1",
		UV_PYTHON_BIN_DIR: pythonCacheDir("pybin"),
		UV_PYTHON_DOWNLOADS: "manual",
		UV_PYTHON_INSTALL_DIR: pythonCacheDir("pythons"),
		UV_PYTHON_PREFERENCE: "only-managed",
	}
}

/** How a Python command runs: in `cwd`, with `input` on stdin. */
type RunOptions = { readonly cwd?: string; readonly input?: string }

/** `command args` under `pythonEnv`. */
function run(command: string, args: readonly string[], options: RunOptions): SpawnSyncReturns<string> {
	return spawnSync(command, [...args], {
		cwd: options.cwd,
		encoding: "utf8",
		env: pythonEnv(),
		input: options.input,
		maxBuffer: 1 << 26,
	})
}

/** The pinned uv on `args`: the binary `uvInstall` put in the cache, never one on PATH. */
export function runUv(args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
	return run(join(pythonCacheDir("uv", "bin"), "uv"), args, options)
}

/** The flags every interpreter runs with: isolated (no cwd, user site or `PYTHON*` on its path), bytecode in the cache. */
const isolated = (args: readonly string[]) => ["-I", "-X", `pycache_prefix=${pythonCacheDir("pycache")}`, ...args]

/** `<venv>/bin/python args`, isolated, under `pythonEnv`. */
export function runPython(dir: string, args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
	return run(join(dir, "bin", "python"), isolated(args), options)
}

/** What an asynchronous run gave back. */
export type Ran = { status: number; stderr: string; stdout: string }

/**
 * `runPython` as a promise, so an in-process server keeps answering meanwhile. A program that exits without
 * reading all of `input` answers by its exit status.
 */
export function execPython(dir: string, args: readonly string[], options: RunOptions = {}): Promise<Ran> {
	return new Promise((done, fail) => {
		const child = spawn(join(dir, "bin", "python"), isolated(args), { cwd: options.cwd, env: pythonEnv() })
		let stdout = ""
		let stderr = ""
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()))
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
		child.once("error", fail)
		child.once("close", (status) => done({ status: status ?? 1, stderr, stdout }))
		child.stdin.on("error", () => {
			/* a program that exits without reading all its input: its exit status answers */
		})
		child.stdin.end(options.input ?? "")
	})
}

/** A venv: the interpreter it runs, what it installs, and the constraints file the install honors. */
export type VenvSpec = {
	readonly constraints?: string
	readonly python: string
	readonly requirements: readonly string[]
}

/** `uv args`, throwing with its stderr when it fails. */
function uvOrThrow(args: readonly string[]): void {
	const result = runUv(args, { cwd: pythonCacheDir("tmp") })
	if (result.status !== 0) throw new Error(`uv ${args.join(" ")} failed: ${result.error?.message ?? result.stderr}`)
}

/**
 * Installs `spec`'s requirements into the venv at `dir`: online the first time this set is fetched, then offline
 * from the wheel cache, which a marker beside the wheels (in the uv cache, so it goes with them) vouches for.
 */
function install(dir: string, spec: VenvSpec, key: string): void {
	const fetched = join(pythonCacheDir("uv-cache"), `.fetched-${key}`)
	const offline = existsSync(fetched)
	const constraints = spec.constraints === undefined ? [] : ["-c", spec.constraints]
	uvOrThrow([
		"pip",
		"install",
		"--python",
		join(dir, "bin", "python"),
		...(offline ? ["--offline"] : []),
		...constraints,
		...spec.requirements,
	])
	if (!offline) writeFileSync(fetched, "")
}

/**
 * The venv for `spec`, made once per content hash under the cache: built in a partial dir, marked `.complete`,
 * then renamed into place, so a venv that is there is whole. A lost rename race keeps the winner's.
 * `--relocatable` keeps its scripts working after the rename.
 */
export function venv(spec: VenvSpec): string {
	const constraints = spec.constraints === undefined ? null : readFileSync(spec.constraints, "utf8")
	const hash = createHash("sha256")
		.update(JSON.stringify({ constraints, python: spec.python, requirements: spec.requirements }))
		.digest("hex")
	const dir = join(pythonCacheDir("venv"), hash.slice(0, 20))
	if (existsSync(join(dir, ".complete"))) return dir
	const partial = `${dir}.${process.pid}.partial`
	rmSync(partial, { force: true, recursive: true })
	try {
		uvOrThrow(["venv", "--relocatable", "--python", spec.python, partial])
		if (spec.requirements.length > 0) install(partial, spec, hash.slice(0, 12))
		writeFileSync(join(partial, ".complete"), "")
		renameSync(partial, dir)
	} catch (error) {
		rmSync(partial, { force: true, recursive: true })
		if (!existsSync(join(dir, ".complete"))) throw error
	}
	return dir
}

/** The venv holding the pinned Python tools, `tools.txt`'s ruff and mypy, under the pinned interpreter. */
const toolsVenv = (): string =>
	venv({
		python: pinnedPython(),
		requirements: readFileSync(join(import.meta.dirname, "tools.txt"), "utf8")
			.split("\n")
			.filter(Boolean),
	})

/**
 * The pinned ruff binary: the formatter adapter spawns this path, so the post-pass runs the pinned ruff whatever
 * the cwd or PATH.
 */
export const ruffPath = (): string => join(toolsVenv(), "bin", "ruff")

/** The pinned ruff on `args`. */
export function runRuff(args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
	return run(ruffPath(), args, options)
}

/** The pinned mypy on `args`, run as a module of the tools venv's interpreter. */
export function runMypy(args: readonly string[], options: RunOptions = {}): SpawnSyncReturns<string> {
	return runPython(toolsVenv(), ["-m", "mypy", ...args], options)
}

/** `uv python find version` under the pin: it fails when the pinned uv or that interpreter is not installed. */
const find = (version: string) => runUv(["python", "find", version], { cwd: pythonCacheDir("tmp") })

/** Whether the pinned uv and interpreter `version` (the pin by default) are installed: nothing is fetched here. */
export function hasPython(version = pinnedPython()): boolean {
	return find(version).status === 0
}

/** Whether a missing Python must fail rather than skip: CI and the pre-push battery set one of these. */
export function pythonRequired(): boolean {
	return process.env.HONEY_REQUIRE_TOOLCHAINS === "1" || process.env.HONEY_REQUIRE_PYTHON === "1"
}

/**
 * Whether a test runs its Python half: false only where Python may be absent. A missing uv or interpreter fails
 * the test where it is required (CI, the pre-push battery), naming both installs, and skips the Python half
 * anywhere else. Callers gate with `describe.skipIf` or `it.skipIf`, never an early return.
 */
export function withPython(version = pinnedPython()): boolean {
	const found = find(version)
	if (found.status !== 0 && pythonRequired())
		throw new Error(
			`Python ${version} is required here (HONEY_REQUIRE_PYTHON or HONEY_REQUIRE_TOOLCHAINS) and is not installed under uv ${pinnedUv()}: ${uvInstall(pinnedUv())}; ${pythonInstall([version])}\n${found.error?.message ?? found.stderr}`,
		)
	return found.status === 0
}
