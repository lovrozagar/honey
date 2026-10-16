/**
 * The Python post-pass (R2, Fb9): `ruff format` as a `Formatter` for `formatFiles`, under the extension key
 * `py`. gen never chooses a ruff: the caller passes the binary it pins (in tests, python-env's `ruffPath`).
 * ruff ignores `options` (88 columns, four spaces), and `--isolated` keeps it from reading any configuration:
 * a consumer's `[tool.ruff]` above the cwd never changes the output.
 */
import { spawn } from "node:child_process"
import type { Formatter } from "./format.ts"

/** A formatter that pipes a file through `ruff format`; a parse error or a ruff that cannot run is an error. */
export function ruffFormatter(ruff: string): Formatter {
	return (fileName, source) =>
		new Promise((resolve) => {
			const args = ["format", "--isolated", "--target-version", "py311", "--stdin-filename", fileName, "-"]
			const child = spawn(ruff, args, { stdio: ["pipe", "pipe", "pipe"] })
			let stdout = ""
			let stderr = ""
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				stdout += chunk
			})
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk
			})
			child.on("error", (error) => resolve({ code: source, errors: [error.message] }))
			child.on("close", (status) => {
				const failure = stderr.trim() || `${ruff} exited with status ${String(status)}`
				resolve(status === 0 ? { code: stdout, errors: [] } : { code: source, errors: [failure] })
			})
			child.stdin.on("error", () => {
				/* a ruff that never started or stopped reading: its spawn error or exit status answers */
			})
			child.stdin.end(source)
		})
}
