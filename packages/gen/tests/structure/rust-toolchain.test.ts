/**
 * Toolchain parity (G10) for Rust: gen runs Rust only through `src/emit/rust/__fixtures__/rust-env.ts`,
 * under the channel `rust-toolchain.toml` pins, and CI installs that channel from the file, so a local run
 * and a CI run compile with the same rustc to the patch. Unlike Go's, importing the env file does not
 * license a raw spawn: every cargo, rustc and rustfmt goes through its runners. No compile outside the
 * registry (G17) but the harness files' served document (Fe1): a mutant reaches the registry crates through
 * the mock of the runtime reader, so it compiles no document of its own. A call counts by the module it
 * resolves to (compile-calls.ts): Python's own `compiledFixture` is python-toolchain.test.ts's to judge.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FIXTURES } from "../../src/emit/rust/__fixtures__/documents.ts"
import * as env from "../../src/emit/rust/__fixtures__/rust-env.ts"
import { RUST_VERSION } from "../../src/emit/rust/sdk-cargo.ts"
import { callsOf } from "./compile-calls.ts"

const { RUST_FLOOR, pinnedRust, runRustc, withRust } = env

const GEN = resolve(import.meta.dirname, "../..")
const ROOTS = ["src", "tests", "scripts"]
const SELF = "tests/structure/rust-toolchain.test.ts"
const ENV = "src/emit/rust/__fixtures__/rust-env.ts"
/* the fixture files that define the compiles outside the registry */
const DEFINING = ["src/emit/rust/__fixtures__/compiled.ts", "src/emit/rust/__fixtures__/driven.ts"]
/* the fixture documents a default run may compile (G17), each a FIXTURES entry (Fb5); 17 since bit 20 c's `docs` (the
   docs' Rust example, compiled against the Kitchen e2e app's document) */
const FIXTURE_BUDGET = 17

/* a spawn of a Rust tool, or a list of commands whose entry starts with one (a list of language names is not one) */
const RUST_COMMAND =
	/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*"(?:cargo|rustc|rustfmt|rustup|rustdoc|cargo-clippy|clippy-driver)"|\[\[\s*"(?:cargo|rustc|rustfmt|rustup)",/

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

describe("Rust runs through rust-env.ts only", () => {
	it("leaves no gen file spawning cargo, rustc, rustfmt or rustup but rust-env.ts", () => {
		expect(
			others()
				.filter(({ text }) => RUST_COMMAND.test(text))
				.map(({ path }) => path),
		).toEqual([])
	})

	it("recognizes a raw spawn and a command list as running Rust", () => {
		expect(
			[
				'spawnSync("cargo", ["build"])',
				'run: [["rustc", "-o"]]',
				'spawn("rustfmt")',
				'spawnSync("node")',
				'["go", "rust", "python"]',
			].map((t) => RUST_COMMAND.test(t)),
		).toEqual([true, true, true, false, false])
	})

	it("hands out one binary path, rustfmt's, and only to the formatter adapter", () => {
		expect(Object.keys(env).filter((name) => /path/i.test(name))).toEqual(["rustfmtPath"])
		const loose = others().filter(
			({ text }) => count(text, "rustfmtPath(") !== count(text, "rustfmtFormatter(rustfmtPath("),
		)
		expect(loose.map(({ path }) => path)).toEqual([])
	})
})

const WORKFLOW = readFileSync(join(GEN, "../../.github/workflows/ci.yml"), "utf8")
const TOML = readFileSync(join(GEN, "../../rust-toolchain.toml"), "utf8")
/* the step that installs what the file pins: rustup reads the file for a bare install, and the default follows it */
const PIN_DEFAULT = `rustup default "$(sed -n 's/^channel = "\\(.*\\)"$/\\1/p' rust-toolchain.toml)"`
const FLOOR_INSTALL = `rustup toolchain install ${RUST_FLOOR} --profile minimal --component clippy`

/** Each job's body under `jobs:`, by name. */
function jobs(workflow: string): Record<string, string> {
	const body = workflow.slice(workflow.indexOf("\njobs:\n"))
	return Object.fromEntries(
		[...body.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\n)*)/gm)].map(([, name, text]) => [name, text]),
	)
}

