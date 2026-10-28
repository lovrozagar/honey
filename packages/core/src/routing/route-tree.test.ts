import { describe, expect, it } from "vitest"
import * as z from "zod"
import { defineErrors } from "../errors/errors.ts"
import { createMiddleware, defineMiddleware } from "../middleware/middleware.ts"
import { collectRoutes } from "../openapi/collect.ts"
import { honey } from "./app.ts"
import { gatewayTree } from "./gateway-tree.ts"
import { createNode, insertRoute, type RouteEntry, type RouteTree } from "./tree.ts"
import { mergeTree } from "./tree-merge.ts"
import { timeout } from "../middleware/timeout.ts"

/** A generated-style tree: topology and route data, no live records. */
function treeOf(routes: readonly (readonly [string, string, RouteEntry?])[]): RouteTree {
	const root = createNode()
	const entries: Record<string, RouteEntry> = {}
	for (const [method, path, entry] of routes) entries[insertRoute(root, method as "GET", path)] = entry ?? {}
	return { meta: {}, root, routes: entries, v: 2 }
}

const STATIC = () =>
	treeOf([
		["GET", "/orgs", { ek: ["not_found"], mt: { auth: "required" } }],
		["POST", "/orgs", { mt: { auth: "required" } }],
		["GET", "/health"],
	])

type Fetcher = { fetch: (request: Request, env: {}) => Response | Promise<Response> }

/** Status and text of one request through `app`. */
async function call(app: Fetcher, path: string, init?: RequestInit): Promise<[number, string]> {
	const res = await app.fetch(new Request(`http://x${path}`, init), {})
	return [res.status, await res.text()]
}

describe("routeTree(): serving a loaded tree", () => {
	// v0: 0ee59c5582
	// v0: 0da4f01fb4
	// v0: 583196ca6b
	// v0: 7855303525
	// v0: 97099ec2ee
	// v0: b27299f29a
	it("binds each registered route to its leaf, the registration being the whole record, .on() included", async () => {
		const app = honey<{}>().meta<{ fresh?: boolean }>().routeTree(STATIC())
		app
			.get("/orgs")
			.meta({ fresh: true })
			.input({ search: z.object({ limit: z.coerce.number() }) })
			.handler((c) => c.res.json("ok", { limit: c.input.search.limit, meta: c.meta, pattern: c.routePattern }))
		app.post("/orgs").handler((c) => c.res.text("ok", c.req.method))
		app.get("/health").handler((c) => c.res.text("ok", "up"))
		expect([
			await call(app, "/orgs?limit=3"),
			await call(app, "/orgs", { method: "POST" }),
			await call(app, "/health"),
		]).toEqual([
			[200, '{"limit":3,"meta":{"fresh":true},"pattern":"/orgs"}'],
			[200, "POST"],
			[200, "up"],
		])
		const multi = honey<{}>().routeTree(
			treeOf([
				["GET", "/multi"],
				["POST", "/multi"],
			]),
		)
		multi.on(["GET", "POST"], "/multi").handler((c) => c.res.text("ok", c.req.method))
		expect([await call(multi, "/multi"), await call(multi, "/multi", { method: "POST" })]).toEqual([
			[200, "GET"],
			[200, "POST"],
		])
	})
})

describe("routeTree(): one loaded tree, many apps", () => {
	// v0: f60a27ed85
	// v0: f02f59de07
	// v0: b5373bde7d
	it("freezes the tree it loads and never changes it, so two apps load one tree and serve their own routes", async () => {
		const tree = treeOf([["GET", "/who", { mt: { a: 1 } }]])
		const make = (name: string) => {
			const app = honey<{}>().routeTree(tree)
			app.get("/who").handler((c) => c.res.text("ok", name))
			return app
		}
		const [a, b, none] = [make("A"), make("B"), honey<{}>().routeTree(tree)]
		expect([await call(a, "/who"), await call(b, "/who"), (await call(none, "/who"))[0]]).toEqual([
			[200, "A"],
			[200, "B"],
			404,
		])
		expect([Object.isFrozen(tree.root), Object.isFrozen(tree.root.s.who), tree.routes["GET /who"]]).toEqual([
			true,
			true,
			{ mt: { a: 1 } },
		])
	})
})

