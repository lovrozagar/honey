import { defineConfig } from "vitest/config"
import { harness } from "./vitest.config.ts"

export default defineConfig({
	test: {
		include: harness,
		passWithNoTests: true,
	},
})
