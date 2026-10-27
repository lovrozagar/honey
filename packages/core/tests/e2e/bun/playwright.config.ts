import { defineConfig } from "@playwright/test"
import { e2eAppName, e2eAppTestDir, e2eReporter } from "../playwright-app.ts"

const PORT = "4100"
process.env.PORT = PORT
process.env.HONEY_E2E_ENV = "bun"

const mode = process.env.TEST_MODE ?? "dev"
const isDev = mode === "dev"
const app = e2eAppName()

export default defineConfig({
	...e2eReporter(),
	expect: { timeout: 10_000 },
	forbidOnly: true,
	grepInvert: isDev ? /@prod-only/ : /@dev-only/,
	retries: 0,
	testDir: e2eAppTestDir(),
	timeout: 30_000,
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "on-first-retry",
	},
	webServer: {
		/* prod serves the bundle run.ts built, with no honey-source condition: what a deploy runs (Q14); dev
		   resolves @lovrozagar/honey to its source, not a dist/ that may be stale or missing */
		command: isDev ? "bun --conditions=honey-source src/server.ts" : `bun ../apps/${app}/dist/bun/index.js`,
		env: { HONEY_E2E_APP: app, PORT },
		port: Number(PORT),
		reuseExistingServer: process.env.HONEY_E2E_REUSE === "1",
		timeout: 15_000,
	},
})
