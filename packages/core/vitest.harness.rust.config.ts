import { defineConfig } from "vitest/config"
import { harnessRust } from "./vitest.config.ts"

export default defineConfig({
	test: {
		include: harnessRust,
		passWithNoTests: true,
	},
})