describe("routeTree(): leaves nothing serves, and stale trees", () => {
	// v0: 1de1e2d100
	it("answers 404 on a leaf nothing serves, yet still documents it", async () => {
		const app = honey<{}>().routeTree(STATIC())
		app.post("/orgs").handler((c) => c.res.text("ok", "made"))
		expect([(await call(app, "/orgs"))[0], collectRoutes(app).http.map(({ id, meta }) => [id, meta])]).toEqual([
			404,
			[
				["GET /orgs", { auth: "required" }],
				["POST /orgs", {}],
				["GET /health", {}],
			],
		])
	})

	// v0: 46bf9b7c9c
	// v0: 438e928517
	// v0: 2b0d4ffadd
	// v0: a414a2c8c8
	// v0: 5acb87fe58
	// v0: 761c2524a7
	it("refuses a stale tree: a route it lacks, a load after routes, a second load, an older format", () => {
		const stale = honey<{}>().routeTree(STATIC())
		stale.get("/new").handler((c) => c.res.text("ok", "new"))
		expect(() => stale.fetch(new Request("http://x/orgs"), {})).toThrow(
			"GET /new is registered but missing from the loaded route tree",
		)
		stale.get("/other").handler((c) => c.res.text("ok", "other"))
		expect(() => stale.fetch(new Request("http://x/orgs"), {})).toThrow(
			"GET /new, GET /other are registered but missing",
		)
		const late = honey<{}>()
		late.get("/x").handler((c) => c.res.text("ok", "x"))
		expect(() => late.routeTree(STATIC())).toThrow(
			"routeTree() must be called before routes are registered (GET /x is)",
		)
		expect(() => honey<{}>().routeTree(STATIC()).routeTree(STATIC())).toThrow(
			"routeTree() was already called on this app",
		)
		const old = { meta: {}, root: { ...createNode(), m: { GET: { fn: null } } }, routes: {} } as unknown as RouteTree
		expect(() => honey<{}>().routeTree(old)).toThrow("Run `honey generate`")
		const orphan = createNode()
		insertRoute(orphan, "GET", "/x")
		expect(() => honey<{}>().routeTree({ meta: {}, root: orphan, routes: {} })).toThrow(
			"routeTree(): leaf GET /x has no route entry",
		)
	})

	it("refuses a tree whose route declares output under a key that names no status", () => {
		const tree = treeOf([["GET", "/o", { out: { "application/json": { orders: z.string() } } as never }]])
		expect(() => honey<{}>().routeTree(tree)).toThrow(
			'GET /o: .output() key "orders" under application/json is none of',
		)
	})
})

describe("toRouteTree(): a snapshot another app serves", () => {
	// v0: 5b0a5d6bda
	// v0: 7b54ed3e26
	// v0: 8c78b7a444
	// v0: 86b79fd22f
	// v0: e4fbd0feca
	// v0: cfefaa8126
	// v0: 38e39d817e
	it("serves every route, status, param, wildcard and pattern exactly as the source does", async () => {
		const live = honey<{}>()
		live.get("/users").handler((c) => c.res.text("ok", "list"))
		live.post("/users").handler((c) => c.res.text("created", "made"))
		live.get("/users/:id").handler((c) => c.res.text("ok", `${c.routePattern} ${c.params.id}`))
		live.delete("/u/:id").handler((c) => c.res.text("ok", `del ${c.params.id}`))
		live.get("/u/me").handler((c) => c.res.text("ok", "me"))
		live.get("/files/*path").handler((c) => c.res.text("ok", `file ${c.params.path}`))
		const loaded = honey<{}>().routeTree(live.toRouteTree())
		for (const app of [live, loaded]) {
			expect([
				await call(app, "/users"),
				await call(app, "/users", { method: "POST" }),
				await call(app, "/users/:id"),
				await call(app, "/u/me", { method: "DELETE" }),
				await call(app, "/files/a/b.txt"),
				(await call(app, "/nope"))[0],
			]).toEqual([[200, "list"], [201, "made"], [200, "/users/:id :id"], [200, "del me"], [200, "file a/b.txt"], 404])
		}
	})
})

