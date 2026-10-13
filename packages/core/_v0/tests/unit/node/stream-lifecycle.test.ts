import http from "node:http"
import net from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { serve, type HoneyServer } from "../../../src/node.ts"

/**
 * The Node adapter's side of streaming: what is buffered, what is piped, and what ends a
 * producer — disconnect, HEAD, shutdown — with the request objects behaving like Fetch ones.
 */

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let server: HoneyServer | null = null
afterEach(async () => {
	server?.closeAllConnections()
	await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
	server = null
})

function listen(app: ReturnType<typeof honey>): Promise<number> {
	const s = serve(app as never, { env: {}, port: 0 })
	server = s
	return new Promise((resolve) => {
		s.once("listening", () => resolve((s.address() as { port: number }).port))
	})
}

function get(
	port: number,
	path: string,
	method = "GET",
): Promise<{ body: string; headers: http.IncomingHttpHeaders; status: number }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", method, path, port }, (res) => {
			let body = ""
			res.on("data", (c) => {
				body += c
			})
			res.on("end", () => resolve({ body, headers: res.headers, status: res.statusCode ?? 0 }))
		})
		req.on("error", reject)
		req.end()
	})
}

describe("Node adapter streaming", () => {
	it("a text/plain generate() streams its first chunk instead of buffering the whole body", async () => {
		const app = honey()
		app.get("/gen").handler((ctx) => {
			async function* slow() {
				yield "first\n"
				await tick(1_500)
				yield "second\n"
			}
			return ctx.res.generate(slow(), { contentType: "text/plain" })
		})
		const port = await listen(app)
		const started = Date.now()
		const first = await new Promise<number>((resolve, reject) => {
			const req = http.get({ hostname: "127.0.0.1", path: "/gen", port }, (res) => {
				res.once("data", () => {
					resolve(Date.now() - started)
					req.destroy()
				})
			})
			req.on("error", () => {})
			req.on("close", () => reject(new Error("closed before data")))
		})
		expect(first).toBeLessThan(800)
	})

	it("HEAD keeps the GET content-length", async () => {
		const app = honey()
		app.get("/doc").handler((ctx) => ctx.res.text("ok", "hello world"))
		const port = await listen(app)
		const getRes = await get(port, "/doc")
		const headRes = await get(port, "/doc", "HEAD")
		expect(getRes.headers["content-length"]).toBe("11")
		expect(headRes.headers["content-length"]).toBe("11")
		expect(headRes.body).toBe("")
	})

	it("a disconnect after the body was read still aborts ctx.signal (POST → SSE)", async () => {
		const app = honey()
		let aborted = false
		let finished = false
		app.post("/chat").handler(async (ctx) => {
			await ctx.req.text()
			ctx.signal.addEventListener("abort", () => {
				aborted = true
			})
			return ctx.res.sse(async (stream) => {
				try {
					while (!stream.signal.aborted) {
						await stream.send({ data: "token", event: "t" })
						await tick(5)
					}
				} finally {
					finished = true
				}
			})
		})
		const port = await listen(app)
		await new Promise<void>((resolve) => {
			const socket = net.connect(port, "127.0.0.1")
			socket.on("error", () => {})
			socket.on("data", () => {
				socket.resetAndDestroy()
				resolve()
			})
			socket.write("POST /chat HTTP/1.1\r\nHost: h\r\nContent-Length: 2\r\n\r\nhi")
		})
		for (let i = 0; i < 50 && !(aborted && finished); i++) await tick(20)
		expect(aborted).toBe(true)
		expect(finished).toBe(true)
	})

	it("the README pattern (defaultRetry, close() in finally) survives a client that disconnects", async () => {
		const app = honey()
		let finished = false
		app.get("/events").handler((ctx) =>
			ctx.res.sse(
				async (s) => {
					try {
						for (;;) {
							await s.send({ data: "x", event: "t" })
							await tick(2)
						}
					} finally {
						s.close()
						finished = true
					}
				},
				{ defaultRetry: 3_000, keepalive: 5 },
			),
		)
		const port = await listen(app)
		for (let n = 0; n < 5; n++) {
			await new Promise<void>((resolve) => {
				const socket = net.connect(port, "127.0.0.1")
				socket.on("error", () => {})
				socket.on("data", () => {
					socket.resetAndDestroy()
					resolve()
				})
				socket.write("GET /events HTTP/1.1\r\nHost: h\r\n\r\n")
			})
		}
		for (let i = 0; i < 50 && !finished; i++) await tick(20)
		/* vitest fails the run on any unhandled rejection; reaching here means none surfaced */
		expect(finished).toBe(true)
	})

	it("shutdown ends open streams at once and resolves without waiting out the timeout", async () => {
		const app = honey()
		let finished = false
		app.get("/events").handler((ctx) =>
			ctx.res.sse(
				async (s) => {
					try {
						while (!s.signal.aborted) {
							await s.send({ data: "x", event: "t" })
							await tick(10)
						}
					} finally {
						finished = true
					}
				},
				{ keepalive: 20 },
			),
		)
		const port = await listen(app)
		await new Promise<void>((resolve) => {
			const req = http.get({ hostname: "127.0.0.1", path: "/events", port }, (res) => {
				res.once("data", () => resolve())
				res.on("error", () => {})
			})
			req.on("error", () => {})
		})
		const started = Date.now()
		await server?.shutdown(5_000)
		expect(Date.now() - started).toBeLessThan(1_000)
		/* the producer sees its signal on its next step */
		for (let i = 0; i < 25 && !finished; i++) await tick(10)
		expect(finished).toBe(true)
		server = null
	})

	it("shutdown aborts the signal of a handler that outlives the timeout", async () => {
		const app = honey()
		let reason: unknown
		app.get("/work").handler(async (ctx) => {
			await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve()))
			reason = ctx.signal.reason
			return ctx.res.text("ok", "stopped")
		})
		const port = await listen(app)
		const pending = get(port, "/work").catch(() => null)
		await tick(50)
		await server?.shutdown(100)
		await pending
		expect(reason).toMatchObject({ name: "AbortError" })
		server = null
	})

	it("an idle keep-alive client does not hold shutdown open", async () => {
		const app = honey()
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const port = await listen(app)
		const agent = new http.Agent({ keepAlive: true })
		await new Promise<void>((resolve, reject) => {
			http
				.get({ agent, hostname: "127.0.0.1", path: "/x", port }, (res) => {
					res.resume()
					res.on("end", () => resolve())
				})
				.on("error", reject)
		})
		const started = Date.now()
		await server?.shutdown()
		expect(Date.now() - started).toBeLessThan(1_000)
		agent.destroy()
		server = null
	})
})

