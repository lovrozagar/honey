import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

/**
 * Python for the SDK harness. Resolution order:
 *   1. `HONEY_PYTHON`, used as given (CI points it at its own interpreter);
 *   2. the workspace venv `.cache/python-venv`, which `ensurePython()` creates and fills from
 *      `python-requirements.txt` before the harness runs;
 *   3. `python3` on PATH.
 * The venv's bin directory is put first on PATH, so `ruff` and `mypy` resolve from it too.
 */
const HERE = dirname(fileURLToPath(import.meta.url))
export const PYTHON_REQUIREMENTS = join(HERE, "python-requirements.txt")
export const PYTHON_VENV = join(HERE, "../../../.cache/python-venv")

const isWindows = process.platform === "win32"
const VENV_BIN = join(PYTHON_VENV, isWindows ? "Scripts" : "bin")
const VENV_PYTHON = join(VENV_BIN, isWindows ? "python.exe" : "python")
const STAMP = join(PYTHON_VENV, ".requirements.sha256")

function requirementsHash(): string {
	return createHash("sha256").update(readFileSync(PYTHON_REQUIREMENTS)).digest("hex")
}

function venvReady(): boolean {
	return existsSync(VENV_PYTHON) && existsSync(STAMP) && readFileSync(STAMP, "utf8") === requirementsHash()
}

export const PYTHON: string = process.env.HONEY_PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3")

if (process.env.HONEY_PYTHON === undefined && existsSync(VENV_PYTHON)) {
	process.env.PATH = `${VENV_BIN}${delimiter}${process.env.PATH ?? ""}`
}

/** True when `PYTHON` can import every module in `modules`. */
export function pythonHas(...modules: string[]): boolean {
	const code = modules.length === 0 ? "pass" : `import ${modules.join(", ")}`
	return spawnSync(PYTHON, ["-c", code], { stdio: "ignore" }).status === 0
}

type Outcome = { ok: true; python: string; created: boolean } | { ok: false; reason: string }

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
	const r = spawnSync(cmd, args, { encoding: "utf8" })
	return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}` }
}

/**
 * Make sure the harness has a usable Python, creating or refreshing the workspace venv when
 * `HONEY_PYTHON` is unset. Never throws; the caller decides whether a failure skips or fails.
 */
export function ensurePython(): Outcome {
	const probe = "import httpx, websockets, mypy"
	if (process.env.HONEY_PYTHON !== undefined) {
		const py = process.env.HONEY_PYTHON
		const r = run(py, ["-c", probe])
		return r.ok
			? { ok: true, python: py, created: false }
			: { ok: false, reason: `HONEY_PYTHON=${py} cannot import the harness requirements:\n${r.out}` }
	}
	if (venvReady()) return { ok: true, python: VENV_PYTHON, created: false }

	const base = isWindows ? "python" : "python3"
	if (!run(base, ["--version"]).ok) return { ok: false, reason: `${base} is not on PATH` }

	if (!existsSync(VENV_PYTHON)) {
		mkdirSync(dirname(PYTHON_VENV), { recursive: true })
		const venv = run(base, ["-m", "venv", PYTHON_VENV])
		if (!venv.ok) {
			rmSync(PYTHON_VENV, { force: true, recursive: true })
			return { ok: false, reason: `${base} -m venv failed (is the venv module installed?):\n${venv.out}` }
		}
	}
	const install = run(VENV_PYTHON, [
		"-m",
		"pip",
		"install",
		"--disable-pip-version-check",
		"--quiet",
		"-r",
		PYTHON_REQUIREMENTS,
	])
	if (!install.ok)
		return { ok: false, reason: `pip install -r ${PYTHON_REQUIREMENTS} failed (offline?):\n${install.out}` }
	writeFileSync(STAMP, requirementsHash())
	return { ok: true, python: VENV_PYTHON, created: true }
}
