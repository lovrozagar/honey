/**
 * WS4–WS8 findings on the Node adapter, frozen as regressions: the 'upgrade' path on a real
 * node:http server. "Does not crash the process" is checked directly: no uncaught exception or
 * unhandled rejection reaches the process while the case runs, and the server still answers.
 */
import type { AddressInfo } from "node:net"
import { connect } from "node:net"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { WebSocket as WsClient } from "ws"
import { type HoneyServer, serve } from "../../src/adapters/node/serve.ts"
import { cors } from "../../src/middleware/cors.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { realtime } from "../../src/realtime/realtime.ts"
import { type Honey, honey } from "../../src/routing/app.ts"

const servers: HoneyServer[] = []
const crashes: unknown[] = []
const crash = (error: unknown) => void crashes.push(error)

beforeEach(() => {
	crashes.length = 0
	process.on("uncaughtException", crash)
	process.on("unhandledRejection", crash)
})

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
	process.off("uncaughtException", crash)
	process.off("unhandledRejection", crash)
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const HANDSHAKE = "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"

/** `app` with GET /alive, served on a free loopback port. */
async function listen(app: Honey<{}>) {
	app.get("/alive").handler((ctx) => ctx.res.text("ok", "alive"))
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	const { port } = server.address() as AddressInfo
	return { base: `http://127.0.0.1:${port}`, port }
}

/** The process took no uncaught failure, and the server still answers. */
async function alive(base: string) {
	const res = await fetch(`${base}/alive`)
	return [crashes, res.status, await res.text()]
}

/** What `read` resolved to, or the name of what it threw. */
async function failure(read: () => Promise<unknown>): Promise<unknown> {
	try {
		return await read()
	} catch (error) {
		return `threw:${(error as Error).name}`
	}
}

/** Every byte the server writes after `bytes`, until it closes or `until` matches, or `ms` pass. */
function raw(port: number, bytes: string, ms: number, until?: RegExp): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1")
		let out = ""
		const done = () => {
			clearTimeout(timer)
			socket.destroy()
			resolve(out)
		}
		const timer = setTimeout(done, ms)
		socket.on("data", (chunk) => {
			out += chunk.toString("latin1")
			if (until?.test(out)) done()
		})
		socket.on("close", done)
		socket.on("error", () => {})
		socket.write(bytes)
	})
}

describe("WS5: a failing upgrade on the Node adapter", () => {
	// regression: C2
	// v0: b63d67f686
	it("C2: a reset upgrade socket while the handler awaits does not crash the process", async () => {
		const slow = createMiddleware(async (_ctx, next) => {
			await sleep(80)
			return next()
		})
		const app = honey<{}>()
		const guarded = app.use(slow)
		guarded.get("/slow").handler((ctx) => ctx.res.text("ok", "slow"))
		guarded.ws("/ws-slow").handler({})
		const { base, port } = await listen(app)
		for (const [path, upgrade] of [
			["/slow", "x"],
			["/ws-slow", "websocket"],
		]) {
			await new Promise<void>((resolve) => {
				const socket = connect(port, "127.0.0.1", () => {
					socket.write(
						`GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: ${upgrade}\r\n${HANDSHAKE}\r\n`,
					)
					setTimeout(() => {
						socket.resetAndDestroy()
						resolve()
					}, 15)
				})
				socket.on("error", () => resolve())
			})
		}
		await sleep(200)
		expect(await alive(base)).toEqual([[], 200, "alive"])
	})

	// regression: NEW (M)
	// v0: 0dee8be5af
	it("a sync throw in onOpen never writes an HTTP 500 onto the upgraded socket", async () => {
		const app = honey<{}>()
		app.ws("/ws-open-sync").handler({
			onOpen: () => {
				throw new Error("open failed")
			},
		})
		const { base, port } = await listen(app)
		const out = await raw(
			port,
			`GET /ws-open-sync HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${HANDSHAKE}\r\n`,
			300,
		)
		const afterHandshake = out.slice(out.indexOf("\r\n\r\n") + 4)
		expect([out.slice(0, 12), afterHandshake.includes("HTTP/1.1"), ...(await alive(base))]).toEqual([
			"HTTP/1.1 101",
			false,
			[],
			200,
			"alive",
		])
	})
})

describe("WS5: what the Node adapter answers an upgrade request with", () => {
	// regression: H5
	// v0: e3e55cc30a
	it("H5: an SSE route reached with `Upgrade: x` streams instead of buffering forever", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "event 0", event: "message" })
				await new Promise((resolve) => stream.signal.addEventListener("abort", resolve, { once: true }))
			}),
		)
		const { port } = await listen(app)
		const out = await raw(
			port,
			"GET /events HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: x\r\n\r\n",
			1500,
			/event 0/,
		)
		expect([out.slice(0, 15), out.includes("data: event 0")]).toEqual(["HTTP/1.1 200 OK", true])
	})

	// regression: H6
	// v0: 9c345a8fc5
	it("H6: a non-WebSocket upgrade keeps the route's status, headers and content type", async () => {
		const app = honey<{}>()
		app.get("/plain").handler((ctx) => ctx.res.text("ok", "hello world", { headers: { "x-custom": "1" } }))
		const { port } = await listen(app)
		const out = await raw(
			port,
			"GET /plain HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: h2c\r\n\r\n",
			800,
		)
		const head = out.slice(0, out.indexOf("\r\n\r\n")).toLowerCase()
		expect([
			out.slice(0, 17),
			head.includes("x-custom: 1"),
			head.includes("content-type: text/plain"),
			out.includes("hello world"),
		]).toEqual(["HTTP/1.1 200 OK\r\n", true, true, true])
	})
})

