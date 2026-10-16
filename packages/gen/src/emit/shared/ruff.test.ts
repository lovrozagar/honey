/**
 * The Python post-pass (R2, Fb9): `ruffFormatter` as a `Formatter` for `formatFiles` under the extension key `py`,
 * every ruff the pinned one (python-env's `ruffPath`), and no configuration but its own (`--isolated`, honey-a8).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { pythonCacheDir, ruffPath, runRuff, withPython } from "../python/__fixtures__/python-env.ts"
import { EMIT_STYLE, formatFiles } from "./format.ts"
import { ruffFormatter } from "./ruff.ts"

const UNFORMATTED = "def add(a:int,b:int)->int:\n  return a+b\n"
/* four spaces and 88 columns, whatever EMIT_STYLE says: ruff has its own layout and the adapter passes it no options */
const FORMATTED = "def add(a: int, b: int) -> int:\n    return a + b\n"
/* the same under a consumer's `[tool.ruff] line-length = 20` */
const NARROW = "def add(\n    a: int, b: int\n) -> int:\n    return a + b\n"

/** Whether Python is here: a missing toolchain fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()

/** The adapter over the pinned ruff. */
const ruff = () => ruffFormatter(ruffPath())

describe("ruffFormatter: the Python post-pass (R2), under the extension key py", () => {
	it.skipIf(!PY)("formats every Python file with the pinned ruff and leaves any other file as it is", async () => {
		const files = await formatFiles(
			{ "a.go": "package x\n", "a.py": UNFORMATTED, "pyproject.toml": "[project]\n", "src/pkg/b.py": UNFORMATTED },
			{ py: ruff() },
		)
		expect(files).toEqual({
			"a.go": "package x\n",
			"a.py": FORMATTED,
			"pyproject.toml": "[project]\n",
			"src/pkg/b.py": FORMATTED,
		})
	})

	it.skipIf(!PY)("reports a file ruff cannot parse as an error, naming it", async () => {
		await expect(formatFiles({ "bad.py": "def (\n" }, { py: ruff() })).rejects.toThrow(
			/could not format bad\.py: .*Failed to parse bad\.py:1:5/,
		)
	})

	it.skipIf(!PY)("answers a non-zero exit with the source as given and ruff's stderr", async () => {
		const source = "def (\n"
		expect(await ruff()("bad.py", source, EMIT_STYLE)).toEqual({
			code: source,
			errors: [expect.stringMatching(/^error: Failed to parse bad\.py:1:5: Expected an identifier/)],
		})
	})

	it("reports a ruff it cannot run as an error rather than passing the file through", async () => {
		const { code, errors } = await ruffFormatter("/nonexistent/ruff")("a.py", UNFORMATTED, EMIT_STYLE)
		expect({ code, errors: errors.length }).toEqual({ code: UNFORMATTED, errors: 1 })
	})
})

describe("ruffFormatter: a ruff that stops reading", () => {
	it("answers with its failure when the binary exits before taking the input", async () => {
		const source = `def main() -> None: ...\n# ${"x".repeat(1 << 22)}\n`
		const { code, errors } = await ruffFormatter("false")("big.py", source, EMIT_STYLE)
		expect([code === source, errors.length]).toEqual([true, 1])
	})
})

describe("ruffFormatter: no configuration but its own", () => {
	it.skipIf(!PY)(
		"ignores a [tool.ruff] in the cwd's ancestors: line-length 20 there leaves the output at 88 columns",
		async () => {
			const root = mkdtempSync(join(pythonCacheDir("tmp"), "ruff-toml-"))
			const cwd = join(root, "pkg", "src")
			mkdirSync(cwd, { recursive: true })
			writeFileSync(join(root, "pyproject.toml"), "[tool.ruff]\nline-length = 20\n")
			const back = process.cwd()
			try {
				/* the fixture bites: ruff on stdin, not isolated, takes the ancestor's line length */
				const plain = runRuff(["format", "--stdin-filename", join(cwd, "a.py"), "-"], { cwd, input: UNFORMATTED })
				expect(plain.stdout, plain.stderr).toBe(NARROW)
				/* the adapter takes no cwd: it spawns in the process's own, under a relative name and an absolute one */
				process.chdir(cwd)
				const format = ruff()
				expect([
					await format("a.py", UNFORMATTED, EMIT_STYLE),
					await format(join(cwd, "a.py"), UNFORMATTED, EMIT_STYLE),
				]).toEqual([
					{ code: FORMATTED, errors: [] },
					{ code: FORMATTED, errors: [] },
				])
			} finally {
				process.chdir(back)
				rmSync(root, { force: true, recursive: true })
			}
		},
	)
})
