#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { basename } from "node:path"
import { fileURLToPath } from "node:url"

/* Bun runs the TypeScript source; an installed package on any other runtime runs the compiled
 * JavaScript. A repository checkout (marked by tsconfig.json, which is not published) runs the
 * source on Node too, through jiti, so `honey generate` never runs a stale dist/. */
const isBun = typeof globalThis.Bun !== "undefined"
const checkout = existsSync(new URL("../tsconfig.json", import.meta.url))

/* `bun run generate` starts this file through its node shebang. The app is meant for Bun, though
 * (text-module imports such as `.md`, Bun-only APIs), so hand over to the Bun that started us,
 * which `bun run` and `bunx` name in npm_execpath. */
function invokingBun() {
	if (isBun || process.env.HONEY_NO_BUN_HANDOFF === "1") return null
	if (!process.env.npm_config_user_agent?.startsWith("bun/")) return null
	const bun = process.env.npm_execpath
	if (!bun || !/^bunx?(\.exe)?$/.test(basename(bun)) || !existsSync(bun)) return null
	return bun
}

const bun = invokingBun()
if (bun) {
	const run = spawnSync(bun, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
		env: { ...process.env, HONEY_NO_BUN_HANDOFF: "1" },
		stdio: "inherit",
	})
	if (run.error) throw run.error
	if (run.signal) process.kill(process.pid, run.signal)
	process.exit(run.status ?? 1)
} else if (isBun) {
	await import("../src/cli.ts")
} else if (checkout) {
	const { createJiti } = await import("jiti")
	await createJiti(import.meta.url).import("../src/cli.ts")
} else {
	try {
		await import("../dist/cli.js")
	} catch (err) {
		if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err.url).endsWith("/dist/cli.js")) {
			console.error("honey: dist/ is missing from this install. Reinstall @lovrozagar/honey, or run honey with Bun.")
			process.exit(1)
		}
		throw err
	}
}
