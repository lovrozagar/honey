/**
 * Helpers for the WS4–WS8 regression suite. Everything here reaches `src` by a relative path, so a
 * copy of this directory inside an older checkout tests that checkout's source unchanged.
 */
import { type ChildProcess, spawn } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { connect } from "node:net"

export type Fixture = {
	base: string
	port: number
	proc: ChildProcess
	stderr: () => string
	alive: () => boolean
	stop: () => Promise<void>
}

/** Start `node-fixture.ts` under plain `node` (the real Node adapter). */
export function startFixture(env: Record<string, string> = {}): Promise<Fixture> {
	const proc = spawn(process.execPath, ["--unhandled-rejections=strict", `${import.meta.dirname}/node-fixture.ts`], {
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
	})
	let err = ""
	proc.stderr?.on("data", (c: Buffer) => {
		err += c.toString()
	})
	return new Promise((resolve, reject) => {
		let out = ""
		const timer = setTimeout(() => reject(new Error(`fixture did not start: ${err}`)), 15_000)
		proc.stdout?.on("data", (c: Buffer) => {
			out += c.toString()
			const m = /PORT (\d+)/.exec(out)
			if (m) {
				clearTimeout(timer)
				const port = Number(m[1])
				resolve({
					alive: () => proc.exitCode === null && proc.signalCode === null,
					base: `http://127.0.0.1:${port}`,
					port,
					proc,
					stderr: () => err,
					stop: () =>
						new Promise<void>((done) => {
							if (proc.exitCode !== null || proc.signalCode !== null) return done()
							proc.once("exit", () => done())
							proc.kill("SIGKILL")
						}),
				})
			}
		})
		proc.once("exit", (code) => {
			clearTimeout(timer)
			reject(new Error(`fixture exited (${code}) before listening: ${err}`))
		})
	})
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Send raw bytes and collect whatever comes back until the socket closes or `ms` passes. */
export function rawRequest(port: number, payload: string, ms = 1500): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1")
		let data = ""
		const done = (): void => {
			clearTimeout(timer)
			socket.destroy()
			resolve(data)
		}
		const timer = setTimeout(done, ms)
		socket.on("data", (c) => {
			data += c.toString("latin1")
		})
		socket.on("error", done)
		socket.on("close", done)
		socket.write(payload)
	})
}

/** Like `rawRequest`, but resolves as soon as `until` matches what was received. */
export function rawUntil(port: number, payload: string, until: RegExp, ms = 1500): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1")
		let data = ""
		const done = (): void => {
			clearTimeout(timer)
			socket.destroy()
			resolve(data)
		}
		const timer = setTimeout(done, ms)
		socket.on("data", (c) => {
			data += c.toString("latin1")
			if (until.test(data)) done()
		})
		socket.on("error", done)
		socket.on("close", done)
		socket.write(payload)
	})
}

export async function stateOf(fx: Fixture): Promise<Record<string, unknown>> {
	return (await (await fetch(`${fx.base}/state`)).json()) as Record<string, unknown>
}

/** A plain node:http upstream for the proxy findings. */
export function startUpstream(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ server: Server; url: string }> {
	return new Promise((resolve) => {
		const server = createServer(handler)
		server.listen(0, "127.0.0.1", () => {
			const address = server.address()
			const port = typeof address === "object" && address !== null ? address.port : 0
			resolve({ server, url: `http://127.0.0.1:${port}` })
		})
	})
}
