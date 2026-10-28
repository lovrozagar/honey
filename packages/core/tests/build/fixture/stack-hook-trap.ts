/**
 * Preloaded (`bun --preload`) into a real e2e build and every process it starts, by stack-hook.test.ts. It guards bit
 * 20 k-fix's whole class: Bun installs its own `Error.prepareStackTrace` and runs it only for real Errors, but once
 * anything replaces the hook, Bun rejects the `Error.captureStackTrace` that Vite's bundled follow-redirects calls on a
 * non-Error at load (`new RedirectionError()` as a prototype), and the build dies with "First argument must be an Error
 * object". k-fix's replacer was jiti's Babel, loaded on a cold cache. Any replacer reds a build only on some path, so
 * the trap reports every one, pass or fail: one JSON line per process started and per replacement, with the
 * replacer's stack, appended to HONEY_STACK_HOOK_LOG. A replacement still takes effect, so the build runs as it would.
 */
import { appendFileSync } from "node:fs"

const log = process.env.HONEY_STACK_HOOK_LOG
if (log === undefined || log === "") throw new Error("stack-hook-trap: HONEY_STACK_HOOK_LOG names no file")

const record = (entry: Record<string, unknown>) =>
	appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(1), pid: process.pid, ...entry })}\n`)

let hook: unknown = (Error as { prepareStackTrace?: unknown }).prepareStackTrace
record({ kind: "start" })
Object.defineProperty(Error, "prepareStackTrace", {
	configurable: true,
	get: () => hook,
	set(value: unknown) {
		record({ kind: "replaced", stack: new Error("Error.prepareStackTrace replaced").stack })
		hook = value
	},
})
