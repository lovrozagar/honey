#!/usr/bin/env node
import { existsSync } from "node:fs"

/* Bun runs the TypeScript source; an installed package on any other runtime runs the compiled
 * JavaScript. A repository checkout (marked by tsconfig.json, which is not published) runs the
 * source on Node too, through jiti, so `honey generate` never runs a stale dist/. */
const isBun = typeof globalThis.Bun !== "undefined"
const checkout = existsSync(new URL("../tsconfig.json", import.meta.url))

if (isBun) {
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
