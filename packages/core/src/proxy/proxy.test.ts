import { describe, expect, expectTypeOf, it } from "vitest"
import { createMiddleware } from "../middleware/middleware.ts"
import { isHoneyResponse, NODE_OUTBOUND } from "../response/builder.ts"
import type { TypedResponse } from "../response/response.ts"
import { honey } from "../routing/app.ts"
import { proxy } from "./proxy.ts"

const req = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init)

function nodeReq(path: string): Request {
	const request = req(path)
	Object.defineProperty(request, NODE_OUTBOUND, { value: true })
	return request
}

describe("proxy(config): a plain route handler", () => {
	it("is mounted with .handler(), on any method a route takes", async () => {
		const app = honey<{}>()
		app.all("/api/*rest").handler(proxy({ destination: (_ctx, url, init) => new Response(`${init.method} ${url}`) }))
		const answers = await Promise.all(
			["GET", "POST", "DELETE"].map(async (method) => (await app.fetch(req("/api/x", { method }), {})).text()),
		)
		expect(answers).toEqual(["GET /api/x", "POST /api/x", "DELETE /api/x"])
	})

	// v0: ed7b01fb64
	it("a route on chosen methods takes it too", async () => {
		const app = honey<{}>()
		app.on(["GET", "PUT"], "/files/*rest").handler(proxy({ destination: (_ctx, url) => new Response(url) }))
		const [get, put, post] = await Promise.all(
			["GET", "PUT", "POST"].map((method) => app.fetch(req("/files/a", { method }), {})),
		)
		expect([await get.text(), await put.text(), post.status]).toEqual(["/files/a", "/files/a", 405])
	})

	it("answers the passthrough brand: the upstream decides status and type", () => {
		const handler = proxy({ destination: () => new Response("x") })
		expectTypeOf(handler).returns.resolves.toEqualTypeOf<TypedResponse>()
	})

	it("destination sees the route's ctx: env and what middleware added", async () => {
		const app = honey<{ SVC: { fetch(url: string): Response } }>()
		app
			.use(createMiddleware(async (_ctx, next) => next({ token: "abc123" })))
			.all("/api/*rest")
			.handler(
				proxy({
					destination: (ctx, url) => {
						expectTypeOf(ctx.env.SVC.fetch).toBeFunction()
						return ctx.env.SVC.fetch(`${ctx.token} ${url}`)
					},
				}),
			)
		const res = await app.fetch(req("/api/x"), { SVC: { fetch: (url: string) => new Response(url) } })
		expect(await res.text()).toBe("abc123 /api/x")
	})

	// v0: 2a744d10f4
	it("redirects are the client's to follow: redirect: manual", async () => {
		const app = honey<{}>()
		app.all("/api/*rest").handler(proxy({ destination: (_ctx, _url, init) => new Response(init.redirect) }))
		expect(await (await app.fetch(req("/api/x"), {})).text()).toBe("manual")
	})
})

describe("proxy: requestHeaders", () => {
	// v0: 954770acb4
	// v0: 2285728d9b
	it("a function edits the forwarded headers, with the route's ctx", async () => {
		const app = honey<{}>()
		app
			.use(createMiddleware(async (_ctx, next) => next({ token: "abc123" })))
			.all("/api/*rest")
			.handler(
				proxy({
					destination: (_ctx, _url, init) => new Response(new Headers(init.headers).get("x-token")),
					requestHeaders: (ctx, headers) => headers.set("x-token", ctx.token),
				}),
			)
		expect(await (await app.fetch(req("/api/x"), {})).text()).toBe("abc123")
	})

	// v0: d05f8c0e14
	it("a record sets each entry", async () => {
		const app = honey<{}>()
		app.all("/api/*rest").handler(
			proxy({
				destination: (_ctx, _url, init) => {
					const headers = new Headers(init.headers)
					return Response.json([headers.get("x-api-version"), headers.get("x-source")])
				},
				requestHeaders: { "x-api-version": "2", "x-source": "gateway" },
			}),
		)
		expect(await (await app.fetch(req("/api/x"), {})).json()).toEqual(["2", "gateway"])
	})
})

describe("proxy: rewriteUrl", () => {
	// v0: 51729d5f0e
	// v0: b6fb8591d7
	it("rewrites the path and query before destination, with ctx", async () => {
		const app = honey<{}>()
		app.all("/v1/*rest").handler(
			proxy({
				destination: (_ctx, url) => new Response(url),
				rewriteUrl: (url, ctx: { path: string }) => `${url.replace("/v1", "/v2")}#${ctx.path}`,
			}),
		)
		expect(await (await app.fetch(req("/v1/users/123?foo=bar"), {})).text()).toBe("/v2/users/123?foo=bar#/v1/users/123")
	})
})

