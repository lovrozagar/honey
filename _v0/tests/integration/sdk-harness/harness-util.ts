import { readFileSync } from "node:fs"
import { spawn, execSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export const MOCK_SERVER_START_PATH = fileURLToPath(new URL("../../mock-server/start.ts", import.meta.url))

export function loadMockSpec(): Record<string, unknown> {
	const specPath = fileURLToPath(new URL("../../mock-server/spec.json", import.meta.url))
	return JSON.parse(readFileSync(specPath, "utf8")) as Record<string, unknown>
}

export function startMockServerSubprocess(): Promise<{ port: number; kill: () => void }> {
	return new Promise((resolve, reject) => {
		const proc = spawn("bun", [MOCK_SERVER_START_PATH], {
			stdio: ["ignore", "pipe", "pipe"],
		})

		const stderrChunks: Buffer[] = []
		proc.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))

		const timeout = setTimeout(() => {
			proc.kill("SIGTERM")
			reject(
				new Error(
					`Mock server subprocess did not output port within 10s. stderr: ${Buffer.concat(stderrChunks).toString()}`,
				),
			)
		}, 10_000)

		let stdoutBuf = ""
		proc.stdout.on("data", (chunk: Buffer) => {
			stdoutBuf += chunk.toString()
			const newlineIdx = stdoutBuf.indexOf("\n")
			if (newlineIdx === -1) return

			clearTimeout(timeout)
			const line = stdoutBuf.slice(0, newlineIdx).trim()

			let parsed: { port: number }
			try {
				parsed = JSON.parse(line) as { port: number }
			} catch {
				proc.kill("SIGTERM")
				reject(new Error(`Mock server output non-JSON first line: ${JSON.stringify(line)}`))
				return
			}

			if (typeof parsed.port !== "number") {
				proc.kill("SIGTERM")
				reject(new Error(`Mock server JSON missing port field: ${JSON.stringify(line)}`))
				return
			}

			resolve({
				kill: () => {
					proc.kill("SIGTERM")
				},
				port: parsed.port,
			})
		})

		proc.on("error", (err) => {
			clearTimeout(timeout)
			reject(new Error(`Mock server subprocess spawn failed: ${err.message}`))
		})

		proc.on("exit", (code, signal) => {
			clearTimeout(timeout)
			if (code !== 0 && signal !== "SIGTERM") {
				const stderr = Buffer.concat(stderrChunks).toString()
				reject(new Error(`Mock server subprocess exited early with code=${code} signal=${signal}. stderr: ${stderr}`))
			}
		})
	})
}

/* `go` rejects `--version` (exits non-zero), uses `version` subcommand instead.
 * Per-tool invocation map keeps the check accurate without false negatives. */
const VERSION_PROBE: Record<string, string> = {
	go: "go version",
}

export function hasBinary(name: string): boolean {
	const cmd = VERSION_PROBE[name] ?? `${name} --version`
	try {
		execSync(cmd, { stdio: "pipe" })
		return true
	} catch {
		return false
	}
}
