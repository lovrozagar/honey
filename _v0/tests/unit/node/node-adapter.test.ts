import http from "node:http"
import net from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"
import { createMiddleware, honey, toFetchRequest } from "../../../src/index.ts"
import { type HoneyServer, serve } from "../../../src/node.ts"
import { startHoneyServer } from "../../../src/serve.ts"
import { nodeWebSocket } from "../../../src/ws/node.ts"

let server: HoneyServer | null = null
afterEach(async () => {
	await server?.shutdown(200)
	server = null
})

function listen(app: ReturnType<typeof honey<{}>>, opts: Partial<Parameters<typeof serve>[1]> = {}): Promise<number> {
	const s = serve(app as never, { env: {}, hostname: "127.0.0.1", port: 0, ...opts })
	server = s
	return new Promise((resolve) => {
		s.once("listening", () => resolve((s.address() as { port: number }).port))
	})
}

/** Raw request text; collect until the server closes or `ms` passes. */
function raw(port: number, text: string, ms = 2_000): Promise<string> {
	return new Promise((resolve) => {
		const s = net.connect(port, "127.0.0.1")
		let got = ""
		const done = () => {
			clearTimeout(t)
			s.destroy()
			resolve(got)
		}
		const t = setTimeout(done, ms)
		s.on("data", (d) => {
			got += d.toString("latin1")
		})
		s.on("error", done)
		s.on("close", done)
		s.write(text)
	})
}

describe("Node adapter: responses", () => {
	it("keeps a native Response's statusText", async () => {
		const app = honey<{}>()
		app.get("/teapot").handler(() => new Response("short and stout", { status: 418, statusText: "Teapot Time" }))
		const port = await listen(app)
		const res = await raw(port, "GET /teapot HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
		expect(res.slice(0, res.indexOf("\r\n"))).toBe("HTTP/1.1 418 Teapot Time")
	})

	it("drops hop-by-hop headers, and the ones Connection names, from a native Response", async () => {
		const app = honey<{}>()
		app.get("/hop").handler(
			() =>
				new Response("x", {
					headers: { connection: "x-hop", "keep-alive": "timeout=999", "x-end": "1", "x-hop": "secret" },
				}),
		)
		const port = await listen(app)
		const res = (await raw(port, "GET /hop HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")).toLowerCase()
		expect(res).toContain("x-end: 1")
		expect(res).not.toContain("x-hop")
		expect(res).not.toContain("timeout=999")
	})

	it("never trusts a stream's declared length: chunks it, and keep-alive stays in sync", async () => {
		const app = honey<{}>()
		app.get("/lying").handler(() => {
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					c.enqueue(new TextEncoder().encode("hello"))
					c.close()
				},
			})
			return new Response(body, { headers: { "content-length": "999" } })
		})
		app.get("/next").handler((ctx) => ctx.res.text("ok", "second"))
		const port = await listen(app)
		const res = await raw(
			port,
			"GET /lying HTTP/1.1\r\nHost: h\r\n\r\nGET /next HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
		)
		expect(res.toLowerCase()).not.toContain("content-length: 999")
		expect(res).toContain("hello")
		/* the second response on the same connection parses: no leftover or missing bytes */
		expect(res).toMatch(/HTTP\/1\.1 200 OK[\s\S]*HTTP\/1\.1 200 OK[\s\S]*second$/)
	})

	it("logs an error the app could not answer, then sends 500", async () => {
		const app = honey<{}>()
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const onError = vi.fn()
		const port = await listen(app, { onError })
		const original = app.fetch.bind(app)
		;(app as { fetch: unknown }).fetch = () => {
			throw new Error("adapter-level failure")
		}
		const res = await raw(port, "GET /x HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
		;(app as { fetch: unknown }).fetch = original
		expect(res.slice(0, 12)).toBe("HTTP/1.1 500")
		expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "adapter-level failure" }))
	})
})

describe("Node adapter: request body cap", () => {
	it("answers 413 for a declared length over maxRequestBodySize, and closes the connection", async () => {
		const app = honey<{}>()
		app.post("/up").handler(async (ctx) => ctx.res.text("ok", String((await ctx.req.text()).length)))
		const port = await listen(app, { maxRequestBodySize: 1024 })
		const res = await raw(port, `POST /up HTTP/1.1\r\nHost: h\r\nContent-Length: 2048\r\n\r\n${"a".repeat(2048)}`)
		expect(res.slice(0, 12)).toBe("HTTP/1.1 413")
		expect(res.toLowerCase()).toContain("connection: close")
	})

	it("answers 413 for a chunked body that grows over the cap", async () => {
		const app = honey<{}>()
		app.post("/up").handler(async (ctx) => ctx.res.text("ok", String((await ctx.req.text()).length)))
		const port = await listen(app, { maxRequestBodySize: 1024 })
		const chunk = "a".repeat(600)
		const body = `258\r\n${chunk}\r\n258\r\n${chunk}\r\n0\r\n\r\n`
		const res = await raw(port, `POST /up HTTP/1.1\r\nHost: h\r\nTransfer-Encoding: chunked\r\n\r\n${body}`)
		expect(res.slice(0, 12)).toBe("HTTP/1.1 413")
	})

	it("reads a body under the cap, through text() and through the stream", async () => {
		const app = honey<{}>()
		app.post("/text").handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
		app.post("/stream").handler(async (ctx) => ctx.res.text("ok", await new Response(ctx.req.body).text()))
		const port = await listen(app, { maxRequestBodySize: 1024 })
		for (const path of ["/text", "/stream"]) {
			const res = await raw(
				port,
				`POST ${path} HTTP/1.1\r\nHost: h\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello`,
			)
			expect(res.slice(0, 12)).toBe("HTTP/1.1 200")
			expect(res.endsWith("hello")).toBe(true)
		}
	})
})

