/** Runs `honey generate` in a child process. Not a package export. */
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, extname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"

/**
 * argv that starts this package's CLI on the current runtime. Bun and a compiled install run the
 * CLI directly. Source under Node (this repository's tests) goes through jiti's loader, with the
 * `honey-source` condition so the app resolves the package to the same source.
 */
export function cliInvocation(): string[] {
	const self = fileURLToPath(import.meta.url)
	const ext = extname(self)
	const cli = join(dirname(self), `cli${ext}`)
	if (ext !== ".ts" || isBun) return [process.execPath, cli]
	const jitiDir = dirname(createRequire(import.meta.url).resolve("jiti/package.json"))
	const register = pathToFileURL(join(jitiDir, "lib", "jiti-register.mjs")).href
	return [process.execPath, "--conditions=honey-source", "--import", register, cli]
}

/**
 * Runs `honey <args>` in `cwd` and resolves when it exits 0. Each run gets a fresh module graph,
 * so edits to any file the app imports are seen, and app side effects die with the child.
 */
export function runCli(args: string[], options: { cwd: string; env?: Record<string, string> }): Promise<void> {
	const [cmd, ...pre] = cliInvocation() as [string, ...string[]]
	return new Promise((resolvePromise, reject) => {
		const child = spawn(cmd, [...pre, ...args], {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "inherit", "inherit"],
		})
		child.on("error", reject)
		child.on("exit", (code, signal) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`honey ${args[0] ?? ""} failed (${signal ?? `exit ${code}`})`))
		})
	})
}
