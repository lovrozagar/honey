import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type HoneyServer, serve } from "../adapters/node/serve.ts"
import * as z from "zod"
import { createMiddleware } from "../middleware/middleware.ts"
import { ipRestrict } from "../middleware/ip-restrict.ts"
import { requestId } from "../middleware/request-id.ts"
import { timeout } from "../middleware/timeout.ts"
import { type CurlLogData, curlLogger } from "../observability/curl-logger.ts"
import { honey } from "../routing/app.ts"
import { type BodyLimitOptions, bodyLimit } from "./body-limit.ts"

/** A handler answering with the body's byte length. */
const size = async (ctx: { req: Request; res: { text(key: "ok", body: string): Response } }) =>
	ctx.res.text("ok", String((await ctx.req.arrayBuffer()).byteLength))

/** An app under `bodyLimit(options)` whose routes answer with the body's byte length. */
function limited(options: BodyLimitOptions) {
	const app = honey<{}>().use(bodyLimit(options))
	for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"])
		app.on([method as "POST"], "/x").handler(size as never)
	app.get("/x").handler((ctx) => ctx.res.text("ok", "get"))
	return app
}

/** A request to /x with `body` and `headers`. */
function to(method: string, body: BodyInit | null, headers: Record<string, string> = {}): Request {
	return new Request("http://localhost/x", { body, headers, method })
}

/** The status and text of an answer. */
async function answer(res: Response | Promise<Response>): Promise<[number, string]> {
	const r = await res
	return [r.status, await r.text()]
}

/** A body streamed with no Content-Length, chunk by chunk. */
function streamed(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder()
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
			controller.close()
		},
	})
}

const TOO_LARGE =
	'{"error_key":"content_too_large","fields":{},"message":"content_too_large","status":413,"status_key":"content_too_large","success":false}'

describe("bodyLimit: the body's size, counted in bytes", () => {
	// v0: 9ed1131c01
	// v0: 5ff0d07789
	// v0: c4ff883b76
	// v0: 94fbabc2d8
	// v0: 56c49e8189
	// v0: 1fbd4b82ed
	// v0: 3733c24ddb
	// v0: e8dabb0319
	// v0: 46e4049a4e
	it("passes a body of exactly the limit whole, and answers 413 content_too_large one byte past it", async () => {
		const app = limited({ maxSize: 100 })
		const mega = limited({ maxSize: 1024 * 1024 })
		expect([
			await answer(app.fetch(to("POST", "x".repeat(100)), {})),
			await answer(app.fetch(to("POST", "x".repeat(101)), {})),
			await answer(mega.fetch(to("POST", new Uint8Array(1024 * 1024)), {})),
			(await mega.fetch(to("POST", new Uint8Array(1024 * 1024 + 1)), {})).status,
		]).toEqual([[200, "100"], [413, TOO_LARGE], [200, String(1024 * 1024)], 413])
	})

	// v0: e3de3098c2
	// v0: 358d412ba9
	// v0: bc34668616
	it("counts bytes, not characters: four emoji are 16, three spaces 3; a limit of 0 takes no body at all", async () => {
		const ten = limited({ maxSize: 10 })
		expect([
			(await ten.fetch(to("POST", "🔥🔥🔥🔥", { "content-type": "text/plain" }), {})).status,
			await answer(limited({ maxSize: 5 }).fetch(to("POST", "   ", { "content-type": "text/plain" }), {})),
			(await limited({ maxSize: 0 }).fetch(to("POST", "x"), {})).status,
		]).toEqual([413, [200, "3"], 413])
	})

	// v0: 6caf44ab1b
	// v0: 3d69435f5b
	// v0: 2ced4c72a7
	// v0: c5b1edd82d
	// v0: f518314199
	// v0: c6f1a09125
	// v0: 3ed41ffaeb
	// v0: 7dcc70112c
	it.each([
		["application/json", JSON.stringify({ data: "x".repeat(100) }), JSON.stringify({ n: "t" })],
		["text/plain", "x".repeat(100), "hello world"],
		["application/octet-stream", new Uint8Array(200), new Uint8Array(30)],
	])("a %s body over the limit is a 413; one under it passes", async (type, over, under) => {
		const app = limited({ maxSize: 50 })
		expect([
			await answer(app.fetch(to("POST", over, { "content-type": type }), {})),
			(await app.fetch(to("POST", under, { "content-type": type }), {})).status,
		]).toEqual([[413, TOO_LARGE], 200])
	})
})

