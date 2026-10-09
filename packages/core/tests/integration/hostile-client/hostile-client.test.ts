import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"

/**
 * A hostile or broken client must never take the server down. Per runtime: resets in the middle
 * of an upgrade, non-WebSocket upgrades, early disconnects, oversized frames, and route callbacks
 * that throw. After each, the process still serves `/health`.
 */

const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url))

const RUNTIMES: Record<string, string[]> = {
	bun: ["bun", SERVER],
	deno: ["deno", "run", "-A", SERVER],
	node: ["node", SERVER],
}
/* a Node without `shouldUpgradeCallback` (22.12 has none) takes the 'upgrade' fallback path */
const legacyNode = process.env.HONEY_TEST_NODE_LEGACY
if (legacyNode) RUNTIMES["node-legacy"] = [legacyNode, "--experimental-strip-types", "--no-warnings", SERVER]

function available(cmd: string): boolean {
	return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0
}

/** Write `raw`, wait `ms`, then reset the connection. */
function writeThenReset(port: number, raw: string, ms: number): Promise<void> {
	return new Promise((resolve) => {
		const socket = net.connect(port, "127.0.0.1")
		socket.on("error", () => {})
		socket.write(raw)
		setTimeout(() => {
			socket.resetAndDestroy()
			resolve()
		}, ms)
	})
}

/** Write `raw` and collect what comes back until the server closes, or `ms` passes. */
function exchange(port: number, raw: string, ms = 3_000, until?: (got: string) => boolean): Promise<string> {
	return new Promise((resolve) => {
		const socket = net.connect(port, "127.0.0.1")
		let got = ""
		const done = (): void => {
			clearTimeout(timer)
			socket.destroy()
			resolve(got)
		}
		const timer = setTimeout(done, ms)
		socket.on("data", (d) => {
			got += d.toString("latin1")
			if (until?.(got)) done()
		})
		socket.on("error", done)
		socket.on("close", done)
		socket.write(raw)
	})
}

