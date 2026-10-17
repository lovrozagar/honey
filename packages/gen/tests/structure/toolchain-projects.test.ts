/**
 * One language toolchain at a time beside Node (00-rules:118): the default run is one `vitest run` whose
 * projects are `unit` (Node only) and one per language that compiles or executes emitted code, each language
 * its own `sequence.groupOrder` group (`unit` shares the first). A test file runs a language's toolchain
 * exactly when its imports reach that language's env fixture, the one way gen runs it (go-toolchain.test.ts
 * holds Go to that), so the split is checked from the import graph, never kept by hand: a file that reaches a
 * language outside its project would run that toolchain beside another language's group, and a file in a
 * language's project that reaches no toolchain would only stretch that group. Harness mode runs in the same
 * groups, `ts` (Node) in place of `unit`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, matchesGlob, relative, resolve } from "node:path"
import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import type { TestSpecification } from "vitest/node"
import config, { HARNESS, LongestFirst, TOOLCHAIN_PROJECTS } from "../../vitest.config.ts"

const GEN = resolve(import.meta.dirname, "../..")

/** Each toolchain project's env fixture, the one module its files run that toolchain through. */
const ENV: Readonly<Record<keyof typeof TOOLCHAIN_PROJECTS, string>> = {
	go: "src/emit/go/__fixtures__/go-env.ts",
	rust: "src/emit/rust/__fixtures__/rust-env.ts",
	python: "src/emit/python/__fixtures__/python-env.ts",
}

/** Each toolchain's CI compile cache: its key's name, and the pin files every compile depends on. */
const CACHE: Readonly<Record<keyof typeof TOOLCHAIN_PROJECTS, readonly [key: string, ...pins: string[]]>> = {
	go: ["gobuild", ".go-version"],
	rust: ["rust", "rust-toolchain.toml"],
	python: ["python", ".python-version", "uv.toml"],
}

type Toolchain = keyof typeof ENV

type Project = {
	readonly extends?: boolean
	readonly test: {
		readonly exclude?: readonly string[]
		readonly hookTimeout?: number
		readonly include?: readonly string[]
		readonly name: string
		readonly sequence: { readonly groupOrder: number }
		readonly testTimeout?: number
	}
}
type Resolved = { test: { exclude?: string[]; projects?: Project[]; sequence?: { sequencer: unknown } } }

/** The config's `test` in a vitest mode: the default run's (`test`) or the opt-in harness's (`harness`). */
const configIn = (mode: string) =>
	(config as unknown as (env: { command: "serve"; mode: string }) => Resolved)({ command: "serve", mode }).test
const resolved = configIn("test")
const harness = configIn("harness")

/** A file's gen imports, gen-relative; undefined for a module that is not there. */
type Imports = (file: string) => readonly string[] | undefined

/** Every `.test.ts` under `dir`, gen-relative. */
function testFiles(dir: string): string[] {
	return readdirSync(join(GEN, dir)).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(join(GEN, path)).isDirectory()) return testFiles(path)
		return name.endsWith(".test.ts") ? [path] : []
	})
}

const matches = (file: string, globs: readonly string[] = []) => globs.some((glob) => matchesGlob(file, glob))

/** The projects of `run` (the default run's unless named) whose include, and no root or own exclude, takes `file`. */
function projectsOf(file: string, run: Resolved["test"] = resolved): string[] {
	return (run.projects ?? [])
		.filter(
			({ test }) => matches(file, test.include) && !matches(file, [...(run.exclude ?? []), ...(test.exclude ?? [])]),
		)
		.map(({ test }) => test.name)
}

/** A run's projects as `[name, groupOrder]`, in the order the config lists them. */
const groupsOf = (run: Resolved["test"]) =>
	(run.projects ?? []).map(({ test }) => [test.name, test.sequence.groupOrder])

/** The relative modules `text`, the source of gen-relative `file`, imports (static, re-export or dynamic). */
function importsIn(file: string, text: string): string[] {
	return ts
		.preProcessFile(text, true, true)
		.importedFiles.map(({ fileName }) => fileName)
		.filter((spec) => spec.startsWith("."))
		.map((spec) => relative(GEN, resolve(GEN, dirname(file), spec)))
}

