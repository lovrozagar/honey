/**
 * A real node:http round trip through honey(): what reaches the app from the request target and
 * Host, bodies both ways, what the answer looks like on the wire, keep-alive, the socket peer as
 * ctx.ip, a client that leaves, and many requests at once staying apart.
 */
import type { AddressInfo } from "node:net"
import { connect } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import { type HoneyServer, serve } from "../../src/adapters/node/serve.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

type App = { fetch(request: Request, env: {}): Response | Promise<Response> }

const servers: HoneyServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
})

async function listen(app: App) {
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	const { port } = server.address() as AddressInfo
	return { base: `http://127.0.0.1:${port}`, port }
}

/** Raw bytes in, every byte the server wrote until it closed the connection out. */
function exchange(port: number, bytes: string | Uint8Array): Promise<string> {
	return new Promise((resolve) => {
		const socket = connect(port, "127.0.0.1")
		let out = ""
		socket.on("data", (chunk) => (out += chunk.toString("latin1")))
		socket.on("close", () => resolve(out))
		socket.on("error", () => {})
		socket.write(bytes)
	})
}

const statusLine = (raw: string) => raw.split("\r\n")[0]
const bodyOf = (raw: string) => raw.slice(raw.indexOf("\r\n\r\n") + 4)

/** An app whose every route answers with the URL the app saw. */
function urlApp() {
	const app = honey<{}>()
	app.get("/admin").handler((ctx) => ctx.res.text("ok", `admin ${ctx.req.url}`))
	app.get("/*").handler((ctx) => ctx.res.text("ok", ctx.req.url))
	return app
}

