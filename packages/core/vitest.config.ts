import { defaultClientConditions, defaultServerConditions } from "vite"
import { defineConfig } from "vitest/config"

/** Language SDK harnesses — go/python/rust/mcp. Opt-in via `test:harness`. */
export const harness = [
	"_v0/tests/integration/sdk-harness/**",
	"_v0/tests/unit/codegen/go-cli/**",
	"_v0/tests/unit/codegen/go-sdk.test.ts",
	"_v0/tests/unit/codegen/python-sdk.test.ts",
	"_v0/tests/unit/codegen/rust-sdk.test.ts",
	"_v0/tests/unit/codegen/*-emitter-byte-equiv.test.ts",
	"_v0/tests/regression/ws9-12/polyglot.regression.test.ts",
]

/**
 * Rust-only subset of `harness`. `test:harness:rust` still exists for a cargo-only run.
 * Cargo artifacts go to the workspace `.cache/cargo-target`, not /tmp.
 */
export const harnessRust = [
	"_v0/tests/unit/codegen/rust-sdk.test.ts",
	"_v0/tests/integration/sdk-harness/rust-harness.test.ts",
]

/** Empty — leftover extract reds have been restored. */
export const stale: string[] = []

export default defineConfig({
	/* in this repo the package resolves to its source; consumers get dist/ (see docs/packaging.md) */
	resolve: { conditions: ["honey-source", ...defaultClientConditions] },
	ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions] } },
	test: {
		exclude: ["**/node_modules/**", "**/dist/**", "tests/e2e/**", ...harness, ...harnessRust, ...stale],
		include: ["_v0/tests/**/*.test.ts", "src/**/*.test.ts", "tests/**/*.test.ts", "lint/**/*.test.ts"],
		passWithNoTests: true,
	},
})
