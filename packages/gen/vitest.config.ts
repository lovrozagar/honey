import { relative } from "node:path"
import { configDefaults, defineConfig } from "vitest/config"
import { BaseSequencer, type TestSpecification } from "vitest/node"

/** the opt-in harness (00-rules:119): spawns core's reference app; never part of `bun run test` */
export const HARNESS = [
	"tests/integration/*harness*.test.ts",
	"tests/integration/conformance/{ts,go,rust,python,csharp,java,cli,mcp}.test.ts",
]

/**
 * The default run's test files that run Go: each reaches `go-env.ts`, the one way gen runs Go, through its
 * imports. They run as the `go` project, the generated CLI's (bit 17, a Go module) with the SDK's.
 * `tests/structure/toolchain-projects.test.ts` holds a file that reaches Go to this list, and a file listed here
 * outside `src/emit/go/` to reaching Go.
 */
export const GO = [
	"src/emit/go/**/*.test.ts",
	"src/emit/cli/**/*.test.ts",
	"src/cli.test.ts",
	"scripts/sdk-budget.cli.test.ts",
	"src/emit/shared/escape.test.ts",
	"src/emit/shared/gofmt.test.ts",
	"tests/security/emit-adversarial.test.ts",
]

/**
 * The default run's test files that run Python: each reaches `python-env.ts`, the one way gen runs Python, through
 * its imports. They run as the `python` project, held to that as `GO` is. A file that reaches Go too runs here, in
 * the later group, where no other language runs beside it.
 */
export const PYTHON = [
	"src/emit/python/**/*.test.ts",
	"src/emit/mcp/python-client.test.ts",
	"src/emit/mcp/python-oauth.test.ts",
	"src/emit/shared/ruff.test.ts",
	"tests/security/emit-adversarial.python.test.ts",
	"tests/structure/python-toolchain.test.ts",
]

/**
 * The default run's test files that run .NET: each reaches `csharp-env.ts`, the one way gen runs .NET, through its
 * imports. They run as the `csharp` project, held to that as `GO` is.
 */
export const CSHARP = [
	"src/emit/csharp/**/*.test.ts",
	"tests/security/emit-adversarial.csharp.test.ts",
	"tests/structure/csharp-toolchain.test.ts",
]

/**
 * The default run's test files that run Java: each reaches `java-env.ts`, the one way gen runs Java, through its
 * imports. They run as the `java` project, held to that as `GO` is.
 */
export const JAVA = ["src/emit/java/**/*.test.ts", "tests/structure/java-toolchain.test.ts"]

/**
 * The default run's test files that run Rust: each reaches `rust-env.ts`, the one way gen runs Rust, through its
 * imports. They run as the `rust` project, held to that as `GO` is. The toolchain files and the mutation harness
 * reach Go, Python and .NET too, so they run here, in the last group, the one whose cache is the heaviest to rebuild.
 */
export const RUST = [
	"src/emit/rust/**/*.test.ts",
	"src/emit/shared/rustfmt.test.ts",
	"src/emit/shared/*.toolchains.test.ts",
	"tests/security/emit-adversarial.rust.test.ts",
	"tests/structure/mutation-harness.test.ts",
	"tests/structure/rust-toolchain.test.ts",
]

/**
 * Each language toolchain's project, in the order their `sequence.groupOrder` groups run, one language group at
 * a time: two toolchains at once at most, Node and one language (00-rules:118, G17). `unit` (Node only) shares
 * the first group, so its files fill the workers beside the first language instead of adding a serial group. A
 * file whose imports reach several languages belongs to the last of them, and Rust runs last (Ff11): its compile
 * cache is the heaviest, so the files that reach every language run in the CI shard that owns it. A new language
 * joins just before Rust, so no earlier group renumbers and no file already owned by one moves.
 */
export const TOOLCHAIN_PROJECTS = { go: GO, python: PYTHON, csharp: CSHARP, java: JAVA, rust: RUST } as const

/** The default run's test files: the `unit` project's, less every toolchain project's. */
export const DEFAULT_RUN = ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"]

