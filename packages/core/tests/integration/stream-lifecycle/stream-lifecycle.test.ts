import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * Producer lifecycle per runtime: an endless producer's `finally` runs within a bound after the
 * client disconnects, a HEAD never starts it, `timeout()` aborts `ctx.signal`, and no interval
 * (SSE keepalive) outlives its stream. Drives the real server over raw sockets.
 */

const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url))

const RUNTIMES: Record<string, string[]> = {
	bun: ["bun", SERVER],
	deno: ["deno", "run", "-A", SERVER],
	/* strict: an unhandled rejection in the server is a crash the test sees, never a warning */
	node: ["node", "--unhandled-rejections=strict", SERVER],
}

function available(cmd: string): boolean {
	return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0
}

type State = {
	finished: Record<string, number>
	intervals: number
	signal: Record<string, number>
	started: Record<string, number>
}

/** Send a request, wait for `bytes` of response (headers included), then reset the connection. */
function readThenDrop(port: number, path: string, bytes: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1")
		let got = ""
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`no data from ${path}`))
		}, 5_000)
		socket.on("data", (d) => {
			got += d.toString("latin1")
			if (got.length >= bytes) {
				clearTimeout(timer)
				socket.resetAndDestroy()
				resolve(got)
			}
		})
		socket.on("error", () => {})
		socket.write(`GET ${path} HTTP/1.1\r\nHost: h\r\n\r\n`)
	})
}

/** A full request on a fresh connection; the whole response as text. */
function exchange(port: number, method: string, path: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(port, "127.0.0.1")
		let got = ""
		const timer = setTimeout(() => {
			socket.destroy()
			reject(new Error(`timeout: ${method} ${path}`))
		}, 5_000)
		socket.on("data", (d) => {
			got += d.toString("latin1")
		})
		socket.on("error", reject)
		socket.on("close", () => {
			clearTimeout(timer)
			resolve(got)
		})
		socket.write(`${method} ${path} HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`)
	})
}

async function state(port: number): Promise<State> {
	const raw = await exchange(port, "GET", "/state")
	let body = raw.slice(raw.indexOf("\r\n\r\n") + 4)
	if (/transfer-encoding: chunked/i.test(raw)) {
		const nl = body.indexOf("\r\n")
		body = body.slice(nl + 2, nl + 2 + Number.parseInt(body.slice(0, nl), 16))
	}
	return JSON.parse(body) as State
}

/** Poll `/state` until `check` holds, for at most `bound` ms. */
async function within(port: number, bound: number, check: (s: State) => boolean): Promise<State> {
	const deadline = Date.now() + bound
	let last = await state(port)
	while (!check(last)) {
		if (Date.now() > deadline) return last
		await new Promise((r) => setTimeout(r, 20))
		last = await state(port)
	}
	return last
}

const BOUND = 1_000

for (const [name, argv] of Object.entries(RUNTIMES)) {
	describe.skipIf(!available(argv[0]))(`stream lifecycle — ${name}`, () => {
		let child: ChildProcess
		let port = 0

		beforeAll(async () => {
			child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "ignore"] })
			port = await new Promise<number>((resolve, reject) => {
				let out = ""
				child.stdout?.on("data", (d: Buffer) => {
					out += d.toString()
					const m = /PORT (\d+)/.exec(out)
					if (m) resolve(Number(m[1]))
				})
				child.once("exit", (code) => reject(new Error(`${name} server exited with ${code}`)))
			})
		}, 30_000)

		afterAll(() => {
			child?.kill()
		})

		for (const producer of ["sse", "gen", "stream"]) {
			it(`${producer}: the producer's finally runs after the client disconnects`, async () => {
				const before = await state(port)
				await readThenDrop(port, `/${producer}`, 200)
				const after = await within(
					port,
					BOUND,
					(s) => (s.finished[producer] ?? 0) > (before.finished[producer] ?? 0) && s.intervals === 0,
				)
				expect(after.started[producer]).toBe((before.started[producer] ?? 0) + 1)
				expect(after.finished[producer]).toBe(after.started[producer])
				/* the SSE keepalive interval ended with its stream */
				expect(after.intervals).toBe(0)
			})
		}

		it("HEAD on a streaming route never starts the producer", async () => {
			const before = await state(port)
			const raw = await exchange(port, "HEAD", "/sse")
			expect(raw.slice(0, 12)).toBe("HTTP/1.1 200")
			expect(raw.toLowerCase()).toContain("content-type: text/event-stream")
			/* nothing after the headers */
			expect(raw.slice(raw.indexOf("\r\n\r\n") + 4)).toBe("")
			const after = await state(port)
			expect(after.started.sse ?? 0).toBe(before.started.sse ?? 0)
			expect(after.intervals).toBe(0)
		})

		it("a disconnect aborts ctx.signal while the handler is still working", async () => {
			const before = await state(port)
			await new Promise<void>((resolve) => {
				const socket = net.connect(port, "127.0.0.1")
				socket.on("error", () => {})
				socket.write("GET /wait HTTP/1.1\r\nHost: h\r\n\r\n")
				setTimeout(() => {
					socket.resetAndDestroy()
					resolve()
				}, 100)
			})
			const after = await within(port, BOUND, (s) => (s.signal.wait ?? 0) > (before.signal.wait ?? 0))
			expect(after.signal.wait).toBe((before.signal.wait ?? 0) + 1)
		})

		it("timeout() answers 504 and aborts ctx.signal", async () => {
			const before = await state(port)
			const raw = await exchange(port, "GET", "/slow")
			expect(raw.slice(0, 12)).toBe("HTTP/1.1 504")
			const after = await within(port, BOUND, (s) => (s.signal.slow ?? 0) > (before.signal.slow ?? 0))
			expect(after.signal.slow).toBe((before.signal.slow ?? 0) + 1)
		})
	})
}
