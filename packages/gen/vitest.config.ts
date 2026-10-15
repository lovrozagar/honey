import { configDefaults, defineConfig } from "vitest/config"

/** the opt-in harness (00-rules:119): spawns core's reference app; never part of `bun run test` */
export const HARNESS = [
	"tests/integration/*harness*.test.ts",
	"tests/integration/conformance/{ts,go,rust,python,csharp,java,cli,mcp}.test.ts",
]

export default defineConfig(({ mode }) =>
	mode === "harness"
		? /* no coverage: it executes the coverage-excluded runtime */
			{ test: { hookTimeout: 60_000, include: HARNESS, testTimeout: 60_000 } }
		: {
				test: {
					coverage: {
						/* 00-rules "Coverage": the vendored SDK runtime templates and the vendored tokenizer are never
						 * honey code under test; index and type-only files carry no statements */
						exclude: [
							"src/**/*.test.ts",
							"src/**/*.d.ts",
							"src/**/index.ts",
							"src/**/__fixtures__/**",
							"src/runtime/**",
							"src/_tokenizer/**",
							"src/**/types.ts",
						],
						include: ["src/**"],
						provider: "v8",
						thresholds: { branches: 100, functions: 100, lines: 100, perFile: true, statements: 100 },
					},
					exclude: [...configDefaults.exclude, ...HARNESS],
					include: ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
					passWithNoTests: true,
					/* many tests typecheck emitted code with an in-process TS compiler; a cold one under a full parallel
					 * run takes seconds, so the 5 s default would fail them on load, not on behavior */
					testTimeout: 30_000,
				},
			},
)
