import { defaultClientConditions, defaultServerConditions } from "vite"
import { defineConfig } from "vitest/config"

/* v1 only: /_v0 is frozen on disk as the inventory's source, never run. The package name resolves
 * to this package, and a test that imports it reads its source, never a stale or missing dist/. */
export default defineConfig({
	resolve: { conditions: ["honey-source", ...defaultClientConditions] },
	ssr: {
		/* tests run on Node, so packages resolve as Node resolves them: "module" names bundler-only
		 * builds (OpenTelemetry's has extensionless imports Node cannot load) */
		resolve: { conditions: ["honey-source", ...defaultServerConditions.filter((c) => c !== "module")] },
	},
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
