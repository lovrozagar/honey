/**
 * One language toolchain at a time beside Node (00-rules:118): the default run is one `vitest run` whose
 * projects are `unit` (Node only) and one per language that compiles or executes emitted code, each language
 * its own `sequence.groupOrder` group (`unit` shares the first). A test file runs a language's toolchain
 * exactly when its imports reach that language's env fixture, the one way gen runs it (go-toolchain.test.ts
 * holds Go to that), so the split is checked from the import graph, never kept by hand: a file that reaches a
 * language outside its project would run that toolchain beside another language's group, and a file in a
 * language's project that reaches no toolchain would only stretch that group.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, matchesGlob, relative, resolve } from "node:path"
import { ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import type { TestSpecification } from "vitest/node"
import config, { LongestFirst, TOOLCHAIN_PROJECTS } from "../../vitest.config.ts"

const GEN = resolve(import.meta.dirname, "../..")
/* the Go compile every executed Go test goes through: its import closure is the emitter and the driver */
const COMPILED = "src/emit/go/__fixtures__/compiled.ts"

/** Each toolchain project's env fixture, the one module its files run that toolchain through. */
const ENV: Readonly<Record<keyof typeof TOOLCHAIN_PROJECTS, string>> = {
	go: "src/emit/go/__fixtures__/go-env.ts",
}

type Project = {
	readonly test: {
		readonly exclude?: readonly string[]
		readonly include?: readonly string[]
		readonly name: string
		readonly sequence: { readonly groupOrder: number }
	}
}
type Resolved = { test: { exclude: string[]; projects: Project[]; sequence: { sequencer: unknown } } }

const resolved = (config as unknown as (env: { command: "serve"; mode: string }) => Resolved)({
	command: "serve",
	mode: "test",
}).test

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

/** The projects whose include (and not the root's or its own exclude) takes `file`. */
function projectsOf(file: string): string[] {
	return resolved.projects
		.filter(({ test }) => matches(file, test.include) && !matches(file, [...resolved.exclude, ...(test.exclude ?? [])]))
		.map(({ test }) => test.name)
}

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

/** The `hashFiles` globs of the CI cache whose key starts `<os>-<name>-`, repo-relative. */
function cacheKeyGlobs(workflow: string, name: string): string[] {
	const key = new RegExp(`-${name}-\\$\\{\\{ hashFiles\\(([^)]*)\\) \\}\\}`).exec(workflow.replace(/\s+/g, " "))
	return [...(key?.[1] ?? "").matchAll(/'([^']+)'/g)].map(([, glob]) => glob as string)
}

/** The files directly in gen-relative `dir`. */
const dirFiles = (dir: string) => readdirSync(join(GEN, dir)).map((name) => join(dir, name))

/** Every file a Go compile in the default run is built from: the emitter and driver side, the runtime, the documents. */
function goInputs(runFiles: readonly string[], imports: Imports): string[] {
	const goTests = runFiles.filter((file) => projectsOf(file).includes("go"))
	return [
		...closure([COMPILED], imports),
		...closure(goTests, imports, (file) => goTests.includes(file) || file.startsWith("tests/")),
		...dirFiles("src/runtime/go"),
		...dirFiles("src/emit/go/__fixtures__/driver"),
	].map((file) => `packages/gen/${file}`)
}

describe("the default run's projects", () => {
	const imports = diskImports()
	const runFiles = ["src", "tests", "scripts"].flatMap(testFiles).filter((file) => !matches(file, resolved.exclude))

	it("puts every default-run test file in exactly one project", () => {
		expect(runFiles.length).toBeGreaterThan(0)
		expect(runFiles.filter((file) => projectsOf(file).length !== 1)).toEqual([])
	})

	it("runs each toolchain project in a group of its own, unit beside the first", () => {
		const orders = resolved.projects.map(({ test }) => [test.name, test.sequence.groupOrder])
		expect(orders).toEqual([["unit", 0], ...Object.keys(TOOLCHAIN_PROJECTS).map((name, i) => [name, i])])
	})

	it.each(Object.entries(ENV))("holds every file that reaches the %s toolchain in its project", (name, env) => {
		const reaching = runFiles.filter((file) => reaches(file, env, imports))
		expect(reaching.length).toBeGreaterThan(0)
		expect(reaching.filter((file) => !projectsOf(file).includes(name))).toEqual([])
	})

	it.each(Object.entries(ENV))(
		"takes a file outside src/emit/%s/ into its project only when it reaches it",
		(name, env) => {
			const listed = runFiles.filter((file) => projectsOf(file).includes(name))
			expect(listed.filter((file) => !file.startsWith(`src/emit/${name}/`) && !reaches(file, env, imports))).toEqual([])
		},
	)

	it("keys CI's Go compile cache on every input of a Go compile", () => {
		const globs = cacheKeyGlobs(readFileSync(join(GEN, "../../.github/workflows/ci.yml"), "utf8"), "gobuild")
		const inputs = [".go-version", ...goInputs(runFiles, imports)]
		expect(globs.length).toBeGreaterThan(0)
		expect(inputs.filter((file) => !globs.some((glob) => matchesGlob(file, glob)))).toEqual([])
	})

	it("names no toolchain glob that matches no file", () => {
		const globs = Object.values(TOOLCHAIN_PROJECTS).flat()
		expect(globs.filter((glob) => !runFiles.some((file) => matchesGlob(file, glob)))).toEqual([])
	})
})

/** A test file `file` of project `name` in group `groupOrder`, as much of one as the sequencer reads. */
const spec = (name: string, groupOrder: number, file: string) =>
	({
		moduleId: `/gen/${file}`,
		project: { config: { sequence: { groupOrder } }, name },
	}) as unknown as TestSpecification

describe("the sequencer", () => {
	it("is the default run's", () => {
		expect(resolved.sequence.sequencer).toBe(LongestFirst)
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
