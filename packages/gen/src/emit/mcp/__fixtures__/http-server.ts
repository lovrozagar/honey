/**
 * The emitted server run with `--http` (bit 21 d): its process started from a command, the URL it serves read from the
 * line it writes on stderr once it listens, and stopped by its own PID alone. Node only, so the TS and Python client
 * fixtures both start it without either reaching the other's toolchain.
 */
import { spawn } from "node:child_process"

/** A server listening: its endpoint, everything it wrote on stderr so far, and its stop (SIGTERM), settling with its exit status. */
export type Serving = {
	readonly url: string
	stderr(): string
	stop(): Promise<number | null>
}

/** `command` started; settles once it says where it serves, or rejects with its stderr when it exits before. */
export function serving(command: readonly string[]): Promise<Serving> {
	const [program, ...args] = command as [string, ...string[]]
	const child = spawn(program, args, { stdio: ["ignore", "ignore", "pipe"] })
	let stderr = ""
	const exited = new Promise<number | null>((settle) => child.once("close", settle))
	return new Promise((settle, reject) => {
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
			const url = / on (http:\/\/\S+\/mcp)\n/.exec(stderr)?.[1]
			if (url !== undefined)
				settle({
					stderr: () => stderr,
					stop: () => {
						child.kill()
						return exited
					},
					url,
				})
		})
		child.once("close", (status) => reject(new Error(`the server exited ${status} before it served: ${stderr}`)))
	})
}
