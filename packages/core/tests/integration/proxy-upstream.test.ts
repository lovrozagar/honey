/**
 * `proxy()` against a real upstream, per runtime: gzip bodies the runtime's fetch decodes,
 * chunked responses with hop-by-hop headers, SSE that outlives the header timeout, redirects,
 * large uploads, bodies on every method, timeouts, and client aborts. Responses are read off a
 * raw keep-alive socket, so a body whose framing headers lie desyncs the next response.
 *
 * WebSocket passthrough needs a destination that answers an upgrade with 101 (a Workers service
 * binding); `fetch()` on Node and Bun cannot, so the unit suite covers it.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import net from "node:net"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

const SERVER = fileURLToPath(new URL("./proxy-upstream/server.ts", import.meta.url))

const RUNTIMES: Record<string, string[]> = {
	bun: ["bun", SERVER],
	/* strict: an unhandled rejection in the server is a crash the test sees, never a warning */
	node: ["node", "--unhandled-rejections=strict", SERVER],
}

function available(cmd: string): boolean {
	return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0
}

type Res = { body: Buffer; headers: Record<string, string>; raw: string; status: number }

/** The status and headers of one response head. */
function parseHead(raw: string): Pick<Res, "headers" | "status"> {
	const lines = raw.split("\r\n")
	const headers: Record<string, string> = {}
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(":")
		if (colon === -1) continue
		const name = line.slice(0, colon).trim().toLowerCase()
		const value = line.slice(colon + 1).trim()
		headers[name] = name in headers ? `${headers[name]}, ${value}` : value
	}
	return { headers, status: Number(lines[0]?.split(" ")[1]) }
}

/** One HTTP/1.1 connection that reads responses by their framing (length, chunked or close). */
class Conn {
	private buf = Buffer.alloc(0)
	private closed = false
	private waiters: Array<() => void> = []
	readonly socket: net.Socket

	constructor(port: number) {
		this.socket = net.connect(port, "127.0.0.1")
		this.socket.on("data", (data: Buffer) => {
			this.buf = Buffer.concat([this.buf, data])
			this.wake()
		})
		this.socket.on("close", () => {
			this.closed = true
			this.wake()
		})
		/* a reset is how some cases end; `need` reports a closed connection itself */
		this.socket.on("error", () => {})
	}

	private wake(): void {
		for (const waiter of this.waiters.splice(0)) waiter()
	}

	private async need(check: () => boolean, ms = 5_000): Promise<void> {
		const deadline = Date.now() + ms
		while (!check()) {
			if (this.closed) throw new Error("connection closed")
			if (Date.now() > deadline) throw new Error("timed out reading response")
			await new Promise<void>((resolve) => {
				this.waiters.push(resolve)
				setTimeout(resolve, 50)
			})
		}
	}

	private take(n: number): Buffer {
		const out = this.buf.subarray(0, n)
		this.buf = this.buf.subarray(n)
		return Buffer.from(out)
	}

	/** The next final response head; interim ones (100 Continue) are skipped. */
	private async head(): Promise<{ raw: string } & Pick<Res, "headers" | "status">> {
		for (;;) {
			await this.need(() => this.buf.includes("\r\n\r\n"))
			const raw = this.take(this.buf.indexOf("\r\n\r\n") + 4).toString("latin1")
			const parsed = parseHead(raw)
			if (parsed.status >= 200 || parsed.status === 101) return { ...parsed, raw }
		}
	}

	private async chunked(): Promise<Buffer> {
		const parts: Buffer[] = []
		for (;;) {
			await this.need(() => this.buf.includes("\r\n"))
			const size = Number.parseInt(this.take(this.buf.indexOf("\r\n") + 2).toString("latin1"), 16)
			if (size === 0) {
				await this.need(() => this.buf.length >= 2)
				this.take(2)
				return Buffer.concat(parts)
			}
			await this.need(() => this.buf.length >= size + 2)
			parts.push(this.take(size))
			this.take(2)
		}
	}

	private async body(head: string, res: Pick<Res, "headers" | "status">): Promise<Buffer> {
		if (head.startsWith("HEAD ") || res.status === 204 || res.status === 304) return Buffer.alloc(0)
		if (res.headers["transfer-encoding"]?.toLowerCase().includes("chunked")) return this.chunked()
		const length = res.headers["content-length"]
		if (length !== undefined) {
			await this.need(() => this.buf.length >= Number(length))
			return this.take(Number(length))
		}
		await this.need(() => this.closed)
		return this.take(this.buf.length)
	}

