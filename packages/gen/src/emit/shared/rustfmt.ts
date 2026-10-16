/**
 * The Rust post-pass (R2): rustfmt as a `Formatter` for `formatFiles`, under the extension key `rs`.
 * gen never chooses a Rust: the caller passes the rustfmt binary of the toolchain it pins (in tests,
 * rust-env's `rustfmtPath`). rustfmt ignores `options`, and it reads no configuration but the empty
 * one: on stdin it would otherwise take a `rustfmt.toml` from the cwd's ancestors or the user's config.
 */
import { spawn } from "node:child_process"
import { devNull } from "node:os"
import type { Formatter } from "./format.ts"

/** A formatter that pipes a file through `rustfmt` for `edition`; a parse error or a rustfmt that cannot run is an error. */
export function rustfmtFormatter(rustfmt: string, edition = "2024"): Formatter {
	const args = ["--edition", edition, "--config-path", devNull, "--emit", "stdout"]
	return (_fileName, source) =>
		new Promise((resolve) => {
			const child = spawn(rustfmt, args, { stdio: ["pipe", "pipe", "pipe"] })
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
				const failure = stderr.trim() || `${rustfmt} exited with status ${String(status)}`
				resolve(status === 0 ? { code: stdout, errors: [] } : { code: source, errors: [failure] })
			})
			child.stdin.on("error", () => {
				/* a rustfmt that never started or stopped reading: its spawn error or exit status answers */
			})
			child.stdin.end(source)
		})
}