/** The trimmed lines of each step's `run` in a job body. */
const runs = (job: string) =>
	job.split(/^ {6}- /m).map((step) =>
		(/\brun: [|>]-?\n((?: {10}.*\n)*)|\brun: (.*)\n/.exec(step) ?? [])
			.slice(1)
			.join("")
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean),
	)

describe("CI installs the channel rust-toolchain.toml pins", () => {
	it("pins an exact minimal channel with rustfmt and clippy", () => {
		expect(pinnedRust()).toMatch(/^\d+\.\d+\.\d+$/)
		expect(TOML).toMatch(/^profile = "minimal"$/m)
		const components = /^components = \[(.*)\]$/m.exec(TOML)?.[1] ?? ""
		expect([...components.matchAll(/"([^"]+)"/g)].map(([, name]) => name)).toEqual(
			expect.arrayContaining(["rustfmt", "clippy"]),
		)
	})

	/* the jobs that run gen's Rust: the harness and the rust project's shard, the last group, which every file
	 * reaching Rust belongs to (vitest.config.ts) */
	it("installs it from the file, and the floor by name, in every job that runs gen's Rust", () => {
		const testing = Object.entries(jobs(WORKFLOW)).filter(([, job]) =>
			/^ +- run: bun run test:harness$|--project rust\b/m.test(job),
		)
		expect(testing.map(([name]) => name).sort()).toEqual(["gen-rust", "harness"])
		const missing = testing.filter(
			([, job]) =>
				!runs(job).some(
					(lines) =>
						lines.some((line) => /^rustup toolchain install(?: -\S+)*$/.test(line)) &&
						lines.includes(PIN_DEFAULT) &&
						lines.includes(FLOOR_INSTALL),
				),
		)
		expect(missing.map(([name]) => name)).toEqual([])
	})

	it("names no other Rust anywhere: no setup action, no floating channel, no literal but the floor", () => {
		const setups = WORKFLOW.match(
			/dtolnay\/rust-toolchain\S*|actions-rust-lang\/setup-rust-toolchain\S*|\btoolchain:.*|\S*@stable/g,
		)
		expect(setups ?? []).toEqual([])
		const literals = [...WORKFLOW.matchAll(/rustup toolchain install +([^\s-]\S*)/g)].map(([, channel]) => channel)
		expect(literals.filter((channel) => channel !== RUST_FLOOR)).toEqual([])
		const defaults = [...WORKFLOW.matchAll(/rustup default .*/g)].map(([line]) => line)
		expect(defaults.filter((line) => line !== PIN_DEFAULT)).toEqual([])
	})
})

describe("the toolchains a run compiles with", () => {
	const PIN = withRust()
	const FLOOR = withRust(RUST_FLOOR)

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it.skipIf(!PIN)("runs the pinned channel by name, whatever the cwd", () => {
		expect(runRustc(["--version"], { cwd: env.rustCacheDir("tmp") }).stdout).toMatch(
			new RegExp(`^rustc ${pinnedRust()} `),
		)
	})

	it.skipIf(!FLOOR)("runs the floor toolchain by name", () => {
		expect(runRustc(["--version"], { toolchain: RUST_FLOOR }).stdout).toMatch(new RegExp(`^rustc ${RUST_FLOOR} `))
	})

	it("never installs a missing toolchain: it skips, or fails naming the install where Rust is required", () => {
		vi.stubEnv("HONEY_REQUIRE_TOOLCHAINS", "")
		vi.stubEnv("HONEY_REQUIRE_RUST", "")
		expect(withRust("0.0.0")).toBe(false)
		vi.stubEnv("HONEY_REQUIRE_RUST", "1")
		expect(() => withRust("0.0.0")).toThrow("rustup toolchain install 0.0.0 --profile minimal")
	})

	it("floors at the x.y.0 of the rust-version every emitted crate declares", () => {
		expect(RUST_FLOOR).toBe(`${RUST_VERSION}.0`)
	})
})

const RUST_COMPILED = "src/emit/rust/__fixtures__/compiled.ts"
const RUST_DRIVEN = "src/emit/rust/__fixtures__/driven.ts"
const PY_COMPILED = "src/emit/python/__fixtures__/compiled.ts"