	async send(head: string, body?: Buffer): Promise<Res> {
		this.socket.write(head)
		if (body) this.socket.write(body)
		const res = await this.head()
		return { ...res, body: await this.body(head, res) }
	}

	close(): void {
		this.socket.destroy()
	}
}

const get = (path: string, extra = ""): string => `GET ${path} HTTP/1.1\r\nHost: app.test\r\n${extra}\r\n`

async function json<T>(port: number, path: string): Promise<T> {
	const conn = new Conn(port)
	try {
		return JSON.parse((await conn.send(get(path))).body.toString()) as T
	} finally {
		conn.close()
	}
}

/** One server per runtime, started on first use and shared by that runtime's describes. */
const fixtures = new Map<string, Promise<{ child: ChildProcess; port: number }>>()

function fixture(name: string): Promise<number> {
	let started = fixtures.get(name)
	if (started === undefined) {
		const argv = RUNTIMES[name] as string[]
		const child = spawn(argv[0] as string, argv.slice(1), { stdio: ["ignore", "pipe", "inherit"] })
		started = new Promise((resolve, reject) => {
			let out = ""
			child.stdout?.on("data", (data: Buffer) => {
				out += data.toString()
				const match = /PORT (\d+)/.exec(out)
				if (match) resolve({ child, port: Number(match[1]) })
			})
			child.once("exit", (code) => reject(new Error(`${name} server exited with ${code}`)))
		})
		fixtures.set(name, started)
	}
	return started.then(({ port }) => port)
}

afterAll(async () => {
	for (const started of fixtures.values()) (await started).child.kill()
})

/** `test` with a connection to `name`'s server, closed after. */
async function withConn<T>(name: string, test: (conn: Conn, port: number) => Promise<T>): Promise<T> {
	const port = await fixture(name)
	const conn = new Conn(port)
	try {
		return await test(conn, port)
	} finally {
		conn.close()
	}
}