describe("toRouteTree(): what a snapshot holds", () => {
	// v0: 953ed12238
	it("is a copy: changing it changes nothing in the app, and it records each route's data and live record", () => {
		const errors = defineErrors({ gone: "gone" })
		const app = honey<{}>().errorFactory(errors)
		app
			.get("/a")
			.meta({ summary: "A" })
			.errors("gone")
			.boundary("gone")
			.handler((c) => c.res.text("ok", "a"))
		const snap = app.toRouteTree()
		snap.root.s.a = createNode()
		const { h, ...data } = app.toRouteTree().routes["GET /a"] as RouteEntry
		expect([app.toRouteTree().root.s.a?.m, data, h?.id]).toEqual([
			{ GET: "GET /a" },
			{ bek: "gone", ek: ["gone"], es: { gone: "gone" }, iv: null, mt: { summary: "A" }, out: null },
			"GET /a",
		])
	})

	// v0: 295881875c
	// v0: fbdb1481f5
	it("carries the scoped middleware covering a route, and guards a re-registered route like the source", async () => {
		const deny = createMiddleware<{ req: Request }>(async (ctx, next) =>
			ctx.req.headers.get("authorization") === "ok" ? next() : new Response("no", { status: 401 }),
		)
		const build = (tree?: RouteTree) => {
			const app = honey<{}>()
			if (tree !== undefined) app.routeTree(tree)
			app.use("/admin", deny)
			app.get("/admin/x").handler((c) => c.res.text("ok", c.routePattern))
			return app
		}
		const carried = honey<{}>().routeTree(build().toRouteTree())
		for (const app of [build(), build(build().toRouteTree()), carried]) {
			expect([
				(await call(app, "/admin/x"))[0],
				await call(app, "/admin/x", { headers: { authorization: "ok" } }),
			]).toEqual([401, [200, "/admin/x"]])
		}
	})
})

describe("toRouteTree(): what a snapshot knows of errors", () => {
	it("records each declared key's status key, from the factory the route named, a middleware's own or its app's, and keeps it as data in a gateway's tree", () => {
		const named = defineErrors({ teapot: { schema: z.object({ brew: z.string() }), status: "bad_request" } })
		const app = honey<{}>().errorFactory(defineErrors({ column_name_taken: "conflict" }))
		const audited = defineMiddleware({
			errors: [defineErrors({ audit_failed: "bad_gateway" }), "audit_failed"],
			fn: async (_c, next) => next(),
		})
		app
			.post("/columns")
			.use(audited)
			.errors("column_name_taken")
			.handler((c) => c.res.text("ok", "c"))
		/* timeout() declares its key with no factory: the key is recorded, its status is not */
		app
			.get("/tea")
			.use(timeout({ duration: 1000 }))
			.errors(named, "teapot")
			.handler((c) => c.res.text("ok", "t"))
		app.get("/open").handler((c) => c.res.text("ok", "o"))
		const snap = app.toRouteTree()
		const gateway = honey<{}>()
		gateway.all("/*").handler((c) => c.res.text("ok", "proxy"))
		const served = gatewayTree(gateway, snap)
		expect([
			snap.routes["POST /columns"]?.es,
			snap.routes["GET /tea"]?.es,
			snap.routes["GET /open"]?.es,
			snap.routes["GET /tea"]?.ek,
			served.routes["POST /columns"],
		]).toEqual([
			{ audit_failed: "bad_gateway", column_name_taken: "conflict" },
			{ teapot: "bad_request" },
			undefined,
			["request_timeout", "teapot"],
			expect.objectContaining({
				ek: ["audit_failed", "column_name_taken"],
				es: { audit_failed: "bad_gateway", column_name_taken: "conflict" },
			}),
		])
	})
})

