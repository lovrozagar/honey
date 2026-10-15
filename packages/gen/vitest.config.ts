import { defineConfig } from "vitest/config"

export default defineConfig({
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
		include: ["src/**/*.test.ts", "tests/**/*.test.ts", "scripts/**/*.test.ts"],
		passWithNoTests: true,
		/* many tests typecheck emitted code with an in-process TS compiler; a cold one under a full parallel
		 * run takes seconds, so the 5 s default would fail them on load, not on behavior */
		testTimeout: 30_000,
	},
})
