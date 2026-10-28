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
/* the apps whose Workers bundle runs with no node compatibility at all: the MCP mount's portable runtime (bit 21 e) */
const WEB_ONLY = new Set(["mcp"])

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
 * A WEB_ONLY app (bit 21 h) runs its own configs, without nodejs_compat and with the Durable Object its uploads go
 * through: dev wrangler.mcp.jsonc (src/mcp-dev.ts, from source), prod wrangler.web.jsonc (the built bundle as above,
 * which exports the object class itself: honey's build passes the entry's named exports on).
 */
function webServer() {
	const bundle = `../apps/${app}/dist/cloudflare/index.js`
	const web = WEB_ONLY.has(app)
	/* dev: honey-source first, then wrangler's defaults; prod: nothing resolves, the bundle is already built */
	const env: Record<string, string> = isDev
		? { HONEY_E2E_APP: app, PORT, WRANGLER_BUILD_CONDITIONS: "honey-source,workerd,worker,browser" }
		: { PORT }
	const command = isDev
		? web
			? `bunx wrangler dev --config wrangler.mcp.jsonc --port ${PORT} --ip 0.0.0.0`
			: `bunx wrangler dev --port ${PORT} --ip 0.0.0.0 --var HONEY_E2E_APP:${app}`
		: `bunx wrangler dev ${bundle} --config ${web ? "wrangler.web.jsonc" : "wrangler.jsonc"} --no-bundle --port ${PORT} --ip 0.0.0.0`
	return {
		command,
		env,
		port: Number(PORT),
		reuseExistingServer: process.env.HONEY_E2E_REUSE === "1",
		timeout: 15_000,
	}
}
