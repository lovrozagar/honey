import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { generateRouteTreeFromApp } from "../../../src/codegen.ts"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"
import { testClient } from "../../../src/testing.ts"
import type { RouteHandler, RouteTree } from "../../../src/tree.ts"
import { createNode, insertRoute } from "../../../src/tree.ts"

/* ---- helpers ---- */

function buildStaticTree(): RouteTree {
	const root = createNode()

	const H0: RouteHandler = {
		bek: null,
		ef: null,
		ek: new Set(["not_found"]),
		fn: null as unknown as RouteHandler["fn"],
		iv: null,
		mt: { auth: "required", rateLimit: "strict" },
		mw: [],
		os: null,
		ov: null,
		rp: "",
	}
	const H1: RouteHandler = {
		bek: null,
		ef: null,
		ek: new Set(),
		fn: null as unknown as RouteHandler["fn"],
		iv: null,
		mt: { auth: "required" },
		mw: [],
		os: null,
		ov: null,
		rp: "",
	}
	const H2: RouteHandler = {
		bek: null,
		ef: null,
		ek: new Set(),
		fn: null as unknown as RouteHandler["fn"],
		iv: null,
		mt: null,
		mw: [],
		os: null,
		ov: null,
		rp: "",
	}

	insertRoute(root, "GET", "/orgs", H0)
	insertRoute(root, "POST", "/orgs", H1)
	insertRoute(root, "GET", "/health", H2)

	return {
		handlers: {
			"GET /health": H2,
			"GET /orgs": H0,
			"POST /orgs": H1,
		},
		meta: {},
		root,
	}
}

/* ---- .routeTree() patching ---- */

describe(".routeTree() patch mode", () => {
	it("patches handler fn into pre-built tree", async () => {
		const staticTree = buildStaticTree()

		const app = honey<{}>()
			.routeTree(staticTree)
			.get("/orgs")
			.handler((c) => c.res.text("ok", "orgs-list"))
			.post("/orgs")
			.handler((c) => c.res.text("ok", "orgs-create"))
			.get("/health")
			.handler((c) => c.res.text("ok", "ok"))

		const client = testClient(app, { env: {} })

		const res1 = await client.get("/orgs")
		expect(res1.status).toBe(200)
		expect(await res1.text()).toBe("orgs-list")

		const res2 = await client.post("/orgs")
		expect(res2.status).toBe(200)
		expect(await res2.text()).toBe("orgs-create")

		const res3 = await client.get("/health")
		expect(res3.status).toBe(200)
		expect(await res3.text()).toBe("ok")
	})

	it("preserves pre-built ek from static tree", async () => {
		const staticTree = buildStaticTree()

		honey<{}>()
			.routeTree(staticTree)
			.get("/orgs")
			.handler((c) => c.res.text("ok", "ok"))

		/* pre-built handler retains ek from static tree */
		const handler = staticTree.handlers?.["GET /orgs"]
		expect(handler?.ek).toEqual(new Set(["not_found"]))
	})

	it("preserves pre-built mt from static tree", async () => {
		const staticTree = buildStaticTree()

		honey<{}>()
			.routeTree(staticTree)
			.get("/orgs")
			.handler((c) => c.res.text("ok", "ok"))

		const handler = staticTree.handlers?.["GET /orgs"]
		expect(handler?.mt).toEqual({ auth: "required", rateLimit: "strict" })
	})

	it("patches mw from builder chain", async () => {
		const staticTree = buildStaticTree()

		const withDb = createMiddleware(async (_ctx, next) => next({ db: "connected" }))

		const app = honey<{}>()
			.routeTree(staticTree)
			.use(withDb)
			.get("/orgs")
			.handler((c) => c.res.text("ok", "ok"))

		const handler = staticTree.handlers?.["GET /orgs"]
		expect(handler?.mw.length).toBe(1)

		const client = testClient(app, { env: {} })
		const res = await client.get("/orgs")
		expect(res.status).toBe(200)
	})

	it("falls through to insertRoute for unknown routes", async () => {
		const staticTree = buildStaticTree()

		const app = honey<{}>()
			.routeTree(staticTree)
			.get("/orgs")
			.handler((c) => c.res.text("ok", "orgs"))
			.get("/new-route")
			.handler((c) => c.res.text("ok", "new"))

		const client = testClient(app, { env: {} })

		const res1 = await client.get("/orgs")
		expect(res1.status).toBe(200)
		expect(await res1.text()).toBe("orgs")

		const res2 = await client.get("/new-route")
		expect(res2.status).toBe(200)
		expect(await res2.text()).toBe("new")
	})

	it("works with input schemas via patching", async () => {
		const staticTree = buildStaticTree()

		const app = honey<{}>()
			.routeTree(staticTree)
			.get("/orgs")
			.input({ search: z.object({ limit: z.coerce.number() }) })
			.handler((c) => c.res.json("ok", { limit: c.input.search.limit }))

		const client = testClient(app, { env: {} })
		const res = await client.get("/orgs?limit=10")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { limit: number }
		expect(body.limit).toBe(10)
	})
})

