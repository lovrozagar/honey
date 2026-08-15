import { defineConfig } from "@playwright/test"
import { e2eAppName, e2eAppTestDir } from "../playwright-app.ts"

const PORT = "4101"
process.env.PORT = PORT
process.env.HONEY_E2E_ENV = "node"

const mode = process.env.TEST_MODE ?? "dev"
const isDev = mode === "dev"
const app = e2eAppName()

export default defineConfig({
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
		command: "bunx tsx src/server.ts",
		env: { HONEY_E2E_APP: app, PORT },
		port: Number(PORT),
		reuseExistingServer: process.env.HONEY_E2E_REUSE === "1",
		timeout: 15_000,
	},
})
