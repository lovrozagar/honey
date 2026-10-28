/**
 * The cf e2e host's Playwright config (bit 20 j3): dev serves src/worker.ts with core read as source; prod serves the
 * app's built Workers bundle under local workerd, unbundled and with no source condition; with HONEY_CF_URL set (a
 * deployed worker), prod targets that URL and starts no local server, and its WebSockets dial that host too (bit 20:
 * every live WebSocket leg dialed localhost and got no frame). Bit 21 h: the mcp app runs its own configs, each binding
 * the Durable Object its uploads go through.
 */
import { afterEach, describe, expect, it, vi } from "vitest"

type Config = { use?: { baseURL?: string }; webServer?: { command: string; env?: Record<string, string> } }

afterEach(() => {
	vi.unstubAllEnvs()
	vi.resetModules()
})

/** The `host` e2e Playwright config as Playwright loads it, under `env` alone. */
async function configUnder(env: Record<string, string>, host = "cf-workers"): Promise<Config> {
	vi.unstubAllEnvs()
	vi.resetModules()
	for (const [key, value] of Object.entries({ HONEY_CF_URL: undefined, HONEY_E2E_APP: "kitchen", ...env }))
		vi.stubEnv(key, value)
	return ((await import(`../e2e/${host}/playwright.config.ts`)) as { default: Config }).default
}

/** The HTTP and WebSocket bases the e2e tests of a run under `env` on `host` use, as their worker sees the env. */
async function basesUnder(env: Record<string, string>, host?: string): Promise<[string | undefined, string]> {
	const { use } = await configUnder(env, host)
	const { e2eWsBase } = await import("../e2e/playwright-app.ts")
	return [use?.baseURL, e2eWsBase()]
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

	it("serves the mcp app under its own configs, each with its uploads' Durable Object and no node compatibility", async () => {
		/* one after the other: each load stubs the process's env */
		const dev = (await configUnder({ HONEY_E2E_APP: "mcp", TEST_MODE: "dev" })).webServer
		const prod = (await configUnder({ HONEY_E2E_APP: "mcp", TEST_MODE: "prod" })).webServer
		expect([dev?.command, dev?.env?.WRANGLER_BUILD_CONDITIONS, prod?.command, prod?.env]).toEqual([
			"bunx wrangler dev --config wrangler.mcp.jsonc --port 4102 --ip 0.0.0.0",
			"honey-source,workerd,worker,browser",
			"bunx wrangler dev --config wrangler.web.jsonc --port 4102 --ip 0.0.0.0",
			{ PORT: "4102" },
		])
	})

	it("targets a deployed worker's URL and starts no server when HONEY_CF_URL is set", async () => {
		const url = "https://honey-e2e-kitchen.example.workers.dev"
		const config = await configUnder({ HONEY_CF_URL: url, TEST_MODE: "prod" })
		expect([config.use?.baseURL, "webServer" in config]).toEqual([url, false])
	})
})

describe("the e2e bases a run's tests dial (bit 20)", () => {
	it("dials a deployed worker's host for WebSockets when HONEY_CF_URL is set: https as wss, http as ws", async () => {
		expect([
			await basesUnder({ HONEY_CF_URL: "https://honey-e2e-kitchen.example.workers.dev/", TEST_MODE: "prod" }),
			await basesUnder({ HONEY_CF_URL: "http://127.0.0.1:8787", TEST_MODE: "prod" }),
		]).toEqual([
			["https://honey-e2e-kitchen.example.workers.dev", "wss://honey-e2e-kitchen.example.workers.dev"],
			["http://127.0.0.1:8787", "ws://127.0.0.1:8787"],
		])
	})

	it("dials the local host on each host's port otherwise, and a bun or node run ignores a stray HONEY_CF_URL", async () => {
		const stray = { HONEY_CF_URL: "https://honey-e2e-kitchen.example.workers.dev", TEST_MODE: "dev" }
		expect([
			await basesUnder({ TEST_MODE: "dev" }),
			await basesUnder(stray, "bun"),
			await basesUnder(stray, "node"),
		]).toEqual([
			["http://localhost:4102", "ws://localhost:4102"],
			["http://localhost:4100", "ws://localhost:4100"],
			["http://localhost:4101", "ws://localhost:4101"],
		])
	})
})
