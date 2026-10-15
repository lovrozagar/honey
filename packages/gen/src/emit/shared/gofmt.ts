/**
 * The Go post-pass (R2): gofmt as a `Formatter` for `formatFiles`. gen never chooses a Go — the
 * caller passes the gofmt binary of the toolchain it pins (in tests, go-env's `gofmtPath()`), so the
 * format is the same wherever it runs. gofmt ignores `options`: Go has one canonical layout.
 */
import { spawn } from "node:child_process"
import type { Formatter } from "./format.ts"

/** A formatter that pipes a file through `gofmt`; a parse error or a gofmt that cannot run is an error. */
export function gofmtFormatter(gofmt: string): Formatter {
	return (_fileName, source) =>
		new Promise((resolve) => {
			const child = spawn(gofmt, [], { stdio: ["pipe", "pipe", "pipe"] })
			let stdout = ""
			let stderr = ""
			child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
				stdout += chunk
			})
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
				stderr += chunk
			})
			child.on("error", (error) => resolve({ code: source, errors: [error.message] }))
			child.on("close", (status) =>
				resolve(status === 0 ? { code: stdout, errors: [] } : { code: source, errors: [stderr.trim()] }),
			)
			child.stdin.on("error", () => {
				/* a gofmt that never started: its spawn error answers */
			})
			child.stdin.end(source)
		})
}
