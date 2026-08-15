import { defineConfig } from "vitest/config"
import { CARGO_TARGET_DIR } from "./tests/cargo-env.ts"
import { harness } from "./vitest.config.ts"

export default defineConfig({
	test: {
		env: { CARGO_TARGET_DIR },
		include: harness,
		passWithNoTests: true,
	},
})
