import { defineConfig } from "@playwright/test"
import { e2eAppName, e2eAppTestDir, e2eBaseUrl, e2eReporter } from "../playwright-app.ts"

const PORT = "4102"
process.env.PORT = PORT
process.env.HONEY_E2E_ENV = "cf"

const mode = process.env.TEST_MODE ?? "dev"
const isDev = mode === "dev"
const app = e2eAppName()
/* a deployed worker's https URL (the live run): prod targets it, and no local server starts */
const deployed = process.env.HONEY_CF_URL

export default defineConfig({
	...e2eReporter(),
	expect: { timeout: 10_000 },
	forbidOnly: true,
	grepInvert: isDev ? /@prod-only/ : /@dev-only/,
	retries: 0,
	testDir: e2eAppTestDir(),
	timeout: 30_000,
	use: {
		baseURL: e2eBaseUrl(),
		trace: "on-first-retry",
	},
	...(deployed === undefined ? { webServer: webServer() } : {}),
})

/**
 * dev resolves @lovrozagar/honey to its source through src/worker.ts; prod serves the app's built Workers bundle under
 * local workerd, unbundled and with no source condition: what a deploy runs (j3). The bundle is one file, no chunks.
 */
function webServer() {
	const bundle = `../apps/${app}/dist/cloudflare/index.js`
	/* dev: honey-source first, then wrangler's defaults; prod: nothing resolves, the bundle is already built */
	const env: Record<string, string> = isDev
		? { HONEY_E2E_APP: app, PORT, WRANGLER_BUILD_CONDITIONS: "honey-source,workerd,worker,browser" }
		: { PORT }
	return {
		command: isDev
			? `bunx wrangler dev --port ${PORT} --ip 0.0.0.0 --var HONEY_E2E_APP:${app}`
			: `bunx wrangler dev ${bundle} --config wrangler.jsonc --no-bundle --port ${PORT} --ip 0.0.0.0`,
		env,
		port: Number(PORT),
		reuseExistingServer: process.env.HONEY_E2E_REUSE === "1",
		timeout: 15_000,
	}
}
