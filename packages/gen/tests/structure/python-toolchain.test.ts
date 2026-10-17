/**
 * Toolchain parity (G10, G11) for Python: gen runs Python only through `src/emit/python/__fixtures__/python-env.ts`,
 * under the uv `uv.toml` pins and the interpreters `.python-version` and `PY_FLOOR` name, all inside
 * `$HOME/.cache/honey-tmp/python` (the uv a bootstrap installs there, never the user's own), and CI installs
 * exactly those, so a local run and a CI run use the same uv and interpreters to the patch. As with Rust,
 * importing the env file does not license a raw spawn: every uv, python, ruff and mypy goes through its
 * runners. Nothing lands in `~/.local/bin`. No gate outside the registry (G17, at most 16 documents) but the
 * harness files' served document; a call counts by the module it resolves to (compile-calls.ts), so Rust's own
 * `compiledFixture` is rust-toolchain.test.ts's to judge. Only the Python conformance runner names the gate
 * option that resolves the constraints online (`"newest"`, Fe4), so the default run never does. The floor
 * interpreter and the floor constraints sit at the floors every emitted package declares.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FIXTURES } from "../../src/emit/python/__fixtures__/documents.ts"
import * as env from "../../src/emit/python/__fixtures__/python-env.ts"
import { HTTPX2_FLOOR, PYTHON_REQUIRES } from "../../src/emit/python/sdk-pyproject.ts"
import { callsOf } from "./compile-calls.ts"

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
const FIXTURE_DIR = join(GEN, "src/emit/python/__fixtures__")
const TOOLS = join(FIXTURE_DIR, "tools.txt")

/** A constraints file's pins by package, in file order; throws on a line that is no exact `name==x.y.z`. */
function constraints(file: string): Record<string, string> {
	const lines = readFileSync(join(FIXTURE_DIR, file), "utf8").split("\n").filter(Boolean)
	const loose = lines.filter((line) => !/^[a-z0-9-]+==\d+(?:\.\d+)*$/.test(line))
	if (loose.length > 0) throw new Error(`${file} pins inexactly: ${loose.join(", ")}`)
	return Object.fromEntries(lines.map((line) => line.split("==")))
}

/** Whether dotted version `a` is at least `b`. */
function atLeast(a: string, b: string): boolean {
	const [x, y] = [a, b].map((v) => v.split(".").map(Number)) as [number[], number[]]
	const at = x.findIndex((part, i) => part !== (y[i] ?? 0))
	return at === -1 ? x.length >= y.length : (x[at] as number) > (y[at] ?? 0)
}
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

/**
 * Whether a step is setup-uv at an exact release, reading the version from uv.toml, with its GitHub cache off:
 * setup-uv publishes no floating major tag past v7, so a bare `@v10` never resolves.
 */
const setsUpUv = (step: string) =>
	/^uses: astral-sh\/setup-uv@v\d+\.\d+\.\d+\n/.test(step) &&
	/^ {10}version-file: uv\.toml$/m.test(step) &&
	/^ {10}enable-cache: false$/m.test(step)

