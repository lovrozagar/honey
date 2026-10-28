import type { ReporterDescription } from "@playwright/test"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export function e2eAppName(): string {
	return process.env.HONEY_E2E_APP ?? "kitchen"
}

/** Playwright testDir for the selected app, resolved from this file. */
export function e2eAppTestDir(): string {
	const app = e2eAppName()
	const dir = join(dirname(fileURLToPath(import.meta.url)), "apps", app, "tests", "e2e")
	if (!existsSync(dir)) {
		throw new Error(`e2e tests not found for app "${app}" at ${dir}`)
	}
	return dir
}

/**
 * The run's HTTP base: on the cf host with HONEY_CF_URL set (the live run), that deployed worker's URL; else the local
 * host on PORT. Every e2e base derives from it, so a remote run never dials localhost (bit 20). Another host ignores
 * HONEY_CF_URL, so a stray one never sends its sockets to Cloudflare while its requests stay local.
 */
export function e2eBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
	const deployed = env.HONEY_E2E_ENV === "cf" ? env.HONEY_CF_URL : undefined
	return deployed === undefined ? `http://localhost:${env.PORT ?? "4100"}` : deployed.replace(/\/+$/, "")
}

/** The WebSocket base on `httpBase`'s host: http→ws, https→wss. */
export function wsBaseOf(httpBase: string): string {
	return httpBase.replace(/^http(s?):\/\//, "ws$1://")
}

/** The run's WebSocket base, on the HTTP base's host. */
export function e2eWsBase(env: NodeJS.ProcessEnv = process.env): string {
	return wsBaseOf(e2eBaseUrl(env))
}

/** With HONEY_E2E_RECORD set (`run.ts --record`), Playwright also writes its JSON report there. */
export function e2eReporter(): { reporter?: ReporterDescription[] } {
	const file = process.env.HONEY_E2E_RECORD
	return file ? { reporter: [["list"], ["json", { outputFile: file }]] } : {}
}