describe("bodyLimit: a streamed body, and what reading it may raise", () => {
	// v0: 2ad9c2013e
	// v0: e8fcde46ad
	// v0: 30e8f744b2
	// v0: acccc3f555
	// v0: 92ad81b4ec
	// v0: ab3d027267
	it("an error reading the body passes through as it is, not as an overflow", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 100 }))
		app.post("/x").handler(async (ctx) => {
			const read = await ctx.req.text().then(
				() => "read",
				(error: unknown) => (error as Error).message,
			)
			return ctx.res.text("ok", read)
		})
		const failing = new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error("socket reset")) })
		const req = new Request("http://localhost/x", { body: failing, duplex: "half", method: "POST" } as RequestInit)
		expect(await answer(app.fetch(req, {}))).toEqual([200, "socket reset"])
	})

	it("a handler that cancels the body leaves the rest drained, not left on the socket", async () => {
		let pulled = 0
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled += 1
				if (pulled > 3) return controller.close()
				controller.enqueue(new Uint8Array(10))
			},
		})
		const app = honey<{}>().use(bodyLimit({ maxSize: 1000 }))
		app.post("/x").handler(async (ctx) => {
			await (ctx.req.body as ReadableStream<Uint8Array>).cancel()
			return ctx.res.text("ok", "cancelled")
		})
		const req = new Request("http://localhost/x", { body: source, duplex: "half", method: "POST" } as RequestInit)
		expect(await answer(app.fetch(req, {}))).toEqual([200, "cancelled"])
		await vi.waitFor(() => expect(pulled).toBe(4))
	})

	it("counts a streamed body with no Content-Length as it arrives", async () => {
		const app = limited({ maxSize: 10 })
		const send = (chunks: string[]) =>
			app.fetch(
				new Request("http://localhost/x", { body: streamed(chunks), duplex: "half", method: "POST" } as RequestInit),
				{},
			)
		expect([await answer(send(["short", "body"])), await answer(send(["this is way", " too long"]))]).toEqual([
			[200, "9"],
			[413, TOO_LARGE],
		])
	})
})

describe("bodyLimit: Content-Length", () => {
	// v0: 136ca260d3
	// v0: 893099299f
	// v0: ff67dd2ce3
	// v0: c011c8547c
	// v0: 1f3e4d0b21
	// v0: 52aa92269b
	it("a declared length over the limit is a 413 before anything is read; one at the limit passes", async () => {
		let read = false
		const app = honey<{}>().use(bodyLimit({ maxSize: 5 }))
		app.post("/x").handler(async (ctx) => {
			read = true
			return ctx.res.text("ok", await ctx.req.text())
		})
		const over = await answer(app.fetch(to("POST", "123456", { "content-length": "6" }), {}))
		const wasRead = read
		expect([over, wasRead, await answer(app.fetch(to("POST", "12345", { "content-length": "5" }), {}))]).toEqual([
			[413, TOO_LARGE],
			false,
			[200, "12345"],
		])
	})

	// v0: a4ac13ba34
	// v0: aa7648b733
	// v0: 4e600a3e46
	// v0: d64bac1e58
	it("a lying, negative or malformed declared length is ignored: the bytes are counted", async () => {
		const app = limited({ maxSize: 10 })
		expect([
			(await app.fetch(to("POST", "x".repeat(100), { "content-length": "5" }), {})).status,
			await answer(app.fetch(to("POST", "small", { "content-length": "-5" }), {})),
			await answer(app.fetch(to("POST", "small", { "content-length": "not-a-number" }), {})),
		]).toEqual([413, [200, "5"], [200, "5"]])
	})

	it("trustContentLength takes a declared length within the limit at its word, and counts nothing", async () => {
		const trusting = limited({ maxSize: 10, trustContentLength: true })
		expect([
			await answer(trusting.fetch(to("POST", "x".repeat(100), { "content-length": "5" }), {})),
			(await trusting.fetch(to("POST", "x".repeat(20), { "content-length": "20" }), {})).status,
			(await trusting.fetch(to("POST", "x".repeat(20)), {})).status,
		]).toEqual([[200, "100"], 413, 413])
	})
})

