import type { AddressInfo } from "node:net"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { serve } from "../adapters/node/serve.ts"
import { defineErrors } from "../errors/errors.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { GRAPH, Honey, honey } from "./app.ts"

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init)
const makeRequest = (method: string, path: string) => req(path, { method })

describe("the app handle", () => {
	// v0: e52312b8b1
	it("use, basePath, context and meta return a new handle on the same graph", () => {
		const app = honey<{}>()
		const pass = createMiddleware((_ctx, next) => next({ db: "pg" }))
		const handles = [app.use(pass), app.basePath("/v1"), app.context({ a: 1 }), app.meta({ summary: "s" })]
		for (const handle of handles) {
			expect(handle).not.toBe(app)
			expect(handle[GRAPH]).toBe(app[GRAPH])
		}
		expect(app.meta()).toBe(app)
	})

	// v0: 87e5890e24
	// v0: 99663bbb93
	it("context() refuses a key the framework owns, and merges over earlier values", async () => {
		expect(() => honey<{}>().context({ req: 1 })).toThrow('context() cannot set reserved key "req"')
		const app = honey<{}>().context({ a: 1, b: 1 }).context({ b: 2 })
		app.get("/c").handler((ctx) => ctx.res.json("ok", { a: ctx.a, b: ctx.b }))
		expect(await (await app.fetch(req("/c"), {})).json()).toEqual({ a: 1, b: 2 })
	})

	// v0: 500fe0c015
	it("the settings setters return the handle they were called on, typed the same", () => {
		const app = honey<{ k: string }>()
		const same = app
			.trailingSlash("strip")
			.encodedSlashes("allow")
			.onError(() => undefined)
		expect(same).toBe(app)
		expectTypeOf(same).toEqualTypeOf(app)
	})

	it("serving from a new handle re-finalizes once, so 404 runs that handle's chain when there are no routes", async () => {
		const seen: string[] = []
		const app = honey<{}>().use(
			createMiddleware((_ctx, next) => {
				seen.push("logged")
				return next()
			}),
		)
		expect((await app.fetch(req("/anything"), {})).status).toBe(404)
		expect((await app.fetch(req("/anything"), {})).status).toBe(404)
		expect(seen).toEqual(["logged", "logged"])
	})
})

describe("the app handle: method verbs and env", () => {
	it("registers each method verb under its own method", async () => {
		const app = honey<{}>()
		app.delete("/v").handler((ctx) => ctx.res.text("ok", "delete"))
		app.head("/v").handler((ctx) => ctx.res.noContent())
		app.options("/v").handler((ctx) => ctx.res.text("ok", "options"))
		app.put("/v").handler((ctx) => ctx.res.text("ok", "put"))
		for (const method of ["DELETE", "OPTIONS", "PUT"])
			expect(await (await app.fetch(makeRequest(method, "/v"), {})).text()).toBe(method.toLowerCase())
		expect((await app.fetch(makeRequest("HEAD", "/v"), {})).status).toBe(204)
	})

	it("honey() with no env type takes an unknown env", () => {
		expectTypeOf(honey()).toEqualTypeOf<Honey<unknown>>()
	})
})

/** The ctx.meta each path answers, in order. */
async function metas(app: { fetch(r: Request, env: {}): Response | Promise<Response> }, ...targets: string[]) {
	return Promise.all(
		targets.map(async (target) => {
			const [method, path] = target.includes(" ") ? target.split(" ") : ["GET", target]
			return (await app.fetch(makeRequest(method as string, path as string), {})).json()
		}),
	)
}

