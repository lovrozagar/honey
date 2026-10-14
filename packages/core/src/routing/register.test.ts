import { describe, expect, it } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { createMiddleware, defineMiddleware, type RuntimeMiddleware } from "../middleware/middleware.ts"
import { GRAPH, honey } from "./app.ts"
import { parsePattern } from "./pattern.ts"
import {
	addChain,
	addRoute,
	assertNothingDiscarded,
	chainErrorKeys,
	createGraph,
	markUsed,
	mount,
	ROOT_VIEW,
	type RouteSource,
} from "./register.ts"

const get = <E>(app: { fetch: (r: Request, env: E) => Response | Promise<Response> }, path: string) =>
	app.fetch(new Request(`http://h${path}`), {} as E)
const pass: RuntimeMiddleware = (_ctx, next) => next()
const auditMw = function audit() {} as unknown as RuntimeMiddleware

function makeSub() {
	const sub = honey()
	sub.get("/users").handler((c) => c.res.json("ok", { rp: c.routePattern }))
	return sub
}

function source(): RouteSource {
	return {
		cm: [],
		cv: null,
		dk: new Set(),
		fn: () => new Response("x"),
		own: createGraph().settings,
		rb: null,
		rm: [],
		xm: null,
	}
}

describe("route(sub) applies the mounting handle's basePath", () => {
	// v0: dccba08be1
	it("serves the sub under the basePath, not at its own path", async () => {
		const app = honey()
		app.basePath("/v1").route(makeSub())
		expect((await get(app, "/users")).status).toBe(404)
		const res = await get(app, "/v1/users")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ rp: "/v1/users" })
	})

	// v0: 4fb2a147db
	it("composes with the sub's own basePath", async () => {
		const sub = honey().basePath("/admin")
		sub.get("/x").handler((c) => c.res.json("ok", {}))
		const app = honey()
		app.basePath("/v1").route(sub)
		expect((await get(app, "/v1/admin/x")).status).toBe(200)
		expect((await get(app, "/admin/x")).status).toBe(404)
	})

	// v0: a8d598ea9a
	it("route(prefix, sub) is basePath(prefix).route(sub), including the sub's root route", async () => {
		const sub = honey()
		sub.get("/").handler((c) => c.res.json("ok", {}))
		const app = honey()
		app.route("/v2", sub)
		expect((await get(app, "/v2")).status).toBe(200)
	})
})

describe("route(sub) applies the mounting handle's basePath, scoped and chained", () => {
	// v0: 90392c4dac
	it("mounting without a basePath keeps the sub's paths", async () => {
		const app = honey()
		app.route(makeSub())
		expect((await get(app, "/users")).status).toBe(200)
	})

	// v0: 0147d10cc1
	it("the sub's scoped middleware guards the prefixed paths", async () => {
		const sub = honey()
		sub.use(
			"/secret",
			createMiddleware(async () => {
				throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
			}),
		)
		sub.get("/secret/a").handler((c) => c.res.json("ok", {}))
		sub.get("/open").handler((c) => c.res.json("ok", {}))
		const app = honey()
		app.route("/api", sub)
		expect((await get(app, "/api/secret/a")).status).toBe(403)
		expect((await get(app, "/api/open")).status).toBe(200)
	})

	// v0: 6de3a06f3e
	it("the mounting chain runs on the prefixed routes", async () => {
		const seen: string[] = []
		const app = honey().use(
			createMiddleware(async (c, next) => {
				seen.push((c as { path: string }).path)
				return next()
			}),
		)
		app.basePath("/v1").route(makeSub())
		await get(app, "/v1/users")
		expect(seen).toEqual(["/v1/users"])
	})

	// v0: 4bb887656f
	it("route(prefix) without a sub throws", () => {
		expect(() => (honey() as unknown as { route: (p: string) => unknown }).route("/x")).toThrow(/needs the sub-app/)
	})
})

describe(".route() merges sub-router tree into parent", () => {
	// v0: 68ed5d6d3a
	it("sub-router routes accessible on parent after .route()", async () => {
		const sub = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "from-sub"))
		const app = honey<{}>()
			.get("/main")
			.handler((ctx) => ctx.res.text("ok", "from-main"))
			.route(sub)
		expect(await (await get(app, "/main")).text()).toBe("from-main")
		expect(await (await get(app, "/health")).text()).toBe("from-sub")
	})

	// v0: 98e0f243fd
	it("multiple .route() calls merge all sub-routers", async () => {
		const auth = honey<{}>()
			.get("/login")
			.handler((ctx) => ctx.res.text("ok", "login"))
		const users = honey<{}>()
			.get("/users")
			.handler((ctx) => ctx.res.text("ok", "users"))
		const app = honey<{}>()
			.get("/")
			.handler((ctx) => ctx.res.text("ok", "root"))
			.route(auth)
			.route(users)
		expect((await get(app, "/")).status).toBe(200)
		expect(await (await get(app, "/login")).text()).toBe("login")
		expect(await (await get(app, "/users")).text()).toBe("users")
	})

	// v0: 7a10e3def8
	it("sub-router with params merges correctly", async () => {
		const sub = honey<{}>()
			.get("/orgs/:orgId")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.orgId }))
		const res = await get(honey<{}>().route(sub), "/orgs/o-1")
		expect(await res.json()).toEqual({ id: "o-1" })
	})
})