/** `entries` and every module they import through every hop, past only the files `keep` takes; a module that is not there ends that path. */
function closure(
	entries: readonly string[],
	imports: Imports,
	keep: (file: string) => boolean = () => true,
): Set<string> {
	const seen = new Set<string>()
	const queue = [...entries]
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		if (seen.has(file) || !keep(file)) continue
		const next = imports(file)
		if (next === undefined) continue
		seen.add(file)
		queue.push(...next)
	}
	return seen
}

/** Whether `target` is in `entry`'s import closure. */
const reaches = (entry: string, target: string, imports: Imports) => closure([entry], imports).has(target)

/** `Imports` over gen's files on disk, each parsed once. */
function diskImports(): Imports {
	const parsed = new Map<string, readonly string[] | undefined>()
	return (file) => {
		if (!parsed.has(file)) {
			const path = join(GEN, file)
			parsed.set(file, existsSync(path) ? importsIn(file, readFileSync(path, "utf8")) : undefined)
		}
		return parsed.get(file)
	}
}

const WORKFLOW = readFileSync(join(GEN, "../../.github/workflows/ci.yml"), "utf8")

/** The `hashFiles` globs of each CI cache step whose key starts `<os>-<name>-`, repo-relative, in workflow order. */
function cacheKeyGlobs(workflow: string, name: string): string[][] {
	const keys = workflow
		.replace(/\s+/g, " ")
		.matchAll(new RegExp(`-${name}-\\$\\{\\{ hashFiles\\(([^)]*)\\) \\}\\}`, "g"))
	return [...keys].map(([, globs]) => [...(globs ?? "").matchAll(/'([^']+)'/g)].map(([, glob]) => glob as string))
}

/** Each job's body under `jobs:`, by name, its comment lines left out. */
function jobs(workflow: string): Record<string, string> {
	const body = workflow.slice(workflow.indexOf("\njobs:\n")).replace(/^ *#.*\n/gm, "")
	return Object.fromEntries(
		[...body.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\n)*)/gm)].map(([, name, text]) => [name, text]),
	)
}

/** Each job's `--project` names, by job, the jobs that name none left out. */
const shardsOf = (workflow: string) =>
	Object.fromEntries(
		Object.entries(jobs(workflow))
			.map(([name, job]) => [name, [...job.matchAll(/--project (\S+)/g)].map(([, project]) => project as string)])
			.filter(([, projects]) => projects.length > 0),
	) as Record<string, string[]>

/** The files directly in gen-relative `dir`; none where it is not there yet. */
const dirFiles = (dir: string) =>
	existsSync(join(GEN, dir)) ? readdirSync(join(GEN, dir)).map((name) => join(dir, name)) : []

/**
 * Every file a `name` compile in the default run is built from: the compile fixture's import closure (the
 * emitter and the driver), the tests that reach the toolchain with the test files they import (the
 * documents and programs), the runtime, the driver sources.
 */
function compileInputs(name: Toolchain, runFiles: readonly string[], imports: Imports): string[] {
	const tests = runFiles.filter((file) => reaches(file, ENV[name], imports))
	return [
		...closure([`src/emit/${name}/__fixtures__/compiled.ts`], imports),
		...closure(tests, imports, (file) => tests.includes(file) || file.startsWith("tests/")),
		...dirFiles(`src/runtime/${name}`),
		...dirFiles(`src/emit/${name}/__fixtures__/driver`),
	].map((file) => `packages/gen/${file}`)
}

/**
 * The toolchain project a file belongs to: of the toolchains its imports reach, the one whose group runs
 * last, since it runs beside that group with every earlier one done; undefined for a Node-only file.
 */
const ownerOf = (file: string, imports: Imports) =>
	(Object.keys(ENV) as Toolchain[]).findLast((name) => reaches(file, ENV[name], imports))

