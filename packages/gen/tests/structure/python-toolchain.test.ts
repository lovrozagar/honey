/**
 * Toolchain parity (G10, G11) for Python: gen runs Python only through `src/emit/python/__fixtures__/python-env.ts`,
 * under the uv `uv.toml` pins and the interpreters `.python-version` and `PY_FLOOR` name, all inside
 * `$HOME/.cache/honey-tmp/python` (the uv a bootstrap installs there, never the user's own), and CI installs
 * exactly those, so a local run and a CI run use the same uv and interpreters to the patch. As with Rust,
 * importing the env file does not license a raw spawn: every uv, python, ruff and mypy goes through its
 * runners. Nothing lands in `~/.local/bin`.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as env from "../../src/emit/python/__fixtures__/python-env.ts"

const { PY_FLOOR, pinnedPython, pinnedUv, pythonCacheDir, pythonInstall, runPython, uvInstall, venv, withPython } = env

const GEN = resolve(import.meta.dirname, "../..")
const ROOTS = ["src", "tests", "scripts"]
const SELF = "tests/structure/python-toolchain.test.ts"
const ENV = "src/emit/python/__fixtures__/python-env.ts"

/* a spawn of a Python tool, or a list of commands whose entry starts with one (a list of language names is not one) */
const PY_COMMAND =
	/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*"(?:python[0-9.]*|uvx?|ruff|mypy|pip3?|pyright)"|\[\[\s*"(?:python[0-9.]*|uvx?|ruff|mypy|pip3?)",/

/** Every TS file under `dir`, recursively, gen-relative. */
function tsFiles(dir: string): string[] {
	return readdirSync(join(GEN, dir)).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(join(GEN, path)).isDirectory()) return name === "_tokenizer" ? [] : tsFiles(path)
		return name.endsWith(".ts") ? [path] : []
	})
}

/** Every gen TS file but this one and the env file, with its text. */
const others = () =>
	ROOTS.flatMap(tsFiles)
		.filter((path) => path !== SELF && path !== ENV)
		.map((path) => ({ path, text: readFileSync(join(GEN, path), "utf8") }))

const count = (text: string, needle: string) => text.split(needle).length - 1

describe("Python runs through python-env.ts only", () => {
	it("leaves no gen file spawning python, uv, ruff, mypy or pip but python-env.ts", () => {
		expect(
			others()
				.filter(({ text }) => PY_COMMAND.test(text))
				.map(({ path }) => path),
		).toEqual([])
	})

	it("recognizes a raw spawn and a command list as running Python", () => {
		expect(
			[
				'spawnSync("python3", ["-c"])',
				'spawn("uv", ["venv"])',
				'run: [["mypy", "--strict"]]',
				'spawnSync("node")',
				'["go", "rust", "python"]',
			].map((t) => PY_COMMAND.test(t)),
		).toEqual([true, true, true, false, false])
	})

	it("hands out one binary path, ruff's, and only to the formatter adapter", () => {
		expect(Object.keys(env).filter((name) => /path/i.test(name))).toEqual(["ruffPath"])
		const loose = others().filter(({ text }) => count(text, "ruffPath(") !== count(text, "ruffFormatter(ruffPath("))
		expect(loose.map(({ path }) => path)).toEqual([])
	})
})

const REPO = join(GEN, "../..")
const WORKFLOW = readFileSync(join(REPO, ".github/workflows/ci.yml"), "utf8")
const TOOLS = join(GEN, "src/emit/python/__fixtures__/tools.txt")
/* the steps that install what the files pin, from the files: the same commands a missing toolchain names */
const UV_PIN = `"$(sed -n 's/^required-version = "==\\(.*\\)"$/\\1/p' uv.toml)"`
const BOOTSTRAP = uvInstall(UV_PIN)
const PY_INSTALL = pythonInstall(['"$(cat .python-version)"', PY_FLOOR])

/** Each job's body under `jobs:`, by name. */
function jobs(workflow: string): Record<string, string> {
	const body = workflow.slice(workflow.indexOf("\njobs:\n"))
	return Object.fromEntries(
		[...body.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\n)*)/gm)].map(([, name, text]) => [name, text]),
	)
}

/** Each step of a job body, as its text. */
const steps = (job: string) => job.split(/^ {6}- /m)

/** The trimmed lines of each step's `run` in a job body. */
const runs = (job: string) =>
	steps(job).map((step) =>
		(/\brun: [|>]-?\n((?: {10}.*\n)*)|\brun: (.*)\n/.exec(step) ?? [])
			.slice(1)
			.join("")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	)

/** Whether a step is setup-uv reading the version from uv.toml, with its GitHub cache off. */
const setsUpUv = (step: string) =>
	/^uses: astral-sh\/setup-uv@v\d+\n/.test(step) &&
	/^ {10}version-file: uv\.toml$/m.test(step) &&
	/^ {10}enable-cache: false$/m.test(step)

describe("the pins", () => {
	it("pin an exact interpreter, an exact uv and an exact floor", () => {
		expect(readFileSync(join(REPO, ".python-version"), "utf8")).toMatch(/^\d+\.\d+\.\d+\n?$/)
		expect(readFileSync(join(REPO, "uv.toml"), "utf8")).toMatch(/^required-version = "==\d+\.\d+\.\d+"$/m)
		expect([pinnedPython(), pinnedUv(), PY_FLOOR].filter((version) => !/^\d+\.\d+\.\d+$/.test(version))).toEqual([])
	})

	it("pin every Python tool gen runs to an exact version", () => {
		const lines = readFileSync(TOOLS, "utf8").split("\n").filter(Boolean)
		expect(lines.map((line) => line.split("==")[0])).toEqual(["mypy", "ruff"])
		expect(lines.filter((line) => !/^[a-z]+==\d+\.\d+\.\d+$/.test(line))).toEqual([])
	})
})