describe("bodyLimit: which requests it limits", () => {
	// v0: 6b361f3c99
	// v0: c3ab81d57d
	// v0: d73b24d770
	// v0: 4e4768094b
	// v0: 3af9d98d6e
	// v0: 122f640e16
	// v0: 76b261e2e5
	it("a request with no body and no declared length passes whatever its method; an app without it takes any body", async () => {
		const app = limited({ maxSize: 0 })
		const open = honey<{}>()
		open.post("/x").handler(async (ctx) => ctx.res.text("ok", String((await ctx.req.text()).length)))
		expect([
			await answer(app.fetch(to("GET", null), {})),
			...(await Promise.all(["OPTIONS", "POST", "DELETE"].map(async (m) => (await app.fetch(to(m, null), {})).status))),
			(await app.fetch(to("POST", null, { "content-type": "application/json" }), {})).status,
			await answer(open.fetch(to("POST", "x".repeat(10_000)), {})),
		]).toEqual([[200, "get"], 200, 200, 200, 200, [200, "10000"]])
	})

	// v0: 625ae89a64
	// v0: 62e4e38c06
	it("every method that carries a body is limited: DELETE, OPTIONS and an extension method alike", async () => {
		const app = limited({ maxSize: 10 })
		const statuses = await Promise.all(
			["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"].map(
				async (m) => (await app.fetch(to(m, "x".repeat(100)), {})).status,
			),
		)
		expect(statuses).toEqual([413, 413, 413, 413, 413, 413])
	})
})

describe("bodyLimit: limits per media type", () => {
	// v0: 5b019221ea
	// v0: 381c4aea1d
	it("matches the parsed essence whatever its case or parameters, then its type's family key; anything else gets maxSize", async () => {
		const app = limited({ limits: { "application/": 1000, "application/json": 10 }, maxSize: 20 })
		const status = async (type: string, size: number) =>
			(await app.fetch(to("POST", "x".repeat(size), type === "" ? {} : { "content-type": type }), {})).status
		expect([
			await status("Application/JSON", 50),
			await status("application/json; charset=utf-8", 50),
			await status(" APPLICATION/json", 50),
			await status("application/xml", 500),
			await status("text/plain", 50),
			await status("not a media type", 50),
			await status("", 15),
		]).toEqual([413, 413, 413, 200, 413, 413, 200])
	})
})

describe("bodyLimit: the request the rest of the chain sees", () => {
	// v0: 97a20f8e38
	// v0: 433391df04
	// v0: d57e7166a3
	it("keeps the method and headers, and the body reads whole for middleware, .input() and the handler", async () => {
		const app = honey<{}>()
			.use(bodyLimit({ maxSize: 10_000 }))
			.use(createMiddleware((_ctx, next) => next({ logged: true })))
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) =>
				ctx.res.json("created", {
					input: ctx.input,
					logged: ctx.logged,
					method: ctx.req.method,
					type: ctx.req.headers.get("content-type"),
				}),
			)
		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: '{"name":"test"}',
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect([res.status, await res.json()]).toEqual([
			201,
			{ input: { json: { name: "test" } }, logged: true, method: "POST", type: "application/json" },
		])
	})

	// v0: a8e625d92f
	it("an overflow while .input() reads the body stays 413, never a malformed body", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 8 }))
		app
			.post("/j")
			.input({ json: z.object({ a: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json))
		const req = new Request("http://localhost/j", {
			body: streamed([JSON.stringify({ a: "x".repeat(100) })]),
			duplex: "half",
			headers: { "content-type": "application/json" },
			method: "POST",
		} as RequestInit)
		expect(await answer(app.fetch(req, {}))).toEqual([413, TOO_LARGE])
	})
})

describe("bodyLimit: an overflow", () => {
	// v0: c2364a0f22
	// v0: a8b65b6419
	it("a multipart body over the limit is a 413, its encoder left to finish without an unhandled rejection", async () => {
		const unhandled = vi.fn()
		process.on("unhandledRejection", unhandled)
		try {
			const app = honey<{}>().use(bodyLimit({ maxSize: 1000 }))
			app
				.post("/upload")
				.handler(async (ctx) => ctx.res.json("ok", { n: (await ctx.req.formData()).getAll("f").length }))
			const form = new FormData()
			form.append("f", new Blob(["x".repeat(500)], { type: "text/plain" }), "a.txt")
			form.append("f", new Blob(["y".repeat(500)], { type: "text/plain" }), "b.txt")
			const req = new Request("http://localhost/upload", { body: form, method: "POST" })
			expect(await answer(app.fetch(req, {}))).toEqual([413, TOO_LARGE])
			await new Promise((resolve) => setTimeout(resolve, 50))
			expect(unhandled).not.toHaveBeenCalled()
		} finally {
			process.off("unhandledRejection", unhandled)
		}
	})

	// v0: bfd749ed65
	it("after an overflow the rest is drained no further than 1 MiB, then the endless body is cancelled", async () => {
		let cancelled = false
		let pulled = 0
		const endless = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true
			},
			pull(controller) {
				pulled += 1
				controller.enqueue(new Uint8Array(64 * 1024))
			},
		})
		const req = new Request("http://localhost/x", { body: endless, duplex: "half", method: "POST" } as RequestInit)
		const res = await limited({ maxSize: 10 }).fetch(req, {})
		await vi.waitFor(() => expect(cancelled).toBe(true), { timeout: 2000 })
		expect([res.status, pulled * 64 * 1024 < 2 * 1024 * 1024]).toEqual([413, true])
	})
})