describe("the default run's projects", () => {
	const imports = diskImports()
	const runFiles = ["src", "tests", "scripts"].flatMap(testFiles).filter((file) => !matches(file, resolved.exclude))

	it("puts every default-run test file in exactly one project", () => {
		expect(runFiles.length).toBeGreaterThan(0)
		expect(runFiles.filter((file) => projectsOf(file).length !== 1)).toEqual([])
	})

	it("runs each toolchain project in a group of its own, unit beside the first", () => {
		expect(groupsOf(resolved)).toEqual([["unit", 0], ...Object.keys(TOOLCHAIN_PROJECTS).map((name, i) => [name, i])])
	})

	it.each(Object.keys(ENV))("holds every file whose last toolchain reached is %s in its project", (name) => {
		const owned = runFiles.filter((file) => ownerOf(file, imports) === name)
		expect(owned.length).toBeGreaterThan(0)
		expect(owned.filter((file) => !projectsOf(file).includes(name))).toEqual([])
	})

	it.each(Object.entries(ENV))(
		"takes a file outside src/emit/%s/ into its project only when it reaches it",
		(name, env) => {
			const listed = runFiles.filter((file) => projectsOf(file).includes(name))
			expect(listed.filter((file) => !file.startsWith(`src/emit/${name}/`) && !reaches(file, env, imports))).toEqual([])
		},
	)

	/* every job that saves or restores the cache names one key, so the shards share what the job owning it saves */
	it.each(Object.keys(CACHE) as Toolchain[])("keys CI's %s compile cache on every input of its compiles", (name) => {
		const [key, ...pins] = CACHE[name]
		const [globs = [], ...others] = cacheKeyGlobs(WORKFLOW, key)
		const inputs = [...pins, ...compileInputs(name, runFiles, imports)]
		expect(globs.length).toBeGreaterThan(0)
		expect(inputs.filter((file) => !globs.some((glob) => matchesGlob(file, glob)))).toEqual([])
		expect(others).toEqual(others.map(() => globs))
	})

	it("names no toolchain glob that matches no file", () => {
		const globs = Object.values(TOOLCHAIN_PROJECTS).flat()
		expect(globs.filter((glob) => !runFiles.some((file) => matchesGlob(file, glob)))).toEqual([])
	})

	/* a fixture reaching another language's emitter would run it in this one's compiles and miss this one's cache key */
	it.each(Object.keys(ENV) as Toolchain[])(
		"keeps %s's compile fixtures off every other language's emit tree",
		(name) => {
			const fixtures = dirFiles(`src/emit/${name}/__fixtures__`).filter((file) => file.endsWith(".ts"))
			const others = (Object.keys(ENV) as Toolchain[]).filter((other) => other !== name)
			const reached = [...closure(fixtures, imports)]
			expect(reached.filter((file) => others.some((other) => file.startsWith(`src/emit/${other}/`)))).toEqual([])
		},
	)
})

describe("CI's gen shards", () => {
	/* CI runs the default run as shards, a job's `--project` set each, and merges their coverage in gen-coverage
	 * (contract 28 §8.3): a project in two shards runs twice, one in none never runs, a shard gen-coverage does not
	 * wait for drops its coverage, and a whole gen run (the root `test` script, `test:gen`) runs every project again */
	it("splits the projects across CI's shards, each in exactly one, every shard merged in gen-coverage", () => {
		const shards = shardsOf(WORKFLOW)
		const needs = /^ {4}needs: \[(.*)\]$/m.exec(jobs(WORKFLOW)["gen-coverage"] ?? "")?.[1]?.split(", ") ?? []
		const whole = Object.entries(jobs(WORKFLOW)).filter(([, job]) => /^ +- run: bun run test(?::gen)?$/m.test(job))
		expect(Object.values(shards).flat().sort()).toEqual((resolved.projects ?? []).map(({ test }) => test.name).sort())
		expect(needs.sort()).toEqual(Object.keys(shards).sort())
		expect(whole.map(([name]) => name)).toEqual([])
	})
})

/** A test file `file` of project `name` in group `groupOrder`, as much of one as the sequencer reads. */
const spec = (name: string, groupOrder: number, file: string) =>
	({
		moduleId: `/gen/${file}`,
		project: { config: { sequence: { groupOrder } }, name },
	}) as unknown as TestSpecification

