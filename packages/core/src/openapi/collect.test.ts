import { describe, expect, it } from "vitest"
import * as z from "zod"
import { defineErrors } from "../errors/errors.ts"
import { readableStream } from "../input/input.ts"
import { createMiddleware, defineMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import { createNode, insertRoute } from "../routing/tree.ts"
import { collectRoutes } from "./collect.ts"
import { ws } from "../ws/route.ts"

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
		ws(app, "/chat/:room")
			.input({ search: z.object({ token: z.string() }) })
			.handler({})
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))
		const { http, ws: sockets } = collectRoutes(app)
		expect(http.map(({ id }) => id)).toEqual(["GET /health"])
		expect(
			sockets.map(({ id, input, params, path }) => ({ id, input: Object.keys(input ?? {}), params, path })),
		).toEqual([{ id: "WS /chat/:room", input: ["search"], params: ["room"], path: "/chat/{room}" }])
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
	// v0: 591e67855c
	// v0: 71240de8ff
	// v0: b14023381e

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
		/* a route declaring input and output resolves its meta the same way */
		app
			.use(tagged)
			.get("/c")
			.input({ search: z.object({ q: z.string().optional() }) })
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))
		const [a, b, c] = collectRoutes(app).http
		expect([a?.meta, a?.internal, b?.meta, b?.internal, c?.meta]).toEqual([
			{ extensions: { "x-rate": 5 }, internal: true, summary: "chain", tags: ["auth"] },
			true,
			{},
			false,
			{ tags: ["auth"] },
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

const shard = createMiddleware(async (_c, next) => next({}), { meta: { tenant: "project_id" } })
/** The meta collect resolves for the route at `path`, HTTP or WebSocket. */
const metaOf = (app: ReturnType<typeof honey<{}>>, path: string) =>
	[...collectRoutes(app).http, ...collectRoutes(app).ws].find((r) => r.pattern === path)?.meta

describe("collectRoutes: middleware meta reaches every route it runs on", () => {
	// v0: edc731afad
	// v0: 03ff4daa83

	it("gives a route-level .use() middleware's meta to that route only, and lets chain .meta() outrank it", () => {
		const app = honey<{}>()
		app
			.get("/audited")
			.use(shard)
			.handler((c) => c.res.json("ok", {}))
		app.get("/plain").handler((c) => c.res.json("ok", {}))
		app
			.use(shard)
			.meta({ tenant: "from-chain" })
			.get("/chain")
			.handler((c) => c.res.json("ok", {}))
		expect([metaOf(app, "/audited"), metaOf(app, "/plain"), metaOf(app, "/chain")]).toEqual([
			{ tenant: "project_id" },
			{},
			{ tenant: "from-chain" },
		])
	})

	// v0: 619448690f
	// v0: 9a8e35727c
	// v0: 21ff53e8fc
	// v0: c669b3cf9a
})

describe("collectRoutes: middleware meta reaches every route it runs on", () => {
	// v0: edc731afad
	// v0: 03ff4daa83

	it("back-fills a scoped middleware's meta into routes registered before it, WebSocket ones too, never over explicit meta", () => {
		const app = honey<{}>()
		app.get("/late/thing").handler((c) => c.res.json("ok", {}))
		app
			.get("/late/explicit")
			.meta({ tenant: "explicit" } as never)
			.handler((c) => c.res.json("ok", {}))
		app.get("/other/thing").handler((c) => c.res.json("ok", {}))
		ws(app, "/late/ws").handler({ onMessage() {} })
		ws(app.use(shard), "/chain-ws").handler({ onMessage() {} })
		ws(app, "/route-ws")
			.use(shard as never)
			.handler({ onMessage() {} })
		app.use("/late", shard)
		expect(
			["/late/thing", "/late/explicit", "/other/thing", "/late/ws", "/chain-ws", "/route-ws"].map((p) =>
				metaOf(app, p),
			),
		).toEqual([
			{ tenant: "project_id" },
			{ tenant: "explicit" },
			{},
			{ tenant: "project_id" },
			{ tenant: "project_id" },
			{ tenant: "project_id" },
		])
	})
})

describe("collectRoutes: each error key's status, for the document", () => {
	it("reads a key's status from the factory the route named, then a loaded leaf's own app's, then the app's, then the key's suffix", () => {
		const named = defineErrors({ teapot: { schema: z.object({ brew: z.string() }), status: "bad_request" } })
		const appErrors = defineErrors({ gone: "gone", locked: "locked" })
		const worker = honey<{}>().errorFactory(defineErrors({ worker_only: "conflict" }))
		worker
			.get("/w")
			.errors("worker_only")
			.handler((c) => c.res.json("ok", {}))
		const app = honey<{}>().errorFactory(appErrors)
		app
			.get("/a")
			.errors(named, "teapot")
			.handler((c) => c.res.json("ok", {}))
		app
			.get("/b")
			.errors("locked")
			.handler((c) => c.res.json("ok", {}))
		const loaded = honey<{}>().errorFactory(appErrors).routeTree(worker.toRouteTree())
		const byPattern = Object.fromEntries(
			[...collectRoutes(app).http, ...collectRoutes(loaded).http].map((r) => [r.pattern, r.errorMeta]),
		)
		expect(byPattern).toEqual({
			"/a": { teapot: { schema: expect.any(Object), status: 400, statusKey: "bad_request" } },
			"/b": { locked: { schema: null, status: 423, statusKey: "locked" } },
			"/w": { worker_only: { schema: null, status: 409, statusKey: "conflict" } },
		})
	})

	it("infers a key's status from its longest status suffix, and names a key nothing resolves unknown at 0", () => {
		const app = honey<{}>().routeTree({
			meta: {},
			root: (() => {
				const root = createNode()
				insertRoute(root, "GET", "/events/:id")
				return root
			})(),
			routes: { "GET /events/:id": { ek: ["billing_event_not_found", "mystery"] } },
			v: 2,
		})
		expect(collectRoutes(app).http[0]?.errorMeta).toEqual({
			billing_event_not_found: { schema: null, status: 404, statusKey: "not_found" },
			mystery: { schema: null, status: 0, statusKey: "unknown" },
		})
	})
})

describe("collectRoutes: a middleware's keys, from the factory it brings", () => {
	it("reads a middleware's keys off its own factory, scoped or on the route, before the app's", () => {
		const audit = defineErrors({ audit_failed: "bad_gateway", conflict_seen: "service_unavailable" })
		const audited = defineMiddleware({ errors: [audit, "audit_failed"], fn: async (_c, next) => next() })
		const seen = defineMiddleware({ errors: [audit, "conflict_seen"], fn: async (_c, next) => next() })
		const app = honey<{}>().errorFactory(defineErrors({ conflict_seen: "conflict" }))
		app.use("/admin", audited)
		app.get("/admin/x").handler((c) => c.res.text("ok", "x"))
		app
			.get("/y")
			.use(seen)
			.handler((c) => c.res.text("ok", "y"))
		expect(collectRoutes(app).http.map((r) => [r.pattern, r.errorMeta])).toEqual([
			["/admin/x", { audit_failed: { schema: null, status: 502, statusKey: "bad_gateway" } }],
			["/y", { conflict_seen: { schema: null, status: 503, statusKey: "service_unavailable" } }],
		])
	})
})
