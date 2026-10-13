import { defaultClientConditions, defaultServerConditions } from "vite"
import { defineConfig } from "vitest/config"

/* v1 only: v0 is the frozen oracle under /_v0 with its own config. Until cutover the package name
 * resolves to v0, so a structure test that imports it reads v0's source, never a stale dist/. */
export default defineConfig({
	resolve: { conditions: ["honey-source", ...defaultClientConditions] },
	ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions] } },
	test: {
		coverage: {
			/* 00-rules "Coverage": every v1 source file at 100%; index and type-only files carry no statements */
			exclude: ["src/**/*.test.ts", "src/**/*.d.ts", "src/**/index.ts", "src/**/__fixtures__/**", "src/**/types.ts"],
			include: ["src/**"],
			provider: "v8",
			thresholds: { branches: 100, functions: 100, lines: 100, perFile: true, statements: 100 },
		},
		exclude: ["**/node_modules/**", "tests/e2e/**"],
		include: ["src/**/*.test.ts", "tests/**/*.test.ts", "lint/**/*.test.ts"],
		passWithNoTests: true,
	},
})