describe("Node adapter: the Request view", () => {
	it("reports every value of a repeated header, the same before and after iteration", async () => {
		const app = honey<{}>()
		app.get("/h").handler((ctx) => {
			const before = ctx.req.headers.get("authorization")
			const all = [...ctx.req.headers].filter(([k]) => k === "authorization").length
			const after = ctx.req.headers.get("authorization")
			return ctx.res.json("ok", { after, all, before })
		})
		const port = await listen(app)
		const res = await raw(
			port,
			"GET /h HTTP/1.1\r\nHost: h\r\nAuthorization: Bearer a\r\nAuthorization: Bearer b\r\nConnection: close\r\n\r\n",
		)
		const body = JSON.parse(res.slice(res.indexOf("{"))) as { after: string; before: string }
		expect(body.before).toBe("Bearer a, Bearer b")
		expect(body.after).toBe(body.before)
	})

	it("toFetchRequest() gives a Request that new Request() and fetch() accept", async () => {
		const upstream = http.createServer((req, res) => {
			let body = ""
			req.on("data", (c) => {
				body += c
			})
			req.on("end", () => res.end(`${req.method} ${req.headers["x-from"]} ${body}`))
		})
		await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()))
		const upPort = (upstream.address() as { port: number }).port
		const app = honey<{}>()
		app.post("/relay").handler(async (ctx) => {
			const real = toFetchRequest(ctx.req)
			const copy = new Request(`http://127.0.0.1:${upPort}/`, real)
			const res = await fetch(copy)
			return ctx.res.text("ok", `${real instanceof Request} ${await res.text()}`)
		})
		const port = await listen(app)
		const res = await raw(
			port,
			"POST /relay HTTP/1.1\r\nHost: h\r\nX-From: node\r\nContent-Length: 4\r\nConnection: close\r\n\r\nping",
		)
		upstream.close()
		expect(res.endsWith("true POST node ping")).toBe(true)
	})
})

describe("Node adapter: upgrades", () => {
	it("an upgrade the middleware rejects is a real response: status text and every header kept", async () => {
		const deny = createMiddleware(async (ctx) => {
			const res = new Response("no", { status: 401, statusText: "Unauthorized" })
			res.headers.set("www-authenticate", 'Bearer realm="ws"')
			res.headers.append("set-cookie", "a=1")
			res.headers.append("set-cookie", "b=2")
			void ctx
			return res
		})
		const app = honey<{}>().wsAdapter(nodeWebSocket())
		app.ws("/ws").use(deny).handler({})
		const port = await listen(app)
		const res = await raw(
			port,
			"GET /ws HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
				"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
		)
		expect(res.slice(0, res.indexOf("\r\n"))).toBe("HTTP/1.1 401 Unauthorized")
		expect(res.toLowerCase()).toContain('www-authenticate: bearer realm="ws"')
		expect(res).toContain("set-cookie: a=1")
		expect(res).toContain("set-cookie: b=2")
		/* a native Response body of unknown length is streamed (chunked) */
		expect(res).toContain("\r\n\r\n2\r\nno\r\n0\r\n\r\n")
	})

	it("an upgrade that hangs past upgradeTimeout is cut", async () => {
		const never = createMiddleware(() => new Promise<Response>(() => {}))
		const app = honey<{}>().wsAdapter(nodeWebSocket())
		app.ws("/ws").use(never).handler({})
		const port = await listen(app, { upgradeTimeout: 100 })
		const started = Date.now()
		await raw(
			port,
			"GET /ws HTTP/1.1\r\nHost: h\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n" +
				"Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
			3_000,
		)
		expect(Date.now() - started).toBeLessThan(1_500)
	})

	it("shutdown closes open WebSockets with 1001", async () => {
		const app = honey<{}>().wsAdapter(nodeWebSocket())
		app.ws("/ws").handler({ onOpen: (_c, ws) => ws.send("hi") })
		const port = await listen(app)
		const closed = new Promise<number>((resolve) => {
			const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
			ws.on("message", () => void server?.shutdown(1_000))
			ws.on("close", (code) => resolve(code))
		})
		expect(await closed).toBe(1001)
		server = null
	})
})

describe("serve()", () => {
	it("keeps the adapter the app was given instead of replacing it", async () => {
		const adapter = nodeWebSocket({ keepalive: { interval: 10_000, timeout: 5_000 } })
		const app = honey<Record<string, unknown>>().wsAdapter(adapter)
		app.get("/").handler((ctx) => ctx.res.text("ok", "x"))
		const handle = await startHoneyServer(app, { hostname: "127.0.0.1", port: 0, runtime: "node" })
		try {
			expect((app as unknown as { _graph: { settings: { wsAdapter: unknown } } })._graph.settings.wsAdapter).toBe(
				adapter,
			)
		} finally {
			await handle.close()
		}
	})
})