describe("the request target routes the request, never the Host header", () => {
	// v0: 93242cab9d
	it.each([
		["/x?q=1", "app.example", "http://app.example/x?q=1"],
		["/a/../admin", "app.example", "admin http://app.example/admin"],
		["http://other.example/x", "app.example", "http://other.example/x"],
		["/x", "App.Example:80", "http://app.example/x"],
	])("target %j with Host %j: the app sees %j", async (target, host, seen) => {
		const { port } = await listen(urlApp())
		const raw = await exchange(port, `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
		expect([statusLine(raw), bodyOf(raw)]).toEqual(["HTTP/1.1 200 OK", seen])
	})

	it.each([
		["a Host carrying a path", "GET /x HTTP/1.1\r\nHost: h/admin?\r\n\r\n"],
		["a Host that is no address", "GET /x HTTP/1.1\r\nHost: 1.2.3.256\r\n\r\n"],
		["an asterisk-form target", "OPTIONS * HTTP/1.1\r\nHost: h\r\n\r\n"],
		["no Host on HTTP/1.1 (Node's parser)", "GET /x HTTP/1.1\r\n\r\n"],
		["an authority-form target (Node's parser)", "GET h:443 HTTP/1.1\r\nHost: h\r\n\r\n"],
		["a lowercase method (Node's parser)", "get /x HTTP/1.1\r\nHost: h\r\n\r\n"],
	])("%s: 400, and the app never runs", async (_case, bytes) => {
		let ran = false
		const app = honey<{}>()
		app.all("/*").handler((ctx) => {
			ran = true
			return ctx.res.text("ok", "ran")
		})
		const { port } = await listen(app)
		expect([statusLine(await exchange(port, bytes)), ran]).toEqual(["HTTP/1.1 400 Bad Request", false])
	})

	it("raw non-ASCII bytes in the target: 400 from Node's parser", async () => {
		const { port } = await listen(urlApp())
		const bytes = Buffer.concat([
			Buffer.from("GET /"),
			Buffer.from([0xc3, 0xa4]),
			Buffer.from(" HTTP/1.1\r\nHost: h\r\n\r\n"),
		])
		expect(statusLine(await exchange(port, bytes))).toBe("HTTP/1.1 400 Bad Request")
	})
})

/** An app echoing what it reads: text, bytes, or the stream itself. */
function echoApp() {
	const app = honey<{}>()
	app.post("/text").handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
	app
		.post("/stream")
		.handler((ctx) => ctx.res.raw(new Response(ctx.req.body, { headers: { "content-type": "text/plain" } })))
	app.get("/binary").handler((ctx) => ctx.res.raw(new Response(Uint8Array.from([0, 1, 2, 254, 255]))))
	return app
}

describe("bodies, both ways", () => {
	// v0: c4c9cdbbc9
	// v0: 7b97e6801b
	it("a large POST arrives whole, read at once or streamed straight back", async () => {
		const { base } = await listen(echoApp())
		const big = "x".repeat(50_000) + "é".repeat(10_000)
		const [read, streamed] = await Promise.all(
			["/text", "/stream"].map(async (path) => (await fetch(`${base}${path}`, { body: big, method: "POST" })).text()),
		)
		expect([read === big, streamed === big]).toEqual([true, true])
	})

	// v0: 7a10f1fa5b
	it("a binary answer arrives byte for byte", async () => {
		const { base } = await listen(echoApp())
		expect([...new Uint8Array(await (await fetch(`${base}/binary`)).arrayBuffer())]).toEqual([0, 1, 2, 254, 255])
	})

	// v0: d4d03b69ba
	it("OPTIONS and DELETE carry a body like POST", async () => {
		const app = honey<{}>()
		app.options("/x").handler(async (ctx) => ctx.res.text("ok", `options:${await ctx.req.text()}`))
		app.delete("/x").handler(async (ctx) => ctx.res.text("ok", `delete:${await ctx.req.text()}`))
		const { base } = await listen(app)
		const answers = await Promise.all([
			fetch(`${base}/x`, { body: "b", method: "OPTIONS" }).then((res) => res.text()),
			fetch(`${base}/x`, { body: "b", method: "DELETE" }).then((res) => res.text()),
		])
		expect(answers).toEqual(["options:b", "delete:b"])
	})
})

describe("answers on the wire: bodies, redirects and cookies", () => {
	// v0: 50d3c466f1
	// v0: 9f04243156
	// v0: c1b2030271
	// v0: a1380035f9
	it("text, a redirect with cookies, and json with cookies, headers and a custom status", async () => {
		const app = honey<{}>()
		app.get("/text").handler((ctx) => ctx.res.text("ok", "plain"))
		app.get("/go").handler((ctx) => ctx.res.redirect("/there", { cookies: { s: { value: "1" } } }))
		app
			.get("/json")
			.handler((ctx) =>
				ctx.res.json("created", { id: 7 }, { cookies: { a: { value: "1" } }, headers: { "x-trace": "t1" } }),
			)
		const { base } = await listen(app)
		const [text, go, json] = await Promise.all(
			["/text", "/go", "/json"].map((path) => fetch(`${base}${path}`, { redirect: "manual" })),
		)
		expect([
			[text.status, await text.text()],
			[go.status, go.headers.get("location"), go.headers.getSetCookie()],
			[json.status, json.headers.get("x-trace"), json.headers.getSetCookie(), await json.json()],
		]).toEqual([
			[200, "plain"],
			[302, "/there", ["s=1"]],
			[201, "t1", ["a=1"], { id: 7 }],
		])
	})

	// v0: ac6b792ac8
	// v0: 05725011b6
	// v0: b3d973b0b2
	// v0: 69beeb0e0d
	// v0: 2cf4b77ec2
	// v0: afdb9eb301
	it("every cookie is its own Set-Cookie line; other headers stay single", async () => {
		const app = honey<{}>()
		app.get("/").handler((ctx) =>
			ctx.res.text("ok", "x", {
				cookies: { a: { value: "1" }, b: { httpOnly: true, value: "2" } },
				headers: { "x-one": "1" },
			}),
		)
		const { port } = await listen(app)
		const lines = (await exchange(port, "GET / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")).split("\r\n")
		const named = (name: string) => lines.filter((line) => line.toLowerCase().startsWith(`${name}:`))
		expect([named("set-cookie"), named("x-one")]).toEqual([
			["set-cookie: a=1", "set-cookie: b=2; HttpOnly"],
			["x-one: 1"],
		])
	})
})

/** Middleware that sets x-<name> on the answer after next(). */
const tag = (name: string) =>
	createMiddleware(async (_ctx, next) => {
		const res = await next()
		res.headers.set(`x-${name}`, "1")
		return res
	})

describe("answers on the wire: HEAD and middleware", () => {
	// v0: adf3f8f66b
	it("HEAD answers GET's headers and no body", async () => {
		const app = honey<{}>()
		app.get("/").handler((ctx) => ctx.res.json("ok", { a: 1 }))
		const { port } = await listen(app)
		const raw = await exchange(port, "HEAD / HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n")
		expect([statusLine(raw), raw.toLowerCase().includes("content-type: application/json"), bodyOf(raw)]).toEqual([
			"HTTP/1.1 200 OK",
			true,
			"",
		])
	})

	// v0: 0864de0f54
	// v0: 4cffdc3207
	// v0: 6d3883e8c6
	it("headers middleware adds after next() reach the wire, with a sync handler", async () => {
		const app = honey<{}>()
		app
			.use(tag("a"))
			.use(tag("b"))
			.use(tag("c"))
			.get("/")
			.handler((ctx) => ctx.res.text("ok", "sync"))
		const { base } = await listen(app)
		const res = await fetch(base)
		expect([["a", "b", "c"].map((n) => res.headers.get(`x-${n}`)), await res.text()]).toEqual([["1", "1", "1"], "sync"])
	})
})

describe("the connection and the client", () => {
	it("keep-alive: one connection serves requests in turn", async () => {
		const { port } = await listen(urlApp())
		const raw = await exchange(
			port,
			"GET /one HTTP/1.1\r\nHost: h\r\n\r\nGET /two HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n",
		)
		expect([raw.split("HTTP/1.1 200").length - 1, raw.includes("http://h/one"), raw.includes("http://h/two")]).toEqual([
			2,
			true,
			true,
		])
	})

	// v0: 46e39f1757
	it("ctx.ip is the socket peer, an IPv4-mapped address unwrapped", async () => {
		const app = honey<{}>()
		app.get("/").handler((ctx) => ctx.res.json("ok", { ip: ctx.ip }))
		const server = serve(app, { env: {}, hostname: "::", port: 0 })
		servers.push(server)
		await new Promise((resolve) => server.once("listening", resolve))
		const { port } = server.address() as AddressInfo
		expect(await (await fetch(`http://127.0.0.1:${port}/`)).json()).toEqual({ ip: "127.0.0.1" })
	})

	it("ctx.signal aborts when the client leaves mid-request", async () => {
		const reasons: unknown[] = []
		let arrived!: () => void
		const started = new Promise<void>((resolve) => (arrived = resolve))
		const app = honey<{}>()
		app.get("/").handler(
			(ctx) =>
				new Promise((resolve) => {
					ctx.signal.addEventListener("abort", () => {
						reasons.push(ctx.signal.reason)
						resolve(ctx.res.text("ok", "late"))
					})
					arrived()
				}),
		)
		const { port } = await listen(app)
		const socket = connect(port, "127.0.0.1")
		socket.write("GET / HTTP/1.1\r\nHost: h\r\n\r\n")
		await started
		socket.destroy()
		await expect.poll(() => reasons.length).toBe(1)
		expect((reasons[0] as DOMException).name).toBe("AbortError")
	})
})

const errors = defineErrors({ teapot: "bad_request" })

/** Per-request context from middleware, bodies of several kinds, and typed errors, on one app. */
function busyApp() {
	const app = honey<{}>().errorFactory(errors)
	app
		.use(createMiddleware((ctx, next) => next({ requestId: ctx.req.headers.get("x-id") })))
		.post("/echo")
		.handler(async (ctx) => {
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 5))
			const type = ctx.req.headers.get("content-type") ?? ""
			const body = type.includes("json")
				? await ctx.req.json()
				: type.includes("form")
					? Object.fromEntries(await ctx.req.formData())
					: await ctx.req.text()
			return ctx.res.json("ok", { body, id: ctx.requestId })
		})
	app
		.get("/fail")
		.errors("teapot")
		.handler(() => {
			throw errors.teapot()
		})
	return app
}

