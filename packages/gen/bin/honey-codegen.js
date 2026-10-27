#!/usr/bin/env node
// The honey-codegen bin (bit 17 phase h). A repository checkout (marked by tsconfig.json, which is not published)
// runs the TypeScript source, natively on Bun and through jiti on Node, so a stale dist/ never runs; an installed
// package runs the compiled JavaScript on any runtime (the tarball ships dist/, not src/).
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { basename } from "node:path"
import { fileURLToPath } from "node:url"

const isBun = typeof globalThis.Bun !== "undefined"
const checkout = existsSync(new URL("../tsconfig.json", import.meta.url))

// `bun run` and `bunx` start this file through its node shebang, while what they run is meant for Bun: hand over to
// the Bun that started us, which they name in npm_execpath. Once, never again in the child.
function invokingBun() {
	if (isBun || process.env.HONEY_NO_BUN_HANDOFF === "1") return null
	if (!process.env.npm_config_user_agent?.startsWith("bun/")) return null
	const bun = process.env.npm_execpath
	if (!bun || !/^bunx?(\.exe)?$/.test(basename(bun)) || !existsSync(bun)) return null
	return bun
}

// The handoff: Bun runs this file with our arguments; a signal we get is passed on to it, and we end as it ended,
// its exit code or the same signal.
function handOff(bun) {
	const child = spawn(bun, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
		env: { ...process.env, HONEY_NO_BUN_HANDOFF: "1" },
		stdio: "inherit",
	})
	const forward = (signal) => child.kill(signal)
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, forward)
	child.on("error", (error) => {
		console.error(`honey-codegen: could not start ${bun}: ${error.message}`)
		process.exit(1)
	})
	child.on("exit", (code, signal) => {
		if (signal) {
			for (const each of ["SIGINT", "SIGTERM", "SIGHUP"]) process.off(each, forward)
			process.kill(process.pid, signal)
			return
		}
		process.exit(code ?? 1)
	})
}

async function entry() {
	if (checkout) {
		if (isBun) return import("../src/cli.ts")
		const { createJiti } = await import("jiti")
		return createJiti(import.meta.url).import("../src/cli.ts")
	}
	try {
		return await import("../dist/cli.js")
	} catch (error) {
		if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.url).endsWith("/dist/cli.js")) {
			console.error("honey-codegen: dist/ is missing from this install. Reinstall it, or run it with Bun.")
			process.exit(1)
		}
		throw error
	}
}

const bun = invokingBun()
if (bun) handOff(bun)
else {
	const { main } = await entry()
	const code = await main(process.argv.slice(2))
	/* an --app module may leave a timer or a socket open: the run is over once main returns, its output flushed */
	for (const stream of [process.stdout, process.stderr]) await new Promise((done) => stream.write("", done))
	process.exit(code)
}