/*
 * The harness runs the same toolchains (00-rules:118): each target's conformance runner and harness files are a
 * project of their own, in the default run's groups, so Python's runner never runs beside Go's or Rust's.
 */
describe("harness mode's projects", () => {
	const imports = diskImports()
	const harnessFiles = testFiles("tests").filter((file) => matches(file, HARNESS))

	it("puts every harness file in exactly one harness project", () => {
		expect(harnessFiles.length).toBeGreaterThan(0)
		expect(harnessFiles.filter((file) => projectsOf(file, harness).length !== 1)).toEqual([])
	})

	it("holds each harness file in the project of the last toolchain it reaches, ts (Node) when it reaches none", () => {
		const misplaced = harnessFiles.filter((file) => projectsOf(file, harness)[0] !== (ownerOf(file, imports) ?? "ts"))
		expect(misplaced).toEqual([])
	})

	it("runs the projects in the default run's groups, ts beside go", () => {
		expect(groupsOf(harness)).toEqual([["ts", 0], ...Object.keys(TOOLCHAIN_PROJECTS).map((name, i) => [name, i])])
	})

	/* vitest loads an `extends: true` project's root config again in mode `test`, the default run's, whose
	 * exclude drops every harness file: such a project would run nothing */
	it("extends no root config, each project holding the 60 s test and hook timeouts", () => {
		const projects = harness.projects ?? []
		expect(projects.length).toBeGreaterThan(0)
		expect(projects.map(({ extends: base, test }) => [base, test.testTimeout, test.hookTimeout])).toEqual(
			projects.map(() => [undefined, 60_000, 60_000]),
		)
	})
})

describe("the sequencer", () => {
	it("is the default run's and the harness's", () => {
		expect([resolved.sequence?.sequencer, harness.sequence?.sequencer]).toEqual([LongestFirst, LongestFirst])
	})

	it("orders by group, then the longest last run first whichever project holds it, an unknown file before those", async () => {
		const took: Record<string, number> = {
			"go:a.ts": 30,
			"go:c.ts": 2,
			"rust:e.ts": 40,
			"unit:b.ts": 25,
			"unit:d.ts": 9,
		}
		const results = (key: string) => (took[key] === undefined ? undefined : { duration: took[key], failed: false })
		const ctx = { cache: { getFileTestResults: results }, config: { root: "/gen" } }
		const files = [spec("rust", 1, "e.ts"), spec("go", 0, "c.ts"), spec("unit", 0, "d.ts"), spec("go", 0, "a.ts")]
		const sorted = await new LongestFirst(ctx as never).sort([
			...files,
			spec("unit", 0, "new.ts"),
			spec("unit", 0, "b.ts"),
		])
		expect(sorted.map((s) => `${s.project.name}:${s.moduleId.slice(5)}`)).toEqual([
			"unit:new.ts",
			"go:a.ts",
			"unit:b.ts",
			"unit:d.ts",
			"go:c.ts",
			"rust:e.ts",
		])
	})
})

describe("the import closure", () => {
	const files: Record<string, string> = {
		"a.test.ts": 'import { b } from "./b.ts"\nexport { c } from "./lib/c.ts"',
		"b.ts": 'import "node:fs"',
		"d.ts": 'import "./a.test.ts"',
		"e.ts": 'import { a } from "./a.test.ts"',
		"lib/c.ts": 'const d = await import("../d.ts")',
	}
	const imports: Imports = (file) => (files[file] === undefined ? undefined : importsIn(file, files[file]))

	it("follows static, re-export and dynamic imports through every hop, and no package import", () => {
		expect(["d.ts", "b.ts", "lib/c.ts", "node:fs"].map((target) => reaches("a.test.ts", target, imports))).toEqual([
			true,
			true,
			true,
			false,
		])
	})

	it("ends a path at a module that is not there and never loops on a cycle", () => {
		expect([
			reaches("e.ts", "lib/c.ts", imports),
			reaches("a.test.ts", "x.ts", imports),
			reaches("x.ts", "d.ts", imports),
		]).toEqual([true, false, false])
	})
})