const kinds = [
	(i: number) => ({ body: JSON.stringify({ i }), expected: { i }, type: "application/json" }),
	(i: number) => ({ body: `a=${i}`, expected: { a: String(i) }, type: "application/x-www-form-urlencoded" }),
	(i: number) => ({ body: `plain ${i}`, expected: `plain ${i}`, type: "text/plain" }),
]

describe("many requests at once stay apart", () => {
	// v0: dd62cd9939
	// v0: a858009b6c
	// v0: cf10d5e0cb
	// v0: 2538cf731f
	// v0: 34107187cc
	// v0: bf19ac5e14
	// v0: ea707a5bf3
	it("100 concurrent requests: each gets its own context, its own body back, and failures their own error", async () => {
		const { base } = await listen(busyApp())
		const answers = await Promise.all(
			Array.from({ length: 100 }, async (_, i) => {
				if (i % 10 === 9) return (await fetch(`${base}/fail`)).status
				const { body, expected, type } = (kinds[i % 3] as (typeof kinds)[number])(i)
				const res = await fetch(`${base}/echo`, {
					body,
					headers: { "content-type": type, "x-id": `r${i}` },
					method: "POST",
				})
				return JSON.stringify(await res.json()) === JSON.stringify({ body: expected, id: `r${i}` })
			}),
		)
		expect(answers).toEqual(Array.from({ length: 100 }, (_, i) => (i % 10 === 9 ? 400 : true)))
	})

	// v0: ff9890ae7d
	it("handler errors one after another leave the server serving", async () => {
		const app = honey<{}>()
		app.get("/boom").handler(() => {
			throw new Error("boom")
		})
		app.get("/ok").handler((ctx) => ctx.res.text("ok", "alive"))
		const { base } = await listen(app)
		const statuses = await Promise.all(Array.from({ length: 10 }, async () => (await fetch(`${base}/boom`)).status))
		expect([statuses, await (await fetch(`${base}/ok`)).text()]).toEqual([Array(10).fill(500), "alive"])
	})
})
