import { defaultClientConditions, defaultServerConditions } from "vite"
import { defineConfig } from "vitest/config"
import { CARGO_TARGET_DIR } from "./tests/cargo-env.ts"
import { harness } from "./vitest.config.ts"

export default defineConfig({
	/* in this repo the package resolves to its source; consumers get dist/ (see docs/packaging.md) */
	resolve: { conditions: ["honey-source", ...defaultClientConditions] },
	ssr: { resolve: { conditions: ["honey-source", ...defaultServerConditions] } },
	test: {
		env: { CARGO_TARGET_DIR },
		/* provisions .cache/python-venv once, before any worker (see tests/python-env.ts) */
		globalSetup: ["./tests/python-setup.ts"],
		include: harness,
		passWithNoTests: true,
		/* a runner knob, no assertion: a harness case spawns an install or a toolchain under its own bound
		 * (T4.1's bun install has 60 s against the npm registry), which the 5 s default cut short on CI;
		 * the runner's bound sits past every case's own */
		testTimeout: 90_000,
	},
})