/* ---- pre-filtered error factory ---- */

describe(".routeTree() pre-filtered error factory", () => {
	it("pre-computes ef on handler at patch time", () => {
		const staticTree = buildStaticTree()

		const errors = defineErrors({ not_found: "not_found" })

		honey<{}>()
			.errorFactory(errors)
			.routeTree(staticTree)
			.get("/orgs")
			.handler((c) => c.res.text("ok", "ok"))

		const handler = staticTree.handlers?.["GET /orgs"]
		expect(handler?.ef).not.toBeNull()
		expect(handler?.ef?.not_found).toBeDefined()
		expect(Object.isFrozen(handler?.ef)).toBe(true)
	})

	it("ctx.errors uses pre-filtered ef from handler", async () => {
		const staticTree = buildStaticTree()

		const errors = defineErrors({ not_found: "not_found" })

		const app = honey<{}>()
			.errorFactory(errors)
			.routeTree(staticTree)
			.get("/orgs")
			.errors("not_found")
			.handler((c) => {
				throw c.errors.not_found()
			})

		const client = testClient(app, { env: {} })
		const res = await client.get("/orgs")
		expect(res.status).toBe(404)
	})

	it("ef is null when no error factory registered", () => {
		const staticTree = buildStaticTree()

		honey<{}>()
			.routeTree(staticTree)
			.get("/health")
			.handler((c) => c.res.text("ok", "ok"))

		const handler = staticTree.handlers?.["GET /health"]
		expect(handler?.ef).toBeNull()
	})
})

/* ---- codegen emits handler map ---- */

describe("codegen emits handler map and routeTree", () => {
	it("emits handlers export with METHOD /path keys", () => {
		const app = honey<{}>()
			.get("/orgs")
			.handler((c) => c.res.text("ok", "ok"))
			.post("/orgs")
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)

		expect(code).toContain("export const handlers")
		expect(code).toContain('"GET /orgs"')
		expect(code).toContain('"POST /orgs"')
	})

	it("emits routeTree convenience export", () => {
		const app = honey<{}>()
			.get("/health")
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)

		expect(code).toContain("export const routeTree: RouteTree")
		expect(code).toContain("root: tree")
		expect(code).toContain("handlers")
	})

	it("emits unique handler per route (no dedup)", () => {
		const app = honey<{}>()
			.get("/a")
			.handler((c) => c.res.text("ok", "a"))
			.get("/b")
			.handler((c) => c.res.text("ok", "b"))

		const code = generateRouteTreeFromApp(app)

		expect(code).toContain("const H0: RouteHandler")
		expect(code).toContain("const H1: RouteHandler")
	})

	it("emits pre-built ek in handler constants", () => {
		const errors = defineErrors({ email_taken: "conflict" })

		const app = honey<{}>()
			.get("/users")
			.errors(errors, "email_taken")
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)

		expect(code).toContain('new Set(["email_taken"])')
	})

	it("emits pre-built mt in handler constants", () => {
		const app = honey<{}>()
			.meta<{ auth: string }>()
			.get("/orgs")
			.meta({ auth: "required" })
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)

		expect(code).toContain('"auth":"required"')
		/* mt should be inline in the handler constant, not null */
		expect(code).not.toContain("mt: null")
	})

	it("emits ef: null in handler constants", () => {
		const app = honey<{}>()
			.get("/health")
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)

		expect(code).toContain("ef: null")
	})

	it("imports RouteTree type", () => {
		const app = honey<{}>()
			.get("/health")
			.handler((c) => c.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)

		expect(code).toContain("RouteTree")
	})
})

