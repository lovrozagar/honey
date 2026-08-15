import { defineConfig } from "vitest/config"

/** Language SDK harnesses — go/python/rust/mcp. Opt-in via `test:harness`. */
export const harness = [
	"tests/integration/sdk-harness/**",
	"tests/unit/codegen/go-cli/**",
	"tests/unit/codegen/go-sdk.test.ts",
	"tests/unit/codegen/python-sdk.test.ts",
	"tests/unit/codegen/rust-sdk.test.ts",
	"tests/unit/codegen/*-emitter-byte-equiv.test.ts",
]

/**
 * Rust-only subset of `harness`. `test:harness:rust` still exists for a cargo-only run.
 * Cargo artifacts go to the workspace `.cache/cargo-target`, not /tmp.
 */
export const harnessRust = [
	"tests/unit/codegen/rust-sdk.test.ts",
	"tests/integration/sdk-harness/rust-harness.test.ts",
]

/** Empty — leftover extract reds have been restored. */
export const stale: string[] = []

export default defineConfig({
	test: {
		exclude: ["**/node_modules/**", "**/dist/**", ...harness, ...harnessRust, ...stale],
		include: ["tests/**/*.test.ts"],
		passWithNoTests: true,
	},
})