describe("WS5: the Node adapter keeps the origin policy", () => {
	// regression: H
	// v0: 34d2aef605
	it("H: a cross-origin WebSocket upgrade carrying cookies is refused", async () => {
		const app = honey<{}>()
		let opened = false
		app.ws("/ws-echo").handler({ onOpen: () => void (opened = true) })
		const { port } = await listen(app)
		const status = await new Promise<number>((resolve) => {
			const client = new WsClient(`ws://127.0.0.1:${port}/ws-echo`, {
				headers: { cookie: "sid=victim" },
				origin: "https://evil.example",
			})
			client.on("unexpected-response", (_req, res) => resolve(res.statusCode as number))
			client.on("open", () => resolve(101))
			client.on("error", () => {})
		})
		expect([status, opened]).toEqual([403, false])
	})
})

describe("WS5: the Node request view follows Fetch", () => {
	// regression: WS5 (M)
	// v0: 6a3094bd2a
	it("clone() does not lock, a second read throws, empty json() throws, a repeated header reads the same", async () => {
		const app = honey<{}>()
		app.post("/req-contract").handler(async (ctx) => {
			const clone = ctx.req.clone()
			const first = await ctx.req.text()
			return ctx.res.json("ok", { cloneText: await clone.text(), first, second: await failure(() => ctx.req.text()) })
		})
		app
			.post("/req-empty-json")
			.handler(async (ctx) => ctx.res.json("ok", { result: await failure(() => ctx.req.json()) }))
		app.get("/req-dup-header").handler((ctx) => {
			const before = ctx.req.headers.get("authorization")
			const all = [...ctx.req.headers]
			return ctx.res.json("ok", { after: ctx.req.headers.get("authorization"), before, count: all.length > 0 })
		})
		const { base, port } = await listen(app)
		const contract = await (await fetch(`${base}/req-contract`, { body: "abc", method: "POST" })).json()
		const empty = await (await fetch(`${base}/req-empty-json`, { method: "POST" })).json()
		const out = await raw(
			port,
			"GET /req-dup-header HTTP/1.1\r\nHost: localhost\r\nAuthorization: a\r\nAuthorization: b\r\nConnection: close\r\n\r\n",
			800,
		)
		const dup = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)) as { after: string; before: string }
		expect([contract, empty, dup.after === dup.before]).toEqual([
			{ cloneText: "abc", first: "abc", second: "threw:TypeError" },
			{ result: "threw:SyntaxError" },
			true,
		])
	})
})

describe("WS6: realtime on Node", () => {
	// regression: H1
	// v0: 160a8d5b85
	it("H1: a rejecting realtime message handler does not crash the process", async () => {
		const app = honey<{}>()
		const errors: unknown[] = []
		realtime(app, "/rt-reject", {
			handler: (_ctx, conn) =>
				conn.on("message", async () => {
					throw new Error("rejected")
				}),
			onError: (error) => void errors.push(error),
		})
		const { base, port } = await listen(app)
		await new Promise<void>((resolve) => {
			const client = new WsClient(`ws://127.0.0.1:${port}/rt-reject`)
			client.on("open", () => {
				client.send(JSON.stringify({ data: 1, t: "msg" }))
				setTimeout(() => {
					client.close()
					resolve()
				}, 100)
			})
		})
		expect([errors, ...(await alive(base))]).toEqual([[new Error("rejected")], [], 200, "alive"])
	})
})

describe("WS5: cors in front of a WebSocket route", () => {
	// regression: H29
	// v0: 47af53fc4a
	it("H29: the socket still opens through a chain with cors, and exchanges frames", async () => {
		const app = honey<{}>()
		app
			.use(cors({ origin: "http://app.example" }))
			.ws("/ws-cors")
			.handler({
				onMessage: (_ctx, ws, data) => ws.send(`echo:${String(data)}`),
				onOpen: (_ctx, ws) => ws.send("ready"),
			})
		const { base, port } = await listen(app)
		const messages = await new Promise<string[]>((resolve, reject) => {
			const got: string[] = []
			const client = new WsClient(`ws://127.0.0.1:${port}/ws-cors`, { origin: "http://app.example" })
			client.on("open", () => client.send("hi"))
			client.on("message", (data) => {
				got.push(String(data))
				if (got.length === 2) {
					client.close()
					resolve(got)
				}
			})
			client.on("error", reject)
		})
		expect([messages, ...(await alive(base))]).toEqual([["ready", "echo:hi"], [], 200, "alive"])
	})
})