/* ---- .routeTree() with mergeTree (gateway pattern) ---- */

describe(".routeTree() with mergeTree", () => {
	it("works with live handlers from mergeTree", async () => {
		const { mergeTree } = await import("../../../src/tree.ts")

		const app1 = honey<{}>()
		app1.get("/a").handler((ctx) => ctx.res.text("ok", "from-a"))

		const app2 = honey<{}>()
		app2.get("/b").handler((ctx) => ctx.res.text("ok", "from-b"))

		const merged = mergeTree(app1.toRouteTree(), app2.toRouteTree())
		const gateway = honey<{}>().routeTree(merged)

		const client = testClient(gateway, { env: {} })
		const resA = await client.get("/a")
		expect(resA.status).toBe(200)
		expect(await resA.text()).toBe("from-a")

		const resB = await client.get("/b")
		expect(resB.status).toBe(200)
		expect(await resB.text()).toBe("from-b")
	})
})

/* ---- meta typing — .meta<T>() flows to handler ctx ---- */

describe("routeTree meta typing", () => {
	it("ctx.meta is typed when .meta<T>() is set and no route-level .meta()", () => {
		type AppMeta = { auth: string; worker: string }

		honey<{}>()
			.meta<AppMeta>()
			.all("*")
			.handler((ctx) => {
				expectTypeOf(ctx.meta.auth).toEqualTypeOf<string>()
				expectTypeOf(ctx.meta.worker).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("ctx.meta in .proxy() destination is typed from .meta<T>()", () => {
		type AppMeta = { auth: string; worker: string }

		honey<{}>()
			.meta<AppMeta>()
			.all("*")
			.proxy({
				destination: (ctx) => {
					expectTypeOf(ctx.meta.worker).toEqualTypeOf<string>()
					expectTypeOf(ctx.meta.auth).toEqualTypeOf<string>()
					return new Response("ok")
				},
			})
	})

	it("ctx.meta in catch-all after .routeTree() inherits app meta type", () => {
		type AppMeta = { auth: string; worker: string }
		const staticTree = buildStaticTree()

		honey<{}>()
			.meta<AppMeta>()
			.routeTree(staticTree)
			.all("*")
			.handler((ctx) => {
				expectTypeOf(ctx.meta.auth).toEqualTypeOf<string>()
				expectTypeOf(ctx.meta.worker).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("route-level .meta() intersects with app-level meta type", () => {
		type AppMeta = { auth: string }

		honey<{}>()
			.meta<AppMeta>()
			.get("/test")
			.meta({ auth: "jwt" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta.auth).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})
})

/* ---- fn: null fallthrough — gateway proxy pattern ---- */

describe("routeTree fn:null fallthrough", () => {
	it("tree handler with fn:null falls through to catch-all with meta", async () => {
		const staticTree = buildStaticTree()
		/* H0 has mt: { auth: "required", rateLimit: "strict" }, fn: null */

		const app = honey<{}>()
			.routeTree(staticTree)
			.all("*")
			.handler((c) => {
				const meta = (c as Record<string, unknown>)["meta"] as Record<string, unknown>
				return c.res.json("ok", { auth: meta["auth"], rateLimit: meta["rateLimit"] })
			})

		const client = testClient(app, { env: {} })
		const res = await client.get("/orgs")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { auth: string; rateLimit: string }
		expect(body.auth).toBe("required")
		expect(body.rateLimit).toBe("strict")
	})

	it("tree handler with fn:null and no meta falls through without route meta", async () => {
		const staticTree = buildStaticTree()
		/* H2 (/health) has mt: null, fn: null */

		const app = honey<{}>()
			.routeTree(staticTree)
			.all("*")
			.handler((c) => {
				const meta = (c as Record<string, unknown>)["meta"] as Record<string, unknown> | undefined
				return c.res.json("ok", { hasWorker: meta?.["worker"] !== undefined })
			})

		const client = testClient(app, { env: {} })
		const res = await client.get("/health")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { hasWorker: boolean }
		expect(body.hasWorker).toBe(false)
	})

	it("tree handler with real fn dispatches normally (no fallthrough)", async () => {
		const staticTree = buildStaticTree()

		const app = honey<{}>()
			.routeTree(staticTree)
			.get("/orgs")
			.handler((c) => c.res.text("ok", "handled"))
			.all("*")
			.handler((c) => c.res.text("ok", "catch-all"))

		const client = testClient(app, { env: {} })
		const res = await client.get("/orgs")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("handled")
	})

	it("unmatched route (not in tree, no catch-all) returns 404", async () => {
		const staticTree = buildStaticTree()

		const app = honey<{}>().routeTree(staticTree)

		const client = testClient(app, { env: {} })
		const res = await client.get("/unknown")
		expect(res.status).toBe(404)
	})

	it("unmatched route returns 404 even with catch-all when routeTree loaded", async () => {
		const staticTree = buildStaticTree()

		const app = honey<{}>()
			.routeTree(staticTree)
			.all("*")
			.handler((c) => c.res.text("ok", "should-not-reach"))

		const client = testClient(app, { env: {} })
		const res = await client.get("/unknown")
		expect(res.status).toBe(404)
	})

	it("wrong method on tree route returns 405 with catch-all present", async () => {
		const staticTree = buildStaticTree()

		const app = honey<{}>()
			.routeTree(staticTree)
			.all("*")
			.handler((c) => c.res.text("ok", "should-not-reach"))

		const client = testClient(app, { env: {} })
		const res = await client.delete("/orgs")
		expect(res.status).toBe(405)
	})

	it("fn:null fallthrough works with proxy", async () => {
		const staticTree = buildStaticTree()

		const app = honey<{}>()
			.routeTree(staticTree)
			.all("*")
			.proxy({
				destination: (ctx) => {
					const meta = (ctx as Record<string, unknown>)["meta"] as Record<string, unknown>
					return new Response(JSON.stringify({ worker: meta?.["auth"] }))
				},
			})

		const client = testClient(app, { env: {} })
		const res = await client.get("/orgs")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { worker: string }
		expect(body.worker).toBe("required")
	})

	it("middleware runs before fn:null fallthrough handler", async () => {
		const staticTree = buildStaticTree()

		const withToken = createMiddleware(async (_ctx, next) => next({ token: "abc" }))

		const app = honey<{}>()
			.routeTree(staticTree)
			.use(withToken)
			.all("*")
			.handler((c) => {
				const meta = (c as Record<string, unknown>)["meta"] as Record<string, unknown>
				return c.res.json("ok", { auth: meta?.["auth"], token: c.token })
			})

		const client = testClient(app, { env: {} })
		const res = await client.get("/orgs")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { auth: string; token: string }
		expect(body.auth).toBe("required")
		expect(body.token).toBe("abc")
	})

	it("params from tree match are available in fallthrough handler", async () => {
		const root = createNode()
		const H: RouteHandler = {
			bek: null,
			ef: null,
			ek: new Set<string>(),
			fn: null as unknown as RouteHandler["fn"],
			iv: null,
			mt: { worker: "users" },
			mw: [],
			os: null,
			ov: null,
			rp: "",
		}
		insertRoute(root, "GET", "/users/:id", H)
		const tree: RouteTree = { handlers: { "GET /users/:id": H }, meta: {}, root }

		const app = honey<{}>()
			.routeTree(tree)
			.all("*")
			.handler((c) => {
				const meta = (c as Record<string, unknown>)["meta"] as Record<string, unknown>
				return c.res.json("ok", { id: c.params["id"], worker: meta["worker"] })
			})

		const client = testClient(app, { env: {} })
		const res = await client.get("/users/42")
		expect(res.status).toBe(200)
		const body = (await res.json()) as { id: string; worker: string }
		expect(body.id).toBe("42")
		expect(body.worker).toBe("users")
	})
})