async function alive(port: number): Promise<void> {
	const raw = await exchange(port, "GET /health HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
	expect(raw.slice(0, 12)).toBe("HTTP/1.1 200")
}

type State = { closed: number; errors: number; opened: number; sseFinished: number; sseStarted: number }

async function state(port: number): Promise<State> {
	const res = await fetch(`http://127.0.0.1:${port}/state`)
	return (await res.json()) as State
}

type Outcome = { closeCode: number; closeReason: string; messages: string[]; opened: boolean; status?: number }

/** Open a socket, run `act` once it is open, and resolve with what happened by close (or `ms`). */
function wsSession(
	url: string,
	opts: { headers?: Record<string, string>; ms?: number; act?: (ws: WebSocket) => void } = {},
): Promise<Outcome> {
	return new Promise((resolve) => {
		const out: Outcome = { closeCode: 0, closeReason: "", messages: [], opened: false }
		const ws = new WebSocket(url, { headers: opts.headers })
		const timer = setTimeout(() => {
			ws.terminate()
			resolve(out)
		}, opts.ms ?? 3_000)
		ws.on("unexpected-response", (_req, res) => {
			out.status = res.statusCode
			res.resume()
		})
		ws.on("error", () => {})
		ws.on("open", () => {
			out.opened = true
			opts.act?.(ws)
		})
		ws.on("message", (data) => out.messages.push(String(data)))
		ws.on("close", (code, reason) => {
			clearTimeout(timer)
			out.closeCode = code
			out.closeReason = reason.toString()
			resolve(out)
		})
	})
}

for (const [name, argv] of Object.entries(RUNTIMES)) {
	describe.skipIf(!available(argv[0]))(`hostile clients — ${name}`, () => {
		let child: ChildProcess
		let port = 0
		let exited: number | null = null

		beforeAll(async () => {
			child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] })
			child.once("exit", (code) => {
				exited = code ?? -1
			})
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

		it("a reset while the app awaits an Upgrade request does not crash", async () => {
			await writeThenReset(port, "GET /slow HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n", 10)
			await writeThenReset(
				port,
				"GET /ws HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
					"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
				10,
			)
			await new Promise((r) => setTimeout(r, 150))
			expect(exited).toBeNull()
			await alive(port)
		})

		it("a non-WebSocket upgrade is served as a normal request, body and headers intact", async () => {
			const raw = await exchange(
				port,
				"POST /echo HTTP/1.1\r\nHost: h\r\nConnection: Upgrade, close\r\nUpgrade: h2c\r\n" +
					"Content-Type: text/plain\r\nContent-Length: 5\r\n\r\nhello",
			)
			if (name === "deno") {
				/* Deno's HTTP server refuses an h2c upgrade itself, before the app sees it */
				expect(raw.slice(0, 12)).toBe("HTTP/1.1 400")
			} else {
				expect(raw.slice(0, 15)).toBe("HTTP/1.1 200 OK")
				expect(raw.toLowerCase()).toContain("content-type: text/plain")
				expect(raw.endsWith("hello")).toBe(true)
			}
			await alive(port)
		})

		it("an SSE route reached with an Upgrade header streams, and its producer stops on disconnect", async () => {
			const before = await state(port)
			const raw = await exchange(
				port,
				"GET /events HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n",
				2_000,
				(got) => got.includes("event: tick"),
			)
			expect(raw.slice(0, 12)).toBe("HTTP/1.1 200")
			expect(raw).toContain("event: tick")
			const deadline = Date.now() + 1_000
			let after = await state(port)
			while (after.sseFinished <= before.sseFinished && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 20))
				after = await state(port)
			}
			expect(after.sseStarted).toBe(before.sseStarted + 1)
			expect(after.sseFinished).toBe(before.sseFinished + 1)
		})

		it("throwing route callbacks never reach the runtime, and the queue keeps going", async () => {
			const out = await wsSession(`ws://127.0.0.1:${port}/ws`, {
				act(ws) {
					ws.send("reject")
					ws.send("sync-throw")
					ws.send("after")
					setTimeout(() => ws.close(4000, "bye"), 100)
				},
			})
			expect(out.opened).toBe(true)
			expect(out.messages).toEqual(["ready", "echo:after"])
			await alive(port)
			const thrown = await wsSession(`ws://127.0.0.1:${port}/ws?throw=open`, {
				act(ws) {
					ws.send("still")
					setTimeout(() => ws.close(1000), 100)
				},
			})
			/* the socket became a WebSocket and stayed one: no HTTP 500 written onto it */
			expect(thrown.opened).toBe(true)
			expect(thrown.messages).toEqual(["echo:still"])
			expect(exited).toBeNull()
			await alive(port)
		})

		it("a close reason longer than a frame allows is cut to fit", async () => {
			const out = await wsSession(`ws://127.0.0.1:${port}/ws`, { act: (ws) => ws.send("close-long") })
			expect(out.closeCode).toBe(1000)
			expect(Buffer.byteLength(out.closeReason)).toBeLessThanOrEqual(123)
			await alive(port)
		})

		it("an oversized frame closes the connection with 1009", async () => {
			const out = await wsSession(`ws://127.0.0.1:${port}/ws`, {
				act: (ws) => ws.send(Buffer.alloc(2 * 1024 * 1024 + 1)),
			})
			/* Bun drops the connection without a close frame (1006) when maxPayloadLength is exceeded */
			expect(out.closeCode).toBe(name === "bun" ? 1006 : 1009)
			await alive(port)
		})

		it("a reset right after the handshake leaves the server serving", async () => {
			await new Promise<void>((resolve) => {
				const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
				ws.on("error", () => {})
				ws.on("open", () => {
					ws.terminate()
					resolve()
				})
			})
			await new Promise((r) => setTimeout(r, 100))
			expect(exited).toBeNull()
			await alive(port)
		})

		it("a cross-origin upgrade carrying cookies is refused before the handler runs", async () => {
			const before = await state(port)
			const out = await wsSession(`ws://127.0.0.1:${port}/cross`, {
				headers: { cookie: "sid=1", origin: "https://evil.example" },
				ms: 1_500,
			})
			/* Node and Bun answer 403; Deno has already sent the 101 (preUpgrade) and closes with 1008 */
			if (out.opened) expect(out.closeCode).toBe(1008)
			else expect(out.status).toBe(403)
			expect((await state(port)).opened).toBe(before.opened)

			const same = await wsSession(`ws://127.0.0.1:${port}/cross`, {
				act: (ws) => ws.close(1000),
				headers: { cookie: "sid=1", origin: `http://127.0.0.1:${port}` },
			})
			expect(same.opened).toBe(true)

			const listed = await wsSession(`ws://127.0.0.1:${port}/partner`, {
				act: (ws) => setTimeout(() => ws.close(1000), 50),
				headers: { origin: "https://partner.example" },
			})
			expect(listed.messages).toEqual(["ready"])
			const unlisted = await wsSession(`ws://127.0.0.1:${port}/partner`, {
				headers: { origin: "https://other.example" },
				ms: 1_500,
			})
			expect(unlisted.messages).toEqual([])
		})
	})
}
