import { describe, expect, it } from "vitest"
import * as z from "zod"
import { defineErrors } from "../errors/errors.ts"
import { readableStream } from "../input/input.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import { collectRoutes } from "./collect.ts"

describe("collectRoutes: one record per path a route serves", () => {
	it("names each route by method and pattern, with its OpenAPI path and params, in registration order", () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.text("ok", "ok"))
		app.post("/files/*path").handler((ctx) => ctx.res.text("ok", "ok"))
		app.get("/raw/*").handler((ctx) => ctx.res.text("ok", "ok"))
		app.all("/proxy").handler((ctx) => ctx.res.text("ok", "ok"))
		expect(
			collectRoutes(app).http.map(({ id, method, params, path, pattern }) => ({ id, method, params, path, pattern })),
		).toEqual([
			{ id: "GET /users/:id", method: "GET", params: ["id"], path: "/users/{id}", pattern: "/users/:id" },
			{ id: "POST /files/*path", method: "POST", params: ["path"], path: "/files/{path}", pattern: "/files/*path" },
			{ id: "GET /raw/*", method: "GET", params: ["wildcard"], path: "/raw/{wildcard}", pattern: "/raw/*" },
			{ id: "ALL /proxy", method: "ALL", params: [], path: "/proxy", pattern: "/proxy" },
		])
	})

	it("serves an optional segment as two paths, and a mounted sub-app under its prefix", () => {
		const app = honey<{}>()
		app.get("/posts/:id?").handler((ctx) => ctx.res.text("ok", "ok"))
		const sub = honey<{}>()
		sub.get("/me").handler((ctx) => ctx.res.text("ok", "ok"))
		app.route("/v1", sub)
		expect(collectRoutes(app).http.map(({ id, path }) => [id, path])).toEqual([
			["GET /posts/:id?", "/posts"],
			["GET /posts/:id?", "/posts/{id}"],
			["GET /v1/me", "/v1/me"],
		])
	})

	it("collects a WebSocket route apart, never as an operation", () => {
		const app = honey<{}>()
		app
			.ws("/chat/:room")
			.input({ search: z.object({ token: z.string() }) })
			.handler({})
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const { http, ws } = collectRoutes(app)
		expect(http.map(({ id }) => id)).toEqual(["GET /health"])
		expect(ws.map(({ id, input, params, path }) => ({ id, input: Object.keys(input ?? {}), params, path }))).toEqual([
			{ id: "WS /chat/:room", input: ["search"], params: ["room"], path: "/chat/{room}" },
		])
	})

	it("sees a route registered after an earlier collection", () => {
		const app = honey<{}>()
		app.get("/a").handler((ctx) => ctx.res.text("ok", "ok"))
		expect(collectRoutes(app).http).toHaveLength(1)
		app.get("/b").handler((ctx) => ctx.res.text("ok", "ok"))
		expect(collectRoutes(app).http.map(({ id }) => id)).toEqual(["GET /a", "GET /b"])
	})
})

describe("collectRoutes: what each route declares", () => {
	it("carries the resolved meta: middleware's, the chain's, the route's; x- extensions and internal as given", () => {
		const tagged = createMiddleware((_ctx, next) => next({}), { meta: { tags: ["auth"] } })
		const app = honey<{}>()
		app
			.use(tagged)
			.meta({ summary: "chain" })
			.get("/a")
			.meta({ extensions: { "x-rate": 5 }, internal: true })
			.handler((ctx) => ctx.res.text("ok", "ok"))
		app.get("/b").handler((ctx) => ctx.res.text("ok", "ok"))
		const [a, b] = collectRoutes(app).http
		expect([a?.meta, a?.internal, b?.meta, b?.internal]).toEqual([
			{ extensions: { "x-rate": 5 }, internal: true, summary: "chain", tags: ["auth"] },
			true,
			{},
			false,
		])
	})

	it("lists the error keys a route may answer, sorted, with the factory they come from", () => {
		const errors = defineErrors({ conflict: "conflict", gone: "gone", locked: "locked" })
		const app = honey<{}>().errorFactory(errors).defaultErrors("locked")
		app
			.get("/a")
			.errors("gone", "conflict")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		app
			.get("/b")
			.boundary("gone")
			.handler((ctx) => ctx.res.text("ok", "ok"))
		const open = honey<{}>()
		open.get("/open").handler((ctx) => ctx.res.text("ok", "ok"))
		const [a, b] = collectRoutes(app).http
		expect([a?.errorKeys, b?.errorKeys, collectRoutes(open).http[0]?.errorKeys]).toEqual([
			["conflict", "gone", "locked"],
			["gone", "locked"],
			[],
		])
		expect(Object.keys(a?.errors ?? {}).sort()).toEqual(["conflict", "gone", "locked"])
	})
})

describe("collectRoutes: what each route declares for its body", () => {
	it("hands over the input and output declarations as written, a readableStream() wrapper included", () => {
		const json = z.object({ name: z.string() })
		const body = readableStream(z.string())
		const answer = { "application/json": { ok: z.object({ id: z.string() }) } }
		const app = honey<{}>()
		app
			.post("/a")
			.input({ json, search: z.object({ q: z.string() }) })
			.output(answer)
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))
		app
			.put("/b")
			.input({ form: body })
			.handler((ctx) => ctx.res.text("ok", "ok"))
		app.get("/c").handler((ctx) => ctx.res.text("ok", "ok"))
		const [a, b, c] = collectRoutes(app).http
		expect([a?.input?.json, a?.output, b?.input?.form, c?.input, c?.output]).toEqual([json, answer, body, null, null])
	})
})
