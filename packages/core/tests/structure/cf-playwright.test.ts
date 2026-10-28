/**
 * The cf e2e host's Playwright config (bit 20 j3): dev serves src/worker.ts with core read as source; prod serves the
 * app's built Workers bundle under local workerd, unbundled and with no source condition; with HONEY_CF_URL set (a
 * deployed worker), prod targets that URL and starts no local server.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

type Config = { use?: { baseURL?: string }; webServer?: { command: string; env?: Record<string, string> } }

afterEach(() => {
	vi.unstubAllEnvs()
	vi.resetModules()
})

/** The config as Playwright loads it, under `env`. */
async function configUnder(env: Record<string, string>): Promise<Config> {
	vi.resetModules()
	for (const [key, value] of Object.entries({ HONEY_E2E_APP: "kitchen", ...env })) vi.stubEnv(key, value)
	return ((await import("../e2e/cf-workers/playwright.config.ts")) as { default: Config }).default
}

describe("the cf e2e host's Playwright config", () => {
	it("serves the worker from source in dev", async () => {
		const { webServer } = await configUnder({ TEST_MODE: "dev" })
		expect([
			webServer?.command.startsWith("bunx wrangler dev --port"),
			webServer?.env?.WRANGLER_BUILD_CONDITIONS,
		]).toEqual([true, "honey-source,workerd,worker,browser"])
	})

	it("serves the app's built bundle in prod, unbundled and with no source condition", async () => {
		const { use, webServer } = await configUnder({ TEST_MODE: "prod" })
		expect([use?.baseURL, webServer?.command, webServer?.env]).toEqual([
			"http://localhost:4102",
			"bunx wrangler dev ../apps/kitchen/dist/cloudflare/index.js --config wrangler.jsonc --no-bundle --port 4102 --ip 0.0.0.0",
			{ PORT: "4102" },
		])
	})

	it("targets a deployed worker's URL and starts no server when HONEY_CF_URL is set", async () => {
		const url = "https://honey-e2e-kitchen.example.workers.dev"
		const config = await configUnder({ HONEY_CF_URL: url, TEST_MODE: "prod" })
		expect([config.use?.baseURL, "webServer" in config]).toEqual([url, false])
	})
})
