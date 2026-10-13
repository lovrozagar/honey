import { defaultClientConditions, defaultServerConditions } from "vite"
import { defineConfig } from "vitest/config"

/** Language SDK harnesses — go/python/rust/mcp. Opt-in via `test:harness`. */
export const harness = [
	"tests/integration/sdk-harness/**",
	"tests/unit/codegen/go-cli/**",
	"tests/unit/codegen/go-sdk.test.ts",
	"tests/unit/codegen/python-sdk.test.ts",
	"tests/unit/codegen/rust-sdk.test.ts",
	"tests/unit/codegen/*-emitter-byte-equiv.test.ts",
	"tests/regression/ws9-12/polyglot.regression.test.ts",
]

/**
 * Rust-only subset of `harness`. `test:harness:rust` still exists for a cargo-only run.
 * Cargo artifacts go to the workspace `.cache/cargo-target`, not /tmp.
 */
export const harnessRust = ["tests/unit/codegen/rust-sdk.test.ts", "tests/integration/sdk-harness/rust-harness.test.ts"]

/** Empty — leftover extract reds have been restored. */
export const stale: string[] = []

export default defineConfig({
	/* in this repo the package resolves to its source; consumers get dist/ (see docs/packaging.md) */
	resolve: { conditions: ["honey-source", ...defaultClientConditions] },
	ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions] } },
	test: {
		exclude: ["**/node_modules/**", "**/dist/**", ...harness, ...harnessRust, ...stale],
		include: ["tests/**/*.test.ts"],
		passWithNoTests: true,
	},
})
