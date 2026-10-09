import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

/**
 * `proxy()` against a real upstream, per runtime: gzip bodies the runtime's fetch decodes,
 * chunked responses with hop-by-hop headers, SSE that outlives the header timeout, redirects,
 * large uploads, bodies on every method, timeouts, and client aborts. Responses are read off a
 * raw keep-alive socket, so a body whose framing headers lie desyncs the next response.
 *
 * WebSocket passthrough needs a destination that answers an upgrade with 101 (a Workers
 * service binding); `fetch()` on Node and Bun cannot, so it is covered by the unit suite.
 */

const SERVER = fileURLToPath(new URL("./server.ts", import.meta.url))

const RUNTIMES: Record<string, string[]> = {
	bun: ["bun", SERVER],
	/* strict: an unhandled rejection in the server is a crash the test sees, never a warning */
	node: ["node", "--unhandled-rejections=strict", SERVER],
}

function available(cmd: string): boolean {
	return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0
}

type Res = { body: Buffer; headers: Record<string, string>; raw: string; status: number }

/** One HTTP/1.1 connection that reads responses by their framing (length, chunked or close). */
class Conn {
	private buf = Buffer.alloc(0)
	private closed = false
	private waiters: Array<() => void> = []
	readonly socket: net.Socket

	constructor(port: number) {
		this.socket = net.connect(port, "127.0.0.1")
		this.socket.on("data", (d: Buffer) => {
			this.buf = Buffer.concat([this.buf, d])
			this.wake()
		})
		this.socket.on("close", () => {
			this.closed = true
			this.wake()
		})
		this.socket.on("error", () => {})
	}

	private wake(): void {
		for (const w of this.waiters.splice(0)) w()
	}

	private async need(check: () => boolean, ms = 5_000): Promise<void> {
		const deadline = Date.now() + ms
		while (!check()) {
			if (this.closed) throw new Error("connection closed")
			if (Date.now() > deadline) throw new Error("timed out reading response")
			await new Promise<void>((r) => {
				this.waiters.push(r)
				setTimeout(r, 50)
			})
		}
	}

	private take(n: number): Buffer {
		const out = this.buf.subarray(0, n)
		this.buf = this.buf.subarray(n)
		return Buffer.from(out)
	}

	async send(head: string, body?: Buffer): Promise<Res> {
		this.socket.write(head)
		if (body) this.socket.write(body)
		let raw: string
		let status: number
		let lines: string[]
		for (;;) {
			await this.need(() => this.buf.indexOf("\r\n\r\n") !== -1)
			raw = this.take(this.buf.indexOf("\r\n\r\n") + 4).toString("latin1")
			lines = raw.split("\r\n")
			status = Number(lines[0].split(" ")[1])
			/* interim responses (100 Continue) precede the real one */
			if (status >= 200 || status === 101) break
		}
		const headers: Record<string, string> = {}
		for (const line of lines.slice(1)) {
			const i = line.indexOf(":")
			if (i === -1) continue
			const k = line.slice(0, i).trim().toLowerCase()
			const v = line.slice(i + 1).trim()
			headers[k] = k in headers ? `${headers[k]}, ${v}` : v
		}
		if (head.startsWith("HEAD ") || status === 204 || status === 304) {
			return { body: Buffer.alloc(0), headers, raw, status }
		}
		if (headers["transfer-encoding"]?.toLowerCase().includes("chunked")) {
			const parts: Buffer[] = []
			for (;;) {
				await this.need(() => this.buf.indexOf("\r\n") !== -1)
				const size = Number.parseInt(this.take(this.buf.indexOf("\r\n") + 2).toString("latin1"), 16)
				if (size === 0) {
					await this.need(() => this.buf.length >= 2)
					this.take(2)
					break
				}
				await this.need(() => this.buf.length >= size + 2)
				parts.push(this.take(size))
				this.take(2)
			}
			return { body: Buffer.concat(parts), headers, raw, status }
		}
		if (headers["content-length"] !== undefined) {
			const n = Number(headers["content-length"])
			await this.need(() => this.buf.length >= n)
			return { body: this.take(n), headers, raw, status }
		}
		await this.need(() => this.closed)
		return { body: this.take(this.buf.length), headers, raw, status }
	}

