import { defineConfig } from "@playwright/test"

const PORT = "4103"
process.env.PORT = PORT
process.env.WS_HOST = "127.0.0.1"

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
		baseURL: `http://127.0.0.1:${PORT}`,
		trace: "on-first-retry",
	},
	webServer: {
		command: "deno run --allow-all src/server.ts",
		env: { PORT },
		port: Number(PORT),
		reuseExistingServer: true,
		timeout: 15_000,
	},
})