/*
 * each compile outside the registry, by the module that exports it, and the files alone that may call it: every
 * language names its any-fixture compile `compiledFixture`, so a call counts by the module its name is bound to
 */
const OUTSIDE_REGISTRY: readonly { readonly callers: RegExp; readonly module: string; readonly name: string }[] = [
	/* any document past the budget: only the files that define the compiles call it */
	{ callers: /^$/, module: RUST_COMPILED, name: "compiledFixture" },
	/* harness mode alone, out of the default run (contract 21 Fe1) */
	{
		callers: /^tests\/integration\/(?:[^/]*harness[^/]*|conformance\/rust)\.test\.ts$/,
		module: RUST_DRIVEN,
		name: "servedRustSdk",
	},
]

/** The files in `files` calling a compile outside the registry they may not call. */
const strayCompiles = (files: readonly { readonly path: string; readonly text: string }[]) =>
	files
		.filter(
			({ path, text }) =>
				!DEFINING.includes(path) &&
				OUTSIDE_REGISTRY.some(
					({ callers, module, name }) => callsOf(path, text, name).includes(module) && !callers.test(path),
				),
		)
		.map(({ path }) => path)

/** A file at `path` whose text imports `name` from gen-relative `module` and calls it. */
const calling = (path: string, name: string, module: string) => ({
	path,
	text: `import { ${name} } from "./${relative(dirname(path), module)}"\nconst sdk = ${name}(document)`,
})

describe("the fixture documents a default run compiles", () => {
	it(`number at most ${FIXTURE_BUDGET}`, () => {
		expect(Object.keys(FIXTURES).length).toBeLessThanOrEqual(FIXTURE_BUDGET)
	})

	it("come only from the registry, except the harness files' served document", () => {
		expect(strayCompiles(others())).toEqual([])
	})

	it("flags a served-document compile from any file but the harness files, and an any-fixture compile from any file but its own", () => {
		expect(
			strayCompiles([
				calling("src/emit/rust/x.test.ts", "servedRustSdk", RUST_DRIVEN),
				calling("tests/integration/conformance/go.test.ts", "servedRustSdk", RUST_DRIVEN),
				calling("tests/integration/rust-harness.test.ts", "servedRustSdk", RUST_DRIVEN),
				calling("tests/integration/conformance/rust.test.ts", "servedRustSdk", RUST_DRIVEN),
				calling("src/emit/rust/__fixtures__/driven.ts", "servedRustSdk", RUST_DRIVEN),
				calling("tests/structure/mutation-harness.rust.ts", "servedRustSdk", RUST_DRIVEN),
				calling("tests/security/x.test.ts", "compiledFixture", RUST_COMPILED),
				calling("src/emit/rust/__fixtures__/driven.ts", "compiledFixture", RUST_COMPILED),
				calling("src/emit/rust/x.test.ts", "servedRustSdkish", RUST_DRIVEN),
				/* another language's own compile is its leg's to judge; Rust's from another language's fixture is a stray */
				calling("src/emit/python/__fixtures__/driven.ts", "compiledFixture", PY_COMPILED),
				calling("src/emit/python/__fixtures__/compiled.ts", "compiledFixture", RUST_COMPILED),
				/* an alias, a namespace and a re-export each reach it; a bare mention with no import binds nothing */
				{
					path: "tests/security/alias.test.ts",
					text: `import { compiledFixture as build } from "../../${RUST_COMPILED}"\nbuild(document)`,
				},
				{
					path: "tests/security/space.test.ts",
					text: `import * as c from "../../${RUST_COMPILED}"\nc.compiledFixture(document)`,
				},
				{ path: "tests/security/again.ts", text: `export { compiledFixture } from "../../${RUST_COMPILED}"` },
				{ path: "tests/security/note.test.ts", text: "/* compiledFixture(document) */ compiledFixture(document)" },
			]),
		).toEqual([
			"src/emit/rust/x.test.ts",
			"tests/integration/conformance/go.test.ts",
			"tests/structure/mutation-harness.rust.ts",
			"tests/security/x.test.ts",
			"src/emit/python/__fixtures__/compiled.ts",
			"tests/security/alias.test.ts",
			"tests/security/space.test.ts",
			"tests/security/again.ts",
		])
	})
})