describe("proxy: onResponse", () => {
	// v0: 88bbfdd857
	it("edits the response's headers in place", async () => {
		const app = honey<{}>()
		app.all("/api/*rest").handler(
			proxy({
				destination: () => new Response("ok", { headers: { "x-internal": "secret" } }),
				onResponse: (_ctx, res) => {
					res.headers.delete("x-internal")
				},
			}),
		)
		const res = await app.fetch(req("/api/x"), {})
		expect([res.headers.get("x-internal"), await res.text()]).toEqual([null, "ok"])
	})

	// v0: d1c4b06bcc
	it("can set headers even when the upstream's were immutable (a redirect, a fetch)", async () => {
		const app = honey<{}>()
		app.all("/api/*rest").handler(
			proxy({
				destination: () => Response.redirect("http://up.test/elsewhere", 302),
				onResponse: (_ctx, res) => {
					res.headers.set("x-proxied", "1")
				},
			}),
		)
		const res = await app.fetch(req("/api/x"), {})
		expect([res.status, res.headers.get("x-proxied"), res.headers.get("location")]).toEqual([
			302,
			"1",
			"http://up.test/elsewhere",
		])
	})

	// v0: 6be2e7ddc5
	it("a Response it returns replaces the upstream's", async () => {
		const app = honey<{}>()
		app
			.all("/api/*rest")
			.handler(proxy({ destination: () => new Response("original"), onResponse: async () => new Response("replaced") }))
		expect(await (await app.fetch(req("/api/x"), {})).text()).toBe("replaced")
	})
})

describe("proxy: the answer's shape", () => {
	// v0: 3bd2bb5aa7
	it.each([204, 304])("a %i upstream answer stays bodiless", async (status) => {
		const app = honey<{}>()
		app.all("/api/*rest").handler(proxy({ destination: () => new Response(null, { status }) }))
		const res = await app.fetch(req("/api/x"), {})
		expect([res.status, res.body]).toEqual([status, null])
	})

	it("a 101 upgrade is the runtime's: returned as it came, onResponse not called", async () => {
		const upgraded = new Response(null)
		Object.defineProperty(upgraded, "status", { value: 101 })
		let called = false
		const app = honey<{}>()
		app.all("/api/*rest").handler(
			proxy({
				destination: () => upgraded,
				onResponse: () => {
					called = true
				},
			}),
		)
		const res = await app.fetch(req("/api/ws", { headers: { connection: "upgrade", upgrade: "websocket" } }), {})
		expect([res === upgraded, called]).toEqual([true, false])
	})

	it("the upstream's error JSON reaches the client byte for byte", async () => {
		const body = '{"error_key":"item_gone","status":410,"success":false}'
		const app = honey<{}>()
		app.all("/api/*rest").handler(
			proxy({
				destination: () => new Response(body, { headers: { "content-type": "application/json" }, status: 410 }),
			}),
		)
		const res = await app.fetch(req("/api/x"), {})
		expect([res.status, await res.text()]).toEqual([410, body])
	})
})

describe("proxy: the plain path on the Node bridge", () => {
	it("the answer is a HoneyResponse: the header middleware in front stay on the plain map", async () => {
		const app = honey<{}>()
		app.all("/api/*rest").handler(
			proxy({
				destination: () => {
					const headers = new Headers({ connection: "close", "content-type": "text/plain", "x-up": "1" })
					headers.append("set-cookie", "a=1")
					headers.append("set-cookie", "b=2")
					return new Response("streamed", { headers })
				},
				onResponse: (_ctx, res) => {
					res.headers.delete("x-up")
				},
			}),
		)
		const res = await app.fetch(nodeReq("/api/x"), {})
		expect([
			isHoneyResponse(res),
			res.headers.get("connection"),
			res.headers.get("x-up"),
			res.headers.getSetCookie(),
			await res.text(),
		]).toEqual([true, null, null, ["a=1", "b=2"], "streamed"])
	})

	it("a bodiless upstream answer is a bodiless HoneyResponse", async () => {
		const app = honey<{}>()
		app.all("/api/*rest").handler(proxy({ destination: () => new Response(null, { status: 304 }) }))
		const res = await app.fetch(nodeReq("/api/x"), {})
		expect([isHoneyResponse(res), res.status, res.body]).toEqual([true, 304, null])
	})
})