describe(".route() merges sub-router tree into parent: conflicts and middleware", () => {
	// v0: 97f2d31012
	it("duplicate route across parent and sub → throws on merge", () => {
		const sub = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "sub"))
		const app = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "parent"))
		expect(() => app.route(sub)).toThrow(/conflict|duplicate/i)
	})

	// v0: 93450d5123
	it("sub-router middleware runs for sub routes", async () => {
		let mwCalled = false
		const mw = createMiddleware(async (_ctx, next) => {
			mwCalled = true
			return next()
		})
		const sub = honey<{}>()
			.use(mw)
			.get("/guarded")
			.handler((ctx) => ctx.res.text("ok", "guarded"))
		const app = honey<{}>()
			.get("/public")
			.handler((ctx) => ctx.res.text("ok", "public"))
			.route(sub)
		await get(app, "/public")
		expect(mwCalled).toBe(false)
		await get(app, "/guarded")
		expect(mwCalled).toBe(true)
	})
})

describe("the graph", () => {
	it("addRoute gives each record its id and pattern, places an optional param's two leaves, refuses a duplicate", () => {
		const g = createGraph()
		const id = addRoute(g, "GET", parsePattern("/u/:id?"), source())
		expect(id).toBe("GET /u/:id?")
		expect(g.records.get(id)).toMatchObject({ id, mt: null, rp: "/u/:id?" })
		expect(g.epoch).toBe(1)
		expect(() => addRoute(g, "GET", parsePattern("/u/:id?"), source())).toThrow("Duplicate route: GET /u/:id?")
	})

	it("markUsed marks a chain node and its ancestors; a root view has none", () => {
		const g = createGraph()
		const parent = addChain(g, null, pass)
		const child = addChain(g, parent, pass)
		markUsed(child)
		expect([parent.used, child.used]).toEqual([true, true])
		markUsed(ROOT_VIEW.node)
		expect(Object.isFrozen(ROOT_VIEW)).toBe(true)
	})

	it("assertNothingDiscarded names the unused use() and every dangling builder", () => {
		const g = createGraph()
		addChain(g, null, auditMw)
		g.pending.add({ id: "GET /a" })
		expect(() => assertNothingDiscarded(g)).toThrow(/app\.use\("audit"\)[\s\S]*GET \/a was declared/)
	})
})

describe("the graph: mounting", () => {
	it("mounting a graph into itself changes nothing; a scope already brought is not added twice", () => {
		const app = honey()
		const g = app[GRAPH]
		mount(g, ROOT_VIEW, g)
		expect(g.epoch).toBe(0)
		const sub = honey()
		sub.use("/s", pass as never)
		sub.get("/s/x").handler((c) => c.res.text("ok", "x"))
		mount(g, ROOT_VIEW, sub[GRAPH])
		expect(() => mount(g, ROOT_VIEW, sub[GRAPH])).toThrow(/Duplicate route/)
		expect(g.scoped).toHaveLength(1)
		const scopesOnly = honey()
		scopesOnly.use("/t", pass as never)
		mount(g, ROOT_VIEW, scopesOnly[GRAPH])
		mount(g, ROOT_VIEW, scopesOnly[GRAPH])
		expect(g.scoped.map((e) => e.prefix)).toEqual(["/s", "/t"])
	})

	it("a mounted record keeps the sub's context values and meta under the mounting handle's", async () => {
		const sub = honey().context({ a: "sub", b: "sub" })
		sub
			.meta({ tier: 2 })
			.get("/x")
			.handler((c) => c.res.json("ok", { a: c.a, b: c.b, meta: c.meta }))
		const app = honey().context({ a: "app", c: "app" })
		app.meta({ owner: "app", tier: 1 }).route(sub as never)
		expect(await (await get(app, "/x")).json()).toEqual({ a: "sub", b: "sub", meta: { owner: "app", tier: 2 } })
	})

	it("chainErrorKeys lists the keys a chain declares, in run order", () => {
		const factory = { a: () => null, b: () => null }
		const first = defineMiddleware({ errors: [factory, "b"], fn: (_c, next) => next() }) as unknown as RuntimeMiddleware
		const second = defineMiddleware({
			errors: [factory, "a"],
			fn: (_c, next) => next(),
		}) as unknown as RuntimeMiddleware
		expect(chainErrorKeys([first, pass, second])).toEqual(["b", "a"])
	})
})