	close(): void {
		this.socket.destroy()
	}
}

const get = (path: string, extra = ""): string => `GET ${path} HTTP/1.1\r\nHost: app.test\r\n${extra}\r\n`

async function json<T>(port: number, path: string): Promise<T> {
	const c = new Conn(port)
	try {
		return JSON.parse((await c.send(get(path))).body.toString()) as T
	} finally {
		c.close()
	}
}

for (const [name, argv] of Object.entries(RUNTIMES)) {
	describe.skipIf(!available(argv[0]))(`proxy against a real upstream — ${name}`, () => {
		let child: ChildProcess
		let port = 0

		beforeAll(async () => {
			child = spawn(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "inherit"] })
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

		it("a gzip body over 256 KB arrives decoded, framed right, and keep-alive stays in sync", async () => {
			const { length } = await json<{ length: number }>(port, "/expected/large")
			const c = new Conn(port)
			try {
				const res = await c.send(get("/up/gzip-large", "Accept-Encoding: gzip\r\n"))
				expect(res.status).toBe(200)
				expect(res.headers["content-encoding"]).toBeUndefined()
				if (res.headers["content-length"] !== undefined) {
					expect(Number(res.headers["content-length"])).toBe(length)
				}
				expect(res.body.length).toBe(length)
				/* the same socket: a lying content-length would leave bytes behind and break this */
				const next = await c.send(get("/up/gzip-small", "Accept-Encoding: gzip\r\n"))
				expect(next.status).toBe(200)
				expect(next.headers["content-encoding"]).toBeUndefined()
				const items = (JSON.parse(next.body.toString()) as { items: unknown[] }).items
				expect(items).toHaveLength(200)
			} finally {
				c.close()
			}
		})

		it("a chunked upstream: one framing on the wire, hop-by-hop and Connection-named headers dropped", async () => {
			const c = new Conn(port)
			try {
				const res = await c.send(get("/up/chunked"))
				expect(res.status).toBe(200)
				expect(res.body.toString()).toBe("part-0\npart-1\npart-2\npart-3\npart-4\n")
				const framings = [res.headers["content-length"], res.headers["transfer-encoding"]].filter(Boolean)
				expect(framings).toHaveLength(1)
				expect(res.headers["keep-alive"] ?? "").not.toContain("77")
				expect(res.headers["x-hop"]).toBeUndefined()
				expect(res.headers["connection"] ?? "keep-alive").not.toMatch(/x-hop/i)
				expect(res.raw.match(/^set-cookie:/gim)).toHaveLength(2)
				/* still usable */
				expect((await c.send(get("/up/gzip-small"))).status).toBe(200)
			} finally {
				c.close()
			}
		})

		it("SSE keeps streaming past the header timeout", async () => {
			const c = new Conn(port)
			try {
				/* timeout 500 ms covers the headers only; the stream runs 1.3 s */
				const res = await c.send(get("/up/sse"))
				expect(res.status).toBe(200)
				expect(res.body.toString().match(/^data: /gm)).toHaveLength(13)
			} finally {
				c.close()
			}
		})

		it("no response headers within the timeout is a 504", async () => {
			const c = new Conn(port)
			try {
				expect((await c.send(get("/up/hang"))).status).toBe(504)
			} finally {
				c.close()
			}
		})

		it("an upstream that stalls mid-body is cut by the idle timeout", async () => {
			const c = new Conn(port)
			try {
				const started = Date.now()
				const res = await c.send(get("/up/stall")).catch((e: Error) => e)
				/* the body errors: the connection ends or the chunked body is cut short */
				expect(Date.now() - started).toBeLessThan(4_000)
				if (!(res instanceof Error)) expect(res.body.toString()).toBe("first\n")
			} finally {
				c.close()
			}
		})

		it("redirects go back to the client, not followed", async () => {
			const c = new Conn(port)
			try {
				const res = await c.send(get("/up/redirect"))
				expect(res.status).toBe(302)
				expect(res.headers.location).toBe("/elsewhere")
			} finally {
				c.close()
			}
		})

		it("a large upload and a DELETE body reach the upstream intact; Host and Expect are not forwarded", async () => {
			const c = new Conn(port)
			try {
				const big = Buffer.alloc(3 * 1024 * 1024, 7)
				const up = await c.send(
					`POST /up/echo HTTP/1.1\r\nHost: app.test\r\nContent-Type: application/octet-stream\r\nContent-Length: ${big.length}\r\n\r\n`,
					big,
				)
				const seen = JSON.parse(up.body.toString()) as { bodySize: number; headers: Record<string, string> }
				expect(seen.bodySize).toBe(big.length)
				expect(seen.headers.host).not.toBe("app.test")
				expect(seen.headers["x-forwarded-host"]).toBe("app.test")

				const del = Buffer.from(JSON.stringify({ ids: [1, 2, 3] }))
				const res = await c.send(
					`DELETE /up/echo HTTP/1.1\r\nHost: app.test\r\nContent-Type: application/json\r\nContent-Length: ${del.length}\r\n\r\n`,
					del,
				)
				const echoed = JSON.parse(res.body.toString()) as { bodySize: number; method: string }
				expect(echoed).toMatchObject({ bodySize: del.length, method: "DELETE" })

				const propfind = await c.send(
					`PROPFIND /up/echo HTTP/1.1\r\nHost: app.test\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n`,
					Buffer.from("<x/>\n"),
				)
				const pf = JSON.parse(propfind.body.toString()) as {
					bodySize: number
					headers: Record<string, string>
					method: string
				}
				expect(pf).toMatchObject({ bodySize: 5, method: "PROPFIND" })
				expect(pf.headers.expect).toBeUndefined()
			} finally {
				c.close()
			}
		})

		it("client forwarding headers are replaced; hop-by-hop request headers are dropped", async () => {
			const c = new Conn(port)
			try {
				const res = await c.send(
					get(
						"/up/echo",
						"X-Forwarded-For: 6.6.6.6\r\nForwarded: for=6.6.6.6\r\nX-Real-IP: 6.6.6.6\r\n" +
							"Connection: keep-alive, x-secret\r\nX-Secret: 1\r\nUpgrade: h2c\r\nProxy-Authorization: Basic x\r\n",
					),
				)
				expect(res.status).toBe(200)
				const seen = JSON.parse(res.body.toString()) as { headers: Record<string, string> }
				expect(seen.headers["x-forwarded-for"]).toBe("127.0.0.1")
				expect(seen.headers["x-forwarded-proto"]).toBe("http")
				expect(seen.headers.forwarded).toBeUndefined()
				expect(seen.headers["x-real-ip"]).toBeUndefined()
				expect(seen.headers["x-secret"]).toBeUndefined()
				expect(seen.headers.upgrade).toBeUndefined()
				expect(seen.headers["proxy-authorization"]).toBeUndefined()
			} finally {
				c.close()
			}
		})

		it("a client that disconnects mid-body cancels the upstream", async () => {
			const before = await json<{ abortedStreams: number }>(port, "/state")
			const c = new Conn(port)
			c.socket.write(get("/up/endless"))
			await new Promise((r) => setTimeout(r, 150))
			c.socket.resetAndDestroy()
			const deadline = Date.now() + 2_000
			let after = before
			while (after.abortedStreams === before.abortedStreams && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 50))
				after = await json<{ abortedStreams: number }>(port, "/state")
			}
			expect(after.abortedStreams).toBe(before.abortedStreams + 1)
		})
	})
}