/** A target's harness files: its conformance runner and its harness legs. */
const harnessOf = (target: string) => [
	`tests/integration/conformance/${target}.test.ts`,
	`tests/integration/${target}-harness*.test.ts`,
]

type Group = { exclude?: string[]; include: string[]; name: string }

/**
 * Each project's `test` options: `first` (Node only) sharing the first toolchain's group, then one project per
 * toolchain in a group of its own (00-rules:118).
 */
const groups = (first: Group, toolchains: Readonly<Record<string, readonly string[]>>) => [
	{ ...first, sequence: { groupOrder: 0 } },
	...Object.entries(toolchains).map(([name, include], i) => ({
		include: [...include],
		name,
		sequence: { groupOrder: i },
	})),
]

const group = (spec: TestSpecification) => spec.project.config.sequence.groupOrder

/**
 * BaseSequencer's order less its project-name key: the groups by `sequence.groupOrder`, and in a group the files
 * that ran longest last time first (an unknown one before them), whichever project holds them, as one pool would
 * start them. By project name, every `go` file would start before `unit`'s longest, which would then end last.
 */
export class LongestFirst extends BaseSequencer {
	override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
		const took = (spec: TestSpecification) =>
			this.ctx.cache.getFileTestResults(`${spec.project.name}:${relative(this.ctx.config.root, spec.moduleId)}`)
				?.duration ?? Number.MAX_VALUE
		return Promise.resolve([...files].sort((a, b) => group(a) - group(b) || took(b) - took(a)))
	}
}

export default defineConfig(({ mode }) =>
	mode === "harness"
		? /* no coverage: it executes the coverage-excluded runtime. The default run's groups, a target's harness
			 * files in its language's project, `ts` (Node) beside the first. No project extends this file: vitest
			 * loads it again in mode `test` for one that does, and the default run's exclude drops every harness file */
			{
				test: {
					projects: groups(
						/* the MCP server's harness runs beside ts's: its server and client are Node's */
						{ include: [...harnessOf("ts"), ...harnessOf("mcp")], name: "ts" },
						/* the CLI's harness runs in go's project: its toolchain is Go's (built.ts reaches go-env) */
						Object.fromEntries(
							Object.keys(TOOLCHAIN_PROJECTS).map((name) => [
								name,
								name === "go" ? [...harnessOf("go"), ...harnessOf("cli")] : harnessOf(name),
							]),
						),
					)
						/* go's files each compile cold, the release leg six goreleaser targets: side by side on CI's
						 * four cores they starve each other's compiles past the hook timeout, so they run one at a time */
						.map((test) => ({
							test: {
								...test,
								...(test.name === "go" && { fileParallelism: false }),
								hookTimeout: 60_000,
								testTimeout: 60_000,
							},
						})),
					sequence: { sequencer: LongestFirst },
				},
			}
		: {
				test: {
					coverage: {
						/* 00-rules "Coverage": the vendored SDK runtime templates and the vendored tokenizer are never
						 * honey code under test; index files carry no statements */
						exclude: [
							"src/**/*.test.ts",
							"src/**/*.d.ts",
							"src/**/index.ts",
							"src/**/__fixtures__/**",
							"src/runtime/**",
							"src/_tokenizer/**",
						],
						include: ["src/**"],
						provider: "v8",
						thresholds: { branches: 100, functions: 100, lines: 100, perFile: true, statements: 100 },
					},
					exclude: [...configDefaults.exclude, ...HARNESS],
					passWithNoTests: true,
					sequence: { sequencer: LongestFirst },
					/* one run, one merged coverage report; `sequence.groupOrder` runs the groups one after another. A
					 * project that `extends` adds its include and exclude to the root's (the arrays merge), so the
					 * root names no include and every project keeps the HARNESS exclude */
					projects: groups(
						{ exclude: Object.values(TOOLCHAIN_PROJECTS).flat(), include: DEFAULT_RUN, name: "unit" },
						TOOLCHAIN_PROJECTS,
					).map((test) => ({ extends: true as const, test })),
					/* many tests typecheck emitted code with an in-process TS compiler; a cold one under a full parallel
					 * run takes seconds, so the 5 s default would fail them on load, not on behavior */
					testTimeout: 30_000,
				},
			},
)
