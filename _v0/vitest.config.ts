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

/* outside every default-run project: the harnesses and the build output */
const excluded = ["**/node_modules/**", "**/dist/**", ...harness, ...harnessRust, ...stale]

/*
 * a runner knob, no assertion: the suites whose real servers race the clock (health waits on fixed
 * ports, an unbound-port check, a drain that must answer 503 before it closes) each run alone, before
 * the rest of the suite: alone, so this suite's own workers never contend with them (each failed only
 * inside the full parallel run on a loaded machine and passes alone); first, because their fixed ports
 * sit in the ephemeral range, where a server the rest of the suite left listening can hold one
 */
export const serial = [
	"tests/unit/build/build-targets.test.ts",
	"tests/unit/plugin/generate-and-write.test.ts",
	"tests/integration/bug-hunt-9.test.ts",
]

export default defineConfig({
	/* in this repo the package resolves to its source; consumers get dist/ (see docs/packaging.md) */
	resolve: { conditions: ["honey-source", ...defaultClientConditions] },
	ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions] } },
	test: {
		passWithNoTests: true,
		projects: [
			{
				extends: true,
				test: {
					exclude: [...excluded, ...serial],
					include: ["tests/**/*.test.ts"],
					name: "v0",
					sequence: { groupOrder: serial.length },
				},
			},
			...serial.map((file, i) => ({
				extends: true,
				test: { exclude: excluded, include: [file], name: `v0-serial-${i + 1}`, sequence: { groupOrder: i } },
			})),
		],
		/* the oracle count (00-rules): the v0 suite keeps the committed passed/skipped totals */
		reporters: ["default", "../packages/core/tests/structure/oracle-count.ts"],
		/* a runner knob, no assertion: the process-spawning cases (a gateway generation takes ~2.5 s
		 * alone) exceed the 5 s default when this suite's own workers and other processes load the
		 * machine; measured at 6.7 s */
		testTimeout: 30_000,
	},
})