describe("chain meta", () => {
	// v0: e1a839c25f
	// v0: eb1dca663a
	// v0: 9d1986f3f1
	// v0: c763d8649a
	// v0: 9920d8c1ac
	// v0: 17d508f033
	// v0: 18ceb7b727
	it("reaches ctx.meta of every route registered through the handle, under the route's own; none is {}", async () => {
		const app = honey<{}>()
		const chain = app.meta({ security: "jwt" })
		chain.get("/plain").handler((ctx) => ctx.res.json("ok", ctx.meta))
		chain
			.get("/merged")
			.meta({ tags: "Auth" })
			.handler((ctx) => ctx.res.json("ok", ctx.meta))
		chain
			.get("/overridden")
			.meta({ security: "none" })
			.handler((ctx) => ctx.res.json("ok", ctx.meta))
		chain.on(["GET", "POST"], "/both").handler((ctx) => ctx.res.json("ok", ctx.meta))
		app.get("/bare").handler((ctx) => ctx.res.json("ok", ctx.meta))
		expect(await metas(app, "/plain", "/merged", "/overridden", "/both", "POST /both", "/bare")).toEqual([
			{ security: "jwt" },
			{ security: "jwt", tags: "Auth" },
			{ security: "none" },
			{ security: "jwt" },
			{ security: "jwt" },
			{},
		])
	})

	// v0: a71830633d
	// v0: 228f5555ae
	// v0: 16f94d838d
	// v0: 1ae4bc5f97
	// v0: 0f8f124935
	// v0: 49ccc443b1
	// v0: d9c308bbde
	it("accumulates across chain calls, a later value winning, through basePath, use and context", async () => {
		const pass = createMiddleware((_ctx, next) => next({ user: "u-1" }))
		const app = honey<{}>()
		const chain = app.meta({ a: 1, b: 1 }).basePath("/v1").use(pass).context({ region: "eu" }).meta({ b: 2, c: 3 })
		chain.get("/t").handler((ctx) => ctx.res.json("ok", { meta: ctx.meta, region: ctx.region, user: ctx.user }))
		expect(await metas(app, "/v1/t")).toEqual([{ meta: { a: 1, b: 2, c: 3 }, region: "eu", user: "u-1" }])
	})
})

describe("chain meta beside sub-chains, sub-apps and the rest of a route", () => {
	// v0: a122129a5b
	// v0: 2b83ce3530
	// v0: c71676b901
	// v0: a7248b1526
	// v0: 28924f674c
	it("keeps sub-chains and a mounted sub-app apart, beside input, output, errors and scoped middleware", async () => {
		const errors = defineErrors({ gone: "gone" })
		const app = honey<{}>().errorFactory(errors)
		const scoped = app.use(
			"/admin",
			createMiddleware((_ctx, next) => next({ scoped: true })),
		)
		const admin = scoped.meta({ area: "admin" })
		admin
			.post("/admin/items")
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { ok: z.object({ meta: z.object({ area: z.string() }), scoped: z.boolean() }) } })
			.errors("gone")
			.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta as { area: string }, scoped: ctx.scoped }))
		app
			.meta({ area: "public" })
			.get("/gone")
			.errors("gone")
			.handler((ctx) => {
				throw ctx.errors.gone()
			})
		const sub = honey<{}>().meta({ area: "sub" })
		sub.get("/sub").handler((ctx) => ctx.res.json("ok", ctx.meta))
		app.route(sub)
		const created = await app.fetch(
			new Request("http://localhost/admin/items", {
				body: '{"name":"x"}',
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect([await created.json(), (await app.fetch(req("/gone"), {})).status, ...(await metas(app, "/sub"))]).toEqual([
			{ meta: { area: "admin" }, scoped: true },
			410,
			{ area: "sub" },
		])
	})
})

describe("chain meta on the wire", () => {
	// v0: 5fd405dc34
	// v0: 38ad15ea53
	it("reaches ctx.meta on the wire as in process", async () => {
		const app = honey<{}>()
		const chain = app.meta({ security: "jwt" })
		chain.get("/chain").handler((ctx) => ctx.res.json("ok", ctx.meta))
		chain
			.get("/route")
			.meta({ security: "none" })
			.handler((ctx) => ctx.res.json("ok", ctx.meta))
		const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
		await new Promise((resolve) => server.once("listening", resolve))
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		try {
			expect(await Promise.all(["/chain", "/route"].map(async (path) => (await fetch(base + path)).json()))).toEqual([
				{ security: "jwt" },
				{ security: "none" },
			])
		} finally {
			await server.shutdown(0)
		}
	})
})
