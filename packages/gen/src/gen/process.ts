/**
 * The generate CLI's child process (bit 17 phase h): watch mode runs each generation as a fresh `honey-codegen`, so
 * nothing one run loads outlives it. The child is the package's own bin on this runtime, which picks the entry as it
 * does for a user (Bun the TypeScript source, a checkout the source through jiti, an install the compiled one).
 */
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

/** argv that starts the package's `honey-codegen` bin on the current runtime. */
export function cliInvocation(): [string, string] {
	return [process.execPath, fileURLToPath(new URL("../../bin/honey-codegen.js", import.meta.url))]
}

/** How a child ended, as a failure names it: its signal, else its exit code. */
export const endOf = (code: number | null, signal: NodeJS.Signals | null): string => signal ?? `exit ${code}`

/**
 * Runs `honey-codegen <args>` in `cwd` with its output inherited, and resolves when it exits 0; any other end rejects
 * with how it ended. A Bun handoff is never repeated in the child, and the child is marked HONEY_CODEGEN_CHILD, over
 * any `env`, so it refuses `--watch`.
 */
export function runCli(args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<void> {
	const [command, bin] = cliInvocation()
	return new Promise((resolve, reject) => {
		const child = spawn(command, [bin, ...args], {
			cwd: options.cwd,
			env: { ...process.env, HONEY_NO_BUN_HANDOFF: "1", ...options.env, HONEY_CODEGEN_CHILD: "1" },
			stdio: ["ignore", "inherit", "inherit"],
		})
		child.on("error", reject)
		child.on("exit", (code, signal) => {
			if (code === 0) resolve()
			else reject(new Error(`honey-codegen ${args[0] ?? ""} failed (${endOf(code, signal)})`))
		})
	})
}