describe("the pins", () => {
	it("pin an exact interpreter, an exact uv and an exact floor", () => {
		expect(readFileSync(join(REPO, ".python-version"), "utf8")).toMatch(/^\d+\.\d+\.\d+\n?$/)
		expect(readFileSync(join(REPO, "uv.toml"), "utf8")).toMatch(/^required-version = "==\d+\.\d+\.\d+"$/m)
		expect([pinnedPython(), pinnedUv(), PY_FLOOR].filter((version) => !/^\d+\.\d+\.\d+$/.test(version))).toEqual([])
	})

	it("floor the interpreter at the minor every emitted package requires", () => {
		expect(PY_FLOOR.split(".").slice(0, 2).join(".")).toBe(PYTHON_REQUIRES.replace(/^>=/, ""))
	})

	it("constrain the pin and the floor installs to one package set, exact, the floor at the declared httpx2 floor", () => {
		const pin = constraints("constraints.txt")
		const floor = constraints("constraints-floor.txt")
		expect(floor.httpx2).toBe(HTTPX2_FLOOR)
		expect(Object.keys(pin)).toEqual(Object.keys(floor))
		expect(Object.keys(pin).filter((name) => !atLeast(pin[name] as string, floor[name] as string))).toEqual([])
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

const PY_COMPILED = "src/emit/python/__fixtures__/compiled.ts"
const PY_DRIVEN = "src/emit/python/__fixtures__/driven.ts"
const RUST_COMPILED = "src/emit/rust/__fixtures__/compiled.ts"
/* the fixture files that define the gates outside the registry */
const DEFINING = [PY_COMPILED, PY_DRIVEN]
/* the fixture documents a default run may gate (G17), each a FIXTURES entry (Fb14) */
const FIXTURE_BUDGET = 16

/* each gate outside the registry, by the module that exports it, and the files alone that may call it */
const OUTSIDE_REGISTRY: readonly { readonly callers: RegExp; readonly module: string; readonly name: string }[] = [
	/* any document past the budget: only the files that define the gates call it */
	{ callers: /^$/, module: PY_COMPILED, name: "compiledFixture" },
	/* harness mode alone, out of the default run (phase e) */
	{
		callers: /^tests\/integration\/(?:[^/]*harness[^/]*|conformance\/python)\.test\.ts$/,
		module: PY_DRIVEN,
		name: "servedPythonSdk",
	},
]

/* the gate option that resolves the constraints online (Fe4), by its text, and the one file that may name it */
const ONLINE = { callers: /^tests\/integration\/conformance\/python\.test\.ts$/, text: 'python: "newest"' }

/** Whether the file at `path` calls a gate outside the registry it may not call. */
const strayGate = (path: string, text: string) =>
	!DEFINING.includes(path) &&
	OUTSIDE_REGISTRY.some(
		({ callers, module, name }) => callsOf(path, text, name).includes(module) && !callers.test(path),
	)

/** The files in `files` calling a gate outside the registry, or naming the online resolve, where they may not. */
const strayCompiles = (files: readonly { readonly path: string; readonly text: string }[]) =>
	files
		.filter(({ path, text }) => strayGate(path, text) || (text.includes(ONLINE.text) && !ONLINE.callers.test(path)))
		.map(({ path }) => path)

/** A file at `path` whose text imports `name` from gen-relative `module` and calls it. */
const calling = (path: string, name: string, module: string) => ({
	path,
	text: `import { ${name} } from "./${relative(dirname(path), module)}"\nconst sdk = ${name}(document)`,
})

/** A file at `path` that names the online resolve. */
const newest = (path: string) => ({ path, text: 'const sdk = servedPythonSdk(document, { python: "newest" })' })

describe("the fixture documents a default run gates", () => {
	it(`number at most ${FIXTURE_BUDGET}`, () => {
		expect(Object.keys(FIXTURES).length).toBeLessThanOrEqual(FIXTURE_BUDGET)
	})

	it("come only from the registry, except the harness files' served document, and never resolve online", () => {
		expect(strayCompiles(others())).toEqual([])
	})

	it("flag Python's served document anywhere but the harness files, and Python's any-fixture gate anywhere but its own files", () => {
		expect(
			strayCompiles([
				calling("src/emit/python/x.test.ts", "servedPythonSdk", PY_DRIVEN),
				calling("tests/integration/conformance/rust.test.ts", "servedPythonSdk", PY_DRIVEN),
				calling("tests/integration/python-harness.test.ts", "servedPythonSdk", PY_DRIVEN),
				calling("tests/integration/conformance/python.test.ts", "servedPythonSdk", PY_DRIVEN),
				calling("tests/security/x.test.ts", "compiledFixture", PY_COMPILED),
				calling("src/emit/python/__fixtures__/consumer.ts", "compiledFixture", PY_COMPILED),
				/* Rust's own gate is its leg's to judge; Python's from Rust's fixture is a stray */
				calling("src/emit/rust/__fixtures__/driven.ts", "compiledFixture", RUST_COMPILED),
				calling("src/emit/rust/__fixtures__/driven.ts", "compiledFixture", PY_COMPILED),
				{ path: "tests/security/note.test.ts", text: "/* compiledFixture(document) */ compiledFixture(document)" },
			]),
		).toEqual([
			"src/emit/python/x.test.ts",
			"tests/integration/conformance/rust.test.ts",
			"tests/security/x.test.ts",
			"src/emit/python/__fixtures__/consumer.ts",
			"src/emit/rust/__fixtures__/driven.ts",
		])
	})

	it('flag the online "newest" resolve anywhere but the Python conformance runner', () => {
		expect(
			strayCompiles([
				newest("tests/integration/conformance/python.test.ts"),
				newest("tests/integration/python-harness.test.ts"),
				newest("src/emit/python/x.test.ts"),
			]),
		).toEqual(["tests/integration/python-harness.test.ts", "src/emit/python/x.test.ts"])
	})
})
