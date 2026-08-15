import { describe, expect, it } from "vitest"
import { Honey } from "../../../src/index.ts"

function createTestApp() {
	return new Honey<{ UPSTREAM: { fetch: typeof fetch } }>()
}

function makeRequest(method: string, path: string, opts?: RequestInit) {
	return new Request(`http://localhost${path}`, { method, ...opts })
}

describe("proxy", () => {
	it("forwards GET request to destination", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: (_ctx, url, init) =>
					new Response(JSON.stringify({ method: init.method, url }), {
						headers: { "content-type": "application/json" },
					}),
			})

		const res = await app.fetch(makeRequest("GET", "/api/users?page=2"), {} as never)
		const body = (await res.json()) as { method: string; url: string }
		expect(body.method).toBe("GET")
		expect(body.url).toBe("/api/users?page=2")
	})

	it("forwards POST body as stream", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: async (_ctx, _url, init) => {
					const body = init.body ? await new Response(init.body).text() : ""
					return new Response(body)
				},
			})

		const res = await app.fetch(makeRequest("POST", "/api/data", { body: "hello" }), {} as never)
		expect(await res.text()).toBe("hello")
	})

	it("does not forward body for GET", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: (_ctx, _url, init) => new Response(init.body === undefined ? "no-body" : "has-body"),
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		expect(await res.text()).toBe("no-body")
	})

	it("requestHeaders function mutates headers", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: (_ctx, _url, init) => {
					const h = init.headers as Headers
					return new Response(h.get("x-custom"))
				},
				requestHeaders: (_ctx, h) => {
					h.set("x-custom", "injected")
				},
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		expect(await res.text()).toBe("injected")
	})

	it("requestHeaders static record sets headers", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: (_ctx, _url, init) => {
					const h = init.headers as Headers
					return new Response(JSON.stringify({ source: h.get("x-source"), version: h.get("x-api-version") }))
				},
				requestHeaders: { "x-api-version": "2", "x-source": "gateway" },
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		const body = (await res.json()) as Record<string, string>
		expect(body.version).toBe("2")
		expect(body.source).toBe("gateway")
	})

	it("strips hop-by-hop headers", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: (_ctx, _url, init) => {
					const h = init.headers as Headers
					return new Response(
						JSON.stringify({
							connection: h.get("connection"),
							keepAlive: h.get("keep-alive"),
							te: h.get("te"),
							transferEncoding: h.get("transfer-encoding"),
						}),
					)
				},
			})

		const res = await app.fetch(
			makeRequest("GET", "/api/test", {
				headers: {
					connection: "keep-alive",
					"keep-alive": "timeout=5",
					te: "trailers",
					"transfer-encoding": "chunked",
				},
			}),
			{} as never,
		)
		const body = (await res.json()) as Record<string, string | null>
		expect(body.connection).toBeNull()
		expect(body.keepAlive).toBeNull()
		expect(body.te).toBeNull()
		expect(body.transferEncoding).toBeNull()
	})

	it("calls onResponse hook", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: () => new Response("ok", { headers: { "x-internal": "secret" } }),
				onResponse: (_ctx, res) => {
					res.headers.delete("x-internal")
				},
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		expect(res.headers.get("x-internal")).toBeNull()
		expect(await res.text()).toBe("ok")
	})

	it("onResponse can replace response", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: () => new Response("original"),
				onResponse: () => new Response("replaced"),
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		expect(await res.text()).toBe("replaced")
	})

	it("rewriteUrl rewrites path before destination", async () => {
		const app = createTestApp()
			.all("/v1/users/*")
			.proxy({
				destination: (_ctx, url) => new Response(url),
				rewriteUrl: (path) => path.replace("/v1/users", "/users"),
			})

		const res = await app.fetch(makeRequest("GET", "/v1/users/123"), {} as never)
		expect(await res.text()).toBe("/users/123")
	})

	it("rewriteUrl receives full URL with query", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: (_ctx, url) => new Response(url),
				rewriteUrl: (url) => url.replace("/api", "/v2"),
			})

		const res = await app.fetch(makeRequest("GET", "/api/test?foo=bar"), {} as never)
		expect(await res.text()).toBe("/v2/test?foo=bar")
	})

	it("sets redirect to manual", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: (_ctx, _url, init) => new Response(init.redirect),
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		expect(await res.text()).toBe("manual")
	})

	it("sets duplex for POST with body", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: (_ctx, _url, init) => {
					const duplex = (init as Record<string, unknown>).duplex
					return new Response(String(duplex ?? "none"))
				},
			})

		const res = await app.fetch(makeRequest("POST", "/api/test", { body: "data" }), {} as never)
		expect(await res.text()).toBe("half")
	})

	it("requestHeaders function works with middleware chain", async () => {
		const app = createTestApp()
			.use(async (_ctx, next) => next({ token: "abc123" }))
			.all("/api/*")
			.proxy({
				destination: (_ctx, _url, init) => {
					const h = init.headers as Headers
					return new Response(h.get("x-token"))
				},
				requestHeaders: (ctx, h) => {
					const c = ctx as Record<string, unknown>
					h.set("x-token", c["token"] as string)
				},
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		expect(await res.text()).toBe("abc123")
	})

	/* 101 WS passthrough can't be unit tested — Response(null, {status:101}) is invalid outside real upgrades */

	it("timeout produces 504 error", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: () => {
					const err = new DOMException("timeout", "TimeoutError")
					throw err
				},
				timeout: 100,
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		expect(res.status).toBe(504)
	})

	it("timeout accepts a function", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: (_ctx, _url, init) => {
					const signal = init.signal
					return new Response(signal ? "has-signal" : "no-signal")
				},
				timeout: () => 60_000,
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		expect(await res.text()).toBe("has-signal")
	})

	it("timeout function receives ctx", async () => {
		const app = createTestApp()
			.use(async (_ctx, next) => next({ customTimeout: 5000 }))
			.all("/api/*")
			.proxy({
				destination: () => new Response("ok"),
				timeout: (ctx) => {
					const c = ctx as Record<string, unknown>
					return c["customTimeout"] as number
				},
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		expect(res.status).toBe(200)
	})

	it("network error produces 502 error", async () => {
		const app = createTestApp()
			.all("/api/*")
			.proxy({
				destination: () => {
					throw new TypeError("fetch failed")
				},
			})

		const res = await app.fetch(makeRequest("GET", "/api/test"), {} as never)
		expect(res.status).toBe(502)
	})
})
