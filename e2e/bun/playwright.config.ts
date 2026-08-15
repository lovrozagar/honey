import { defineConfig } from "@playwright/test"

const PORT = "4100"
process.env.PORT = PORT

const mode = process.env.TEST_MODE ?? "dev"
const isDev = mode === "dev"

export default defineConfig({
	expect: { timeout: 10_000 },
	forbidOnly: true,
	grepInvert: isDev ? /@prod-only/ : /@dev-only/,
	retries: 0,
	testDir: "../app/e2e",
	timeout: 30_000,
	use: {
		baseURL: `http://localhost:${PORT}`,
		trace: "on-first-retry",
	},
	webServer: {
		command: "bun run src/server.ts",
		env: { PORT },
		port: Number(PORT),
		reuseExistingServer: true,
		timeout: 15_000,
	},
})