describe("bodyLimit beside other middleware", () => {
	// v0: 1f7789b984
	// v0: b9d77ddfe3
	it("a request log after it sees the bounded body; one it refused is never logged", async () => {
		const logged: CurlLogData[] = []
		const app = honey<{}>()
			.use(bodyLimit({ maxSize: 64, trustContentLength: true }))
			.use(curlLogger({ body: { maxBytes: 64 }, log: (data) => logged.push(data) }))
		app.post("/users").handler(async (ctx) => ctx.res.json("ok", (await ctx.req.json()) as object))
		const json = { "content-type": "application/json" }
		const ok = await app.fetch(
			new Request("http://localhost/users", { body: '{"ok":true}', headers: json, method: "POST" }),
			{},
		)
		const big = JSON.stringify({ data: "x".repeat(100) })
		const headers = { ...json, "content-length": String(big.length) }
		const refused = await app.fetch(new Request("http://localhost/users", { body: big, headers, method: "POST" }), {})
		expect([
			ok.status,
			refused.status,
			logged.length,
			logged[0]?.bodyIncluded,
			logged[0]?.curl.includes(`--data-raw '{"ok":true}'`),
		]).toEqual([200, 413, 1, true, true])
	})

	// v0: 3eba97996a
	it("composes with request ids, a timeout and an IP allow-list on one app", async () => {
		const app = honey<{}>()
		app
			.use(requestId())
			.use(timeout({ duration: 1000 }))
			.use(bodyLimit({ maxSize: 1000 }))
			.use(ipRestrict({ allowList: ["127.0.0.1"] }))
			.post("/ping")
			.handler(async (ctx) => ctx.res.json("ok", { body: (await ctx.req.json()) as object }))
		const base = await listen(app)
		const res = await fetch(`${base}/ping`, {
			body: '{"a":1}',
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		expect([res.status, await res.json(), res.headers.get("x-request-id") !== null]).toEqual([
			200,
			{ body: { a: 1 } },
			true,
		])
	})
})

const servers: HoneyServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
})

/** Serve `app` on a free loopback port; the base URL to reach it. */
async function listen(app: { fetch(request: Request, env: {}): Response | Promise<Response> }): Promise<string> {
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe("bodyLimit on a real socket", () => {
	// v0: 9f87d702c3
	// v0: 0c89a1ac58
	// v0: 6998bb3ec2
	// v0: 3b5e030334
	// v0: 3e3af178d9
	// v0: 28667ab92e
	it("limits a Node request in place, keeping its method, headers and body", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 1024 }))
		app.on(["POST", "PUT", "PATCH"], "/echo").handler(async (ctx) =>
			ctx.res.json("ok", {
				auth: ctx.req.headers.get("authorization"),
				body: await ctx.req.text(),
				method: ctx.req.method,
			}),
		)
		app
			.post("/users")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))
		const base = await listen(app)
		const send = async (path: string, init: RequestInit) => {
			const res = await fetch(`${base}${path}`, init)
			return [res.status, (await res.json()) as unknown]
		}
		const headers = { authorization: "Bearer tok-123", "content-type": "text/plain" }
		const json = { "content-type": "application/json" }
		expect([
			await send("/echo", { body: "hello", headers, method: "POST" }),
			await send("/echo", { body: "hi", headers, method: "PUT" }),
			await send("/echo", { body: "x", headers, method: "PATCH" }),
			await send("/users", { body: '{"name":"Bob"}', headers: json, method: "POST" }),
			(await send("/echo", { body: "x".repeat(2000), headers, method: "POST" }))[0],
		]).toEqual([
			[200, { auth: "Bearer tok-123", body: "hello", method: "POST" }],
			[200, { auth: "Bearer tok-123", body: "hi", method: "PUT" }],
			[200, { auth: "Bearer tok-123", body: "x", method: "PATCH" }],
			[201, { json: { name: "Bob" } }],
			413,
		])
	})
})
