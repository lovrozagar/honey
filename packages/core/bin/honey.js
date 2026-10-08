#!/usr/bin/env node
/* Bun runs the TypeScript source; every other runtime runs the compiled JavaScript. */
const entry = typeof globalThis.Bun === "undefined" ? "../dist/cli.js" : "../src/cli.ts"
try {
	await import(entry)
} catch (err) {
	if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err.url).endsWith("/dist/cli.js")) {
		console.error(
			"honey: dist/ is missing. In a checkout, run `bun run build` in packages/core, or run honey with Bun.",
		)
		process.exit(1)
	}
	throw err
}
