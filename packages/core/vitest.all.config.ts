import { defaultClientConditions, defaultServerConditions } from "vite"
import { defineConfig } from "vitest/config"

export default defineConfig({
	/* in this repo the package resolves to its source; consumers get dist/ (see docs/packaging.md) */
	resolve: { conditions: ["honey-source", ...defaultClientConditions] },
	ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions] } },
	test: {
		include: ["_v0/tests/**/*.test.ts", "src/**/*.test.ts", "tests/**/*.test.ts", "lint/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**"],
		passWithNoTests: true,
	},
})
