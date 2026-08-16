import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"
import type { RouteHandler, RouteTree } from "../../../src/tree.ts"
import { createNode, insertRoute } from "../../../src/tree.ts"

function stubSchema() {
	return {
		"~standard": {
			validate: (data: unknown) => ({ value: data }),
			vendor: "test",
			version: 1,
		},
	}
}

function fnNullHandler(iv: RouteHandler["iv"], mt: RouteHandler["mt"] = null): RouteHandler {
	return {
		bek: null,
		ef: null,
		ek: new Set(),
		fn: null as unknown as RouteHandler["fn"],
		iv,
		mt,
		mw: [],
		os: null,
		ov: null,
		rp: "",
	}
}

function gatewayTree(): RouteTree {
	const root = createNode()
	const schema = stubSchema()
	const postItems = fnNullHandler({ json: schema }, { worker: "items" })
	const getItems = fnNullHandler(null)
	const restore = fnNullHandler({ params: schema })

	insertRoute(root, "POST", "/v1/items", postItems)
	insertRoute(root, "GET", "/v1/items", getItems)
	insertRoute(root, "POST", "/v1/items/:id/restore", restore)

	return {
		handlers: {
			"GET /v1/items": getItems,
			"POST /v1/items": postItems,
			"POST /v1/items/:id/restore": restore,
		},
		meta: {},
		root,
	}
}

function gatewayApp(destination: (ctx: unknown, url: string, init: RequestInit) => Response | Promise<Response>) {
	return honey<{}>().routeTree(gatewayTree()).all("*").proxy({ destination })
}

describe("fn:null fallthrough Content-Type from matched iv", () => {
	it("POST json route + text/plain → 415, destination not called", async () => {
		let called = false
		const app = gatewayApp(async () => {
			called = true
			return new Response("proxied")
		})

		const res = await app.fetch(
			new Request("http://localhost/v1/items", {
				body: "nope",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)

		expect(res.status).toBe(415)
		const body = (await res.json()) as { error_key: string }
		expect(body.error_key).toBe("unsupported_media_type")
		expect(called).toBe(false)
	})

	it("POST json route + no Content-Type → 415, destination not called", async () => {
		let called = false
		const app = gatewayApp(async () => {
			called = true
			return new Response("proxied")
		})

		const req = new Request("http://localhost/v1/items", {
			body: "xx",
			headers: { "content-length": "2" },
			method: "POST",
		})
		req.headers.delete("content-type")

		const res = await app.fetch(req, {})
		expect(res.status).toBe(415)
		const body = (await res.json()) as { error_key: string }
		expect(body.error_key).toBe("unsupported_media_type")
		expect(called).toBe(false)
	})

	it("POST json route + application/json → destination called, body still readable", async () => {
		let called = false
		const app = gatewayApp(async (_ctx, _url, init) => {
			called = true
			const body = init.body ? await new Response(init.body).text() : ""
			return new Response(body)
		})

		const res = await app.fetch(
			new Request("http://localhost/v1/items", {
				body: '{"x":1}',
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)

		expect(res.status).toBe(200)
		expect(called).toBe(true)
		expect(await res.text()).toBe('{"x":1}')
	})

	it("POST params-only iv + no Content-Type → not 415, destination called", async () => {
		let called = false
		const app = gatewayApp(async () => {
			called = true
			return new Response("proxied")
		})

		const req = new Request("http://localhost/v1/items/42/restore", {
			body: "xx",
			method: "POST",
		})
		req.headers.delete("content-type")

		const res = await app.fetch(req, {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("proxied")
		expect(called).toBe(true)
	})

	it("GET + no Content-Type → 200, never 415", async () => {
		let called = false
		const app = gatewayApp(async () => {
			called = true
			return new Response("proxied")
		})

		const res = await app.fetch(new Request("http://localhost/v1/items"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("proxied")
		expect(called).toBe(true)
	})

	it("415 fires before middleware that would wait on the body", async () => {
		let mwRan = false
		const app = honey<{}>()
			.routeTree(gatewayTree())
			.use(async (_ctx, next) => {
				mwRan = true
				return next()
			})
			.all("*")
			.proxy({
				destination: async () => new Response("proxied"),
			})

		const res = await app.fetch(
			new Request("http://localhost/v1/items", {
				body: "nope",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)

		expect(res.status).toBe(415)
		expect(mwRan).toBe(false)
	})

	it("fn !== null still 415s from validateInput", async () => {
		const app = honey()
			.post("/v1/items")
			.input({ json: z.object({ x: z.number() }) })
			.handler((ctx) => ctx.res.json("ok", { x: ctx.input.json.x }))

		const res = await app.fetch(
			new Request("http://localhost/v1/items", {
				body: "nope",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)

		expect(res.status).toBe(415)
		const body = (await res.json()) as { error_key: string }
		expect(body.error_key).toBe("unsupported_media_type")
	})
})
