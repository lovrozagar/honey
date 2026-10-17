/**
 * The ruff gate every emitted-package check shares (Ff5): the files through the ruff post-pass under the pinned
 * ruff, then `ruff format --check` and Fb9's rule list over the result, which files the pass reached, and any
 * suppression in the emitted text. It takes files, never the emitter, so it reaches no runtime module and a suite
 * can import it above a mutant's mock.
 */
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { type Formatter, formatFiles } from "../../shared/format.ts"
import { ruffFormatter } from "../../shared/ruff.ts"
import { pythonCacheDir, ruffPath, runRuff } from "./python-env.ts"

/**
 * The ruff rules every emitted file and the committed runtime pass (Fb9, amended by Ff6), with E501 off because
 * the formatter cannot wrap spec text, and E741/E742/E743 off because a wire key or spec name (`l`, `O`, `I`) is
 * not the emitter's to rename.
 */
export const RUFF_SELECT = "E,F,W,I,UP,B,SIM,RUF,FA,PYI,BLE,S"
export const RUFF_IGNORE = "E501,E741,E742,E743"

/** Both ruff gates with nothing to report. */
export const CLEAN = { check: { out: "", status: 0 }, format: { out: "", status: 0 } }

/* a suppression in emitted text: ruff's (`noqa`, file-level too), mypy's and pyright's */
const SUPPRESSION = /noqa|type:\s*ignore|pyright:\s*ignore/i

/** `files`' `.py` names, sorted. */
export const pythonNames = (files: Readonly<Record<string, string>>) =>
	Object.keys(files)
		.filter((name) => name.endsWith(".py"))
		.sort()

/** `files` through the ruff pass, and every name the pass handed ruff, sorted. */
export async function formatted(files: Readonly<Record<string, string>>) {
	const ruff = ruffFormatter(ruffPath())
	const seen: string[] = []
	const counting: Formatter = (name, source, options) => {
		seen.push(name)
		return ruff(name, source, options)
	}
	return { files: await formatFiles(files, { py: counting }), seen: seen.sort() }
}

/** `files` written into a dir of their own under the Python cache, named by their content. */
export function written(prefix: string, files: Readonly<Record<string, string>>): string {
	const entries = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	const hash = createHash("sha256").update(JSON.stringify(entries)).digest("hex").slice(0, 20)
	const dir = pythonCacheDir("tmp", `${prefix}-${hash}`)
	for (const [name, text] of entries) {
		mkdirSync(dirname(join(dir, name)), { recursive: true })
		writeFileSync(join(dir, name), text)
	}
	return dir
}

/** `ruff format --check` and `ruff check` under Fb9's list over `dir`, run there as its project root. */
export function ruffGates(dir: string) {
	const format = runRuff(["format", "--isolated", "--target-version", "py311", "--check", "."], { cwd: dir })
	const check = runRuff(
		["check", "--isolated", "--target-version", "py311", "--select", RUFF_SELECT, "--ignore", RUFF_IGNORE, "."],
		{ cwd: dir },
	)
	return {
		check: { status: check.status, out: check.status === 0 ? "" : check.stdout + check.stderr },
		format: { status: format.status, out: format.status === 0 ? "" : format.stdout + format.stderr },
	}
}

/**
 * An emitted package's ruff gate: both gates over `files` after the pass, every name the pass reached (the key
 * `py` reaches every Python file: a mismatched key would skip them all silently), and the files that carry a
 * suppression as emitted. Clean is `{ ...CLEAN, reached: pythonNames(files), suppressed: [] }`.
 */
export async function ruffGate(files: Readonly<Record<string, string>>) {
	const pass = await formatted(files)
	return {
		...ruffGates(written("fmt", pass.files)),
		reached: pass.seen,
		suppressed: Object.keys(files).filter((name) => SUPPRESSION.test(files[name] ?? "")),
	}
}
