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
 * imports. They run as the `go` project. `tests/structure/toolchain-projects.test.ts` holds a file that reaches
 * Go to this list, and a file listed here outside `src/emit/go/` to reaching Go.
 */
export const GO = [
	"src/emit/go/**/*.test.ts",
	"src/emit/shared/escape.test.ts",
	"src/emit/shared/gofmt.test.ts",
	"tests/security/emit-adversarial.test.ts",
	"tests/structure/mutation-harness.test.ts",
]

/**
 * The default run's test files that run Rust: each reaches `rust-env.ts`, the one way gen runs Rust, through its
 * imports. They run as the `rust` project, held to that as `GO` is. A file that reaches Go too runs here, in the
 * later group, where no other language runs beside it.
 */
export const RUST = ["src/emit/shared/*.toolchains.test.ts", "tests/structure/rust-toolchain.test.ts"]

/**
 * Each language toolchain's project, in the order their `sequence.groupOrder` groups run, one language group at
 * a time: two toolchains at once at most, Node and one language (00-rules:118, G17). `unit` (Node only) shares
 * the first group, so its files fill the workers beside the first language instead of adding a serial group. A
 * file whose imports reach several languages belongs to the last of them.
 */
export const TOOLCHAIN_PROJECTS = { go: GO, rust: RUST } as const

/** The default run's test files: the `unit` project's, less every toolchain project's. */
export const DEFAULT_RUN = ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"]

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
		? /* no coverage: it executes the coverage-excluded runtime */
			{ test: { hookTimeout: 60_000, include: HARNESS, testTimeout: 60_000 } }
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
					projects: [
						{
							extends: true,
							test: {
								exclude: Object.values(TOOLCHAIN_PROJECTS).flat(),
								include: DEFAULT_RUN,
								name: "unit",
								sequence: { groupOrder: 0 },
							},
						},
						...Object.entries(TOOLCHAIN_PROJECTS).map(([name, include], i) => ({
							extends: true as const,
							test: { include: [...include], name, sequence: { groupOrder: i } },
						})),
					],
					/* many tests typecheck emitted code with an in-process TS compiler; a cold one under a full parallel
					 * run takes seconds, so the 5 s default would fail them on load, not on behavior */
					testTimeout: 30_000,
				},
			},
)
