/**
 * Toolchain parity (G10): gen runs Go only through `src/emit/go/__fixtures__/go-env.ts`, which pins
 * the toolchain `.go-version` names. A file that spawns `go` or `gofmt` — or lists either as a
 * command — without going through it would run whatever Go the machine has, the gap that let a
 * richer local toolchain hide a CI failure in bit 11.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const GEN = resolve(import.meta.dirname, "../..")
const ROOTS = ["src", "tests", "scripts"]

/* a spawn of go or gofmt, or a list of commands whose entry starts with one (a list of target names is not one) */
const GO_COMMAND = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*"(?:go|gofmt)"|\[\[\s*"(?:go|gofmt)",/

/** Every TS file under `dir`, recursively. */
function tsFiles(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(path).isDirectory()) return name === "_tokenizer" ? [] : tsFiles(path)
		return name.endsWith(".ts") ? [path] : []
	})
}

describe("Go runs at the pinned toolchain only", () => {
	it("leaves no gen file running go or gofmt except through go-env.ts", () => {
		const bypass = ROOTS.flatMap((root) => tsFiles(join(GEN, root)))
			.filter((path) => !path.endsWith("go-env.ts") && !path.endsWith("go-toolchain.test.ts"))
			.filter((path) => {
				const text = readFileSync(path, "utf8")
				return GO_COMMAND.test(text) && !/from "[^"]*go-env\.ts"/.test(text)
			})
			.map((path) => relative(GEN, path))
		expect(bypass).toEqual([])
	})

	it("recognizes a raw spawn and a command list as running Go", () => {
		expect(
			['spawnSync("go", ["build"])', 'run: [["gofmt", "-l"]]', 'spawnSync("node")', '["go", "python", "rust"]'].map(
				(t) => GO_COMMAND.test(t),
			),
		).toEqual([true, true, false, false])
	})
})