describe("CI installs the uv uv.toml pins and the interpreters .python-version and PY_FLOOR name", () => {
	it("in every job that runs gen's tests, from the files, the same commands a missing one names", () => {
		const testing = Object.entries(jobs(WORKFLOW)).filter(([, job]) =>
			/^ +- run: bun run test(?::harness)?$/m.test(job),
		)
		expect(testing.map(([name]) => name).sort()).toEqual(["harness", "test"])
		const missing = testing.filter(
			([, job]) =>
				!steps(job).some(setsUpUv) ||
				!runs(job).some((lines) => lines.includes(BOOTSTRAP) && lines.includes(PY_INSTALL)),
		)
		expect(missing.map(([name]) => name)).toEqual([])
	})

	it("names no other Python anywhere: no setup action, no version input, no self update, no literal but the floor", () => {
		const setups = WORKFLOW.match(
			/actions\/setup-python\S*|\bpython-version:.*|^ +version:.*|uv self update.*|\bpipx\b.*|(?<!\buv"? )\bpip install.*|\buv==\d.*/gm,
		)
		expect(setups ?? []).toEqual([])
		const literals = [...WORKFLOW.matchAll(/uv python install --no-bin ((?:\S+ ?)+)/g)].flatMap(([, versions]) =>
			(versions as string).split(" ").filter((version) => /^\d/.test(version)),
		)
		expect(literals.filter((version) => version !== PY_FLOOR)).toEqual([])
	})
})

/** The `~/.local/bin` entries that link into the honey cache. */
function linkedIntoCache(): string[] {
	const bin = join(process.env.HOME ?? homedir(), ".local/bin")
	if (!existsSync(bin)) return []
	return readdirSync(bin).filter((name) => {
		const path = join(bin, name)
		return lstatSync(path).isSymbolicLink() && resolve(bin, readlinkSync(path)).includes("/.cache/honey-tmp/")
	})
}

describe("the uv and interpreters a run uses", () => {
	const PIN = withPython()
	const FLOOR = withPython(PY_FLOOR)

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it.skipIf(!PIN)("runs the pinned uv from the honey cache, whatever the user's own uv is", () => {
		expect(env.runUv(["--version"], { cwd: pythonCacheDir("tmp") }).stdout).toMatch(
			new RegExp(`^uv ${pinnedUv().replaceAll(".", "\\.")}[ \n]`),
		)
	})

	for (const [name, version, present] of [
		["pinned", pinnedPython(), PIN],
		["floor", PY_FLOOR, FLOOR],
	] as const)
		it.skipIf(!present)(`runs the ${name} interpreter by name, whatever the cwd`, () => {
			const dir = venv({ python: version, requirements: [] })
			const ran = runPython(dir, ["-c", "import sys; print(sys.version.split()[0])"], { cwd: pythonCacheDir("tmp") })
			expect(ran.stdout).toBe(`${version}\n`)
		})

	it.skipIf(!PIN)("runs ruff and mypy at the versions tools.txt pins", () => {
		const pins = Object.fromEntries(
			readFileSync(TOOLS, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => line.split("==")),
		)
		expect(env.runRuff(["--version"]).stdout).toBe(`ruff ${pins.ruff}\n`)
		expect(env.runMypy(["--version"]).stdout).toMatch(new RegExp(`^mypy ${pins.mypy.replaceAll(".", "\\.")} `))
	})

	it.skipIf(!PIN)(
		"runs a program that never reads its stdin, however large the input, its exit status the answer",
		async () => {
			const dir = venv({ python: pinnedPython(), requirements: [] })
			/* more than a pipe holds: the program exits before the write ends, which must not surface as EPIPE */
			expect(await env.execPython(dir, ["-c", "print(3)"], { input: "x".repeat(4 << 20) })).toEqual({
				status: 0,
				stderr: "",
				stdout: "3\n",
			})
		},
	)
})

describe("what a run never does", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it("never installs a missing interpreter: it skips, or fails naming the install where Python is required", () => {
		vi.stubEnv("HONEY_REQUIRE_TOOLCHAINS", "")
		vi.stubEnv("HONEY_REQUIRE_PYTHON", "")
		expect(withPython("0.0.1")).toBe(false)
		vi.stubEnv("HONEY_REQUIRE_PYTHON", "1")
		expect(() => withPython("0.0.1")).toThrow(pythonInstall(["0.0.1"]))
	})

	it("never runs another uv: without the pinned one it skips, or fails naming its install", () => {
		vi.stubEnv("HONEY_REQUIRE_TOOLCHAINS", "")
		vi.stubEnv("HONEY_REQUIRE_PYTHON", "")
		vi.stubEnv("HOME", pythonCacheDir("tmp", "no-uv"))
		expect(withPython()).toBe(false)
		vi.stubEnv("HONEY_REQUIRE_TOOLCHAINS", "1")
		expect(() => withPython()).toThrow(uvInstall(pinnedUv()))
	})

	it("links nothing into ~/.local/bin: interpreters install with --no-bin, uv's links stay in the cache", () => {
		expect(PY_INSTALL).toContain(" python install --no-bin ")
		expect(BOOTSTRAP).toContain('UV_TOOL_BIN_DIR="$HOME/.cache/honey-tmp/python/uv/bin" ')
		expect(readdirSync(pythonCacheDir("pybin"))).toEqual([])
		expect(linkedIntoCache()).toEqual([])
	})
})