for (const name of Object.keys(RUNTIMES)) {
	const skip = !available(RUNTIMES[name]?.[0] as string)

	describe.skipIf(skip)(`proxy against a real upstream, ${name}: framing`, () => {
		// v0: 09fbb6b204
		// v0: 35b511867c
		it("a gzip body over 256 KB arrives decoded, framed right, and keep-alive stays in sync", async () => {
			const { length } = await json<{ length: number }>(await fixture(name), "/expected/large")
			await withConn(name, async (conn) => {
				const large = await conn.send(get("/up/gzip-large", "Accept-Encoding: gzip\r\n"))
				/* the same socket: a lying content-length would leave bytes behind and break this */
				const small = await conn.send(get("/up/gzip-small", "Accept-Encoding: gzip\r\n"))
				const declared = large.headers["content-length"]
				expect([
					large.status,
					large.headers["content-encoding"],
					declared === undefined || Number(declared) === length,
					large.body.length,
					small.status,
					small.headers["content-encoding"],
					(JSON.parse(small.body.toString()) as { items: unknown[] }).items.length,
				]).toEqual([200, undefined, true, length, 200, undefined, 200])
			})
		}, 30_000)

		// v0: 7d15dd4aec
		// v0: 01d6a8af6e
		it("a chunked upstream: one framing on the wire, hop-by-hop and Connection-named headers dropped", async () => {
			await withConn(name, async (conn) => {
				const res = await conn.send(get("/up/chunked"))
				const framings = [res.headers["content-length"], res.headers["transfer-encoding"]].filter(Boolean)
				expect([
					res.status,
					res.body.toString(),
					framings.length,
					(res.headers["keep-alive"] ?? "").includes("77"),
					res.headers["x-hop"],
					/x-hop/i.test(res.headers.connection ?? ""),
					res.raw.match(/^set-cookie:/gim)?.length,
					(await conn.send(get("/up/gzip-small"))).status,
				]).toEqual([200, "part-0\npart-1\npart-2\npart-3\npart-4\n", 1, false, undefined, false, 2, 200])
			})
		}, 30_000)
	})

	describe.skipIf(skip)(`proxy against a real upstream, ${name}: deadlines`, () => {
		// v0: 2670221d49
		it("SSE keeps streaming past the header timeout", async () => {
			/* timeout 500 ms covers the headers only; the stream runs 1.3 s */
			const res = await withConn(name, (conn) => conn.send(get("/up/sse")))
			expect([res.status, res.body.toString().match(/^data: /gm)?.length]).toEqual([200, 13])
		}, 30_000)

		// v0: 639da2521d
		it("no response headers within the timeout is a 504", async () => {
			expect((await withConn(name, (conn) => conn.send(get("/up/hang")))).status).toBe(504)
		}, 30_000)

		// v0: b4b69459c4
		it("an upstream that stalls mid-body is cut by the idle timeout", async () => {
			const started = Date.now()
			const res = await withConn(name, (conn) => conn.send(get("/up/stall")).catch((error: Error) => error))
			/* the body errors: the connection ends or the chunked body is cut short */
			expect([Date.now() - started < 4_000, res instanceof Error || res.body.toString() === "first\n"]).toEqual([
				true,
				true,
			])
		}, 30_000)
	})

	describe.skipIf(skip)(`proxy against a real upstream, ${name}: requests`, () => {
		it("redirects go back to the client, not followed", async () => {
			const res = await withConn(name, (conn) => conn.send(get("/up/redirect")))
			expect([res.status, res.headers.location]).toEqual([302, "/elsewhere"])
		}, 30_000)

		// v0: 57864cc3aa
		// v0: 70c9462e8b
		it("a large upload and a DELETE body reach the upstream intact; Host and Expect are not forwarded", async () => {
			await withConn(name, async (conn) => {
				const big = Buffer.alloc(3 * 1024 * 1024, 7)
				const up = await conn.send(
					`POST /up/echo HTTP/1.1\r\nHost: app.test\r\nContent-Type: application/octet-stream\r\nContent-Length: ${big.length}\r\n\r\n`,
					big,
				)
				const del = Buffer.from(JSON.stringify({ ids: [1, 2, 3] }))
				const removed = await conn.send(
					`DELETE /up/echo HTTP/1.1\r\nHost: app.test\r\nContent-Type: application/json\r\nContent-Length: ${del.length}\r\n\r\n`,
					del,
				)
				const propfind = await conn.send(
					`PROPFIND /up/echo HTTP/1.1\r\nHost: app.test\r\nContent-Length: 5\r\nExpect: 100-continue\r\n\r\n`,
					Buffer.from("<x/>\n"),
				)
				type Seen = { bodySize: number; headers: Record<string, string>; method: string }
				const [a, b, c] = [up, removed, propfind].map((res) => JSON.parse(res.body.toString()) as Seen) as [
					Seen,
					Seen,
					Seen,
				]
				expect([
					a.bodySize,
					a.headers.host === "app.test",
					a.headers["x-forwarded-host"],
					b.bodySize,
					b.method,
					c.bodySize,
					c.method,
					c.headers.expect,
				]).toEqual([big.length, false, "app.test", del.length, "DELETE", 5, "PROPFIND", undefined])
			})
		}, 30_000)
	})

	describe.skipIf(skip)(`proxy against a real upstream, ${name}: what the upstream is told`, () => {
		it("client forwarding headers are replaced; hop-by-hop request headers are dropped", async () => {
			const res = await withConn(name, (conn) =>
				conn.send(
					get(
						"/up/echo",
						"X-Forwarded-For: 6.6.6.6\r\nForwarded: for=6.6.6.6\r\nX-Real-IP: 6.6.6.6\r\n" +
							"Connection: keep-alive, x-secret\r\nX-Secret: 1\r\nUpgrade: h2c\r\nProxy-Authorization: Basic x\r\n",
					),
				),
			)
			const seen = (JSON.parse(res.body.toString()) as { headers: Record<string, string> }).headers
			/* X-Forwarded-For is ctx.ip, the platform peer (H23) */
			expect([
				res.status,
				seen["x-forwarded-for"],
				seen["x-forwarded-proto"],
				seen.forwarded,
				seen["x-real-ip"],
				seen["x-secret"],
				seen.upgrade,
				seen["proxy-authorization"],
			]).toEqual([200, "127.0.0.1", "http", undefined, undefined, undefined, undefined, undefined])
		}, 30_000)

		it("a client that disconnects mid-body cancels the upstream", async () => {
			const port = await fixture(name)
			const before = await json<{ abortedStreams: number }>(port, "/state")
			const conn = new Conn(port)
			conn.socket.write(get("/up/endless"))
			await new Promise((resolve) => setTimeout(resolve, 150))
			conn.socket.resetAndDestroy()
			const deadline = Date.now() + 2_000
			let after = before
			while (after.abortedStreams === before.abortedStreams && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50))
				after = await json<{ abortedStreams: number }>(port, "/state")
			}
			expect(after.abortedStreams).toBe(before.abortedStreams + 1)
		}, 30_000)
	})
}