describe("NodeRequest behaves like a Fetch Request", () => {
	it("clone() leaves the original readable (curlLogger-style body logging)", async () => {
		const app = honey()
		app
			.use(async (ctx, next) => {
				const logged = await ctx.req.clone().text()
				const res = await next()
				res.headers.set("x-logged", logged)
				return res
			})
			.post("/echo")
			.handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
		const port = await listen(app)
		const res = await new Promise<{ body: string; logged: string | undefined }>((resolve, reject) => {
			const req = http.request({ hostname: "127.0.0.1", method: "POST", path: "/echo", port }, (r) => {
				let body = ""
				r.on("data", (c) => {
					body += c
				})
				r.on("end", () => resolve({ body, logged: r.headers["x-logged"] as string | undefined }))
			})
			req.on("error", reject)
			req.end("payload")
		})
		expect(res.body).toBe("payload")
		expect(res.logged).toBe("payload")
	})

	it("a second read throws, and an empty JSON body is a SyntaxError", async () => {
		const app = honey()
		const errors: string[] = []
		app.post("/twice").handler(async (ctx) => {
			await ctx.req.text()
			await ctx.req.text().catch((e: Error) => errors.push(e.name))
			return ctx.res.text("ok", "ok")
		})
		app.post("/empty").handler(async (ctx) => {
			await ctx.req.json().catch((e: Error) => errors.push(e.name))
			return ctx.res.text("ok", "ok")
		})
		const port = await listen(app)
		for (const path of ["/twice", "/empty"]) {
			await new Promise<void>((resolve, reject) => {
				const req = http.request({ hostname: "127.0.0.1", method: "POST", path, port }, (r) => {
					r.resume()
					r.on("end", () => resolve())
				})
				req.on("error", reject)
				req.end(path === "/twice" ? "x" : "")
			})
		}
		expect(errors).toEqual(["TypeError", "SyntaxError"])
	})
})
