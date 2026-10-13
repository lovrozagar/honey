import { defaultClientConditions, defaultServerConditions } from "vite"
import { defineConfig } from "vitest/config"
import { CARGO_TARGET_DIR } from "./tests/cargo-env.ts"
import { harnessRust } from "./vitest.config.ts"

export default defineConfig({
	/* in this repo the package resolves to its source; consumers get dist/ (see docs/packaging.md) */
	resolve: { conditions: ["honey-source", ...defaultClientConditions] },
	ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions] } },
	test: {
		env: { CARGO_TARGET_DIR },
		include: harnessRust,
		passWithNoTests: true,
	},
})