describe("toRouteTree(): loading a snapshot beside registrations", () => {
	// v0: 2925cec087
	// v0: 0b67c3421d
	// v0: 0eb29e082c
	// v0: f001baa200
	// v0: 07e1febb41
	// v0: 0c2f68e8cc
	// v0: 589f759aaa
	it("lets a registration replace a snapshot's route, serves through an earlier use() handle, and keeps an SPA fallback", async () => {
		const errors = defineErrors({ item_not_found: "not_found" })
		const source = honey<{}>().errorFactory(errors)
		source
			.get("/items/:id")
			.errors("item_not_found")
			.handler((c) => c.res.text("ok", "v1"))
		source.get("/*path").handler((c) => c.res.text("ok", `spa ${c.params.path}`))
		const app = honey<{}>().errorFactory(errors)
		const child = app.use(createMiddleware(async (_ctx, next) => next()))
		app.routeTree(source.toRouteTree())
		app
			.get("/items/:id")
			.errors("item_not_found")
			.handler((c) => {
				throw c.errors.item_not_found()
			})
		expect([
			await call(child, "/some/page"),
			(await call(app, "/items/1"))[0],
			(await call(app, "/some/page", { method: "HEAD" }))[0],
		]).toEqual([[200, "spa some/page"], 404, 200])
	})

	// v0: 6b3f8bc280
	it("a middleware's context addition reaches a route bound to a loaded leaf", async () => {
		const app = honey<{}>()
		app.routeTree(STATIC())
		app
			.use(createMiddleware(async (_ctx, next) => next({ db: "connected" })))
			.get("/orgs")
			.handler((c) => c.res.text("ok", c.db))
		expect(await call(app, "/orgs")).toEqual([200, "connected"])
	})
})

/** A one-route app per entry: [method, path, answer status, body]. */
function apps(...routes: readonly (readonly ["GET" | "POST", string, "ok" | "created", string])[]) {
	return routes.map(([method, path, status, body]) => {
		const app = honey<{}>()
		app.on([method], path).handler((c) => c.res.text(status, body))
		return app
	})
}

describe("mergeTree of snapshots: one app serving several", () => {
	// v0: 9fed2e3c95
	// v0: d586d2d1ad
	// v0: e17e181fbb
	// v0: d0c6553a65
	// v0: f2b6580525
	// v0: 353ce2b379
	// v0: d65a10e773
	// v0: ad44f238f5
	it("serves each source's routes with its own behavior, methods sharing a path included", async () => {
		const sources = apps(
			["GET", "/users", "ok", "users"],
			["POST", "/users", "created", "made"],
			["GET", "/files/*p", "ok", "file"],
			["POST", "/files/*p", "created", "up"],
		)
		const app = honey<{}>().routeTree(mergeTree(...sources.map((source) => source.toRouteTree())))
		expect([
			await call(app, "/users"),
			await call(app, "/users", { method: "POST" }),
			await call(app, "/files/a"),
			await call(app, "/files/a", { method: "POST" }),
			(await call(app, "/posts"))[0],
		]).toEqual([[200, "users"], [201, "made"], [200, "file"], [201, "up"], 404])
	})

	// v0: 45c989439c
	// v0: 514a52588d
	// v0: be39cb4e06
	// v0: 7cc46f169f
	it("refuses a route two sources both serve, and two names for one param or wildcard", () => {
		const merge = (a: string, b: string) => () =>
			mergeTree(...apps(["GET", a, "ok", "a"], ["GET", b, "ok", "b"]).map((app) => app.toRouteTree()))
		expect(merge("/api", "/api")).toThrow("Merge conflict: duplicate GET /api")
		expect(merge("/u/:userId", "/u/:id")).toThrow("param name mismatch")
		expect(merge("/f/*path", "/f/*file")).toThrow("wildcard name mismatch")
	})
})
