import { describe, expect, it } from "vitest"
import { generateRouteTreeFromApp } from "../../../src/codegen.ts"
import { createMiddleware, honey } from "../../../src/index.ts"
import { canonical, normalizePattern, parsePattern } from "../../../src/pattern.ts"
import type { RouteTree } from "../../../src/tree.ts"
import type { WSHandler } from "../../../src/ws/cloudflare.ts"

/** Upgrades without a socket — enough to see the route was chosen (101). */
function testWsAdapter() {
	return {
		upgrade(_req: Request, _env: unknown, _handler: WSHandler<unknown>) {
			return {
				response: new Response(null, { status: 200, headers: { "x-upgraded": "1" } }),
				socket: { close() {}, raw: { close() {}, readyState: 3, send() {} }, readyState: 3 as const, send() {} },
			}
		},
	}
}

async function evalTree(code: string): Promise<RouteTree> {
	const { transform } = await import("esbuild")
	const { code: js } = await transform(code, { format: "esm", loader: "ts", target: "esnext" })
	return (
		(await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as { routeTree: RouteTree }
	).routeTree
}

const get = (app: { fetch(r: Request, e: object): Response | Promise<Response> }, path: string, method = "GET") =>
	app.fetch(new Request(`http://x${path}`, { method }), {})

describe("pattern grammar", () => {
	it("canonicalizes slashes", () => {
		expect(normalizePattern("admin/x")).toBe("/admin/x")
		expect(normalizePattern("//admin//b/")).toBe("/admin/b")
		expect(normalizePattern("/")).toBe("/")
		expect(normalizePattern("")).toBe("/")
		expect(normalizePattern("/files/*")).toBe("/files/*")
		expect(normalizePattern("/opt/:id?")).toBe("/opt/:id?")
		expect(canonical(parsePattern("/u/:user-id"))).toBe("/u/:user-id")
	})

	it("rejects what it cannot express", () => {
		expect(() => parsePattern("/f/:name.json")).toThrow(/not a valid name/)
		expect(() => parsePattern("/a/*rest/b")).toThrow(/last segment/)
		expect(() => parsePattern("/a/:id?/b")).toThrow(/optional parameter must be the last/)
		expect(() => parsePattern("/a/../b")).toThrow(/"\.\." segments/)
		expect(() => parsePattern("/a/:id/b/:id")).toThrow(/appears twice/)
		expect(() => parsePattern("/items?x=1")).toThrow(/query strings/)
		expect(() => honey().get("/f/:name.json")).toThrow(/Invalid route pattern/)
	})
})

describe("route and scope strings are normalized like the tree", () => {
	const auth = createMiddleware(async (ctx, next) =>
		ctx.req.headers.get("authorization") === "ok" ? next() : new Response("no", { status: 401 }),
	)

	it.each([
		["/api/", "/admin/x"],
		["api", "/admin/x"],
		["/api", "admin/x"],
		["/api", "//admin/x"],
	])("basePath(%j) + get(%j) is guarded by a root scope on /api/admin", async (base, route) => {
		const root = honey()
		root.use("/api/admin", auth)
		root
			.basePath(base)
			.get(route)
			.handler((c) => c.res.json("ok", { pattern: c.routePattern }))
		expect((await get(root, "/api/admin/x")).status).toBe(401)
		const ok = await root.fetch(new Request("http://x/api/admin/x", { headers: { authorization: "ok" } }), {})
		expect(await ok.json()).toEqual({ pattern: "/api/admin/x" })
	})
})

describe("generated trees round-trip every pattern shape", () => {
	it("boots from its own generated tree with optional params, wildcards and trailing slashes", async () => {
		const register = (app: ReturnType<typeof honey>) => {
			app.get("/opt/:id?").handler((c) => c.res.text("ok", `opt ${c.params.id ?? "-"}`))
			app.get("/files/*").handler((c) => c.res.text("ok", `files ${c.params["*"]}`))
			app.get("/users/").handler((c) => c.res.text("ok", "users"))
			app.get("/a/:id/:b?").handler((c) => c.res.text("ok", `a ${c.params.id} ${c.params.b ?? "-"}`))
			app.get("/constructor/toString").handler((c) => c.res.text("ok", "proto-named"))
			return app
		}
		const live = register(honey())
		const tree = await evalTree(generateRouteTreeFromApp(live))
		const app = register(honey().routeTree(tree))
		for (const [path, body] of [
			["/opt", "opt -"],
			["/opt/7", "opt 7"],
			["/files/a/b", "files a/b"],
			["/users", "users"],
			["/a/1", "a 1 -"],
			["/a/1/2", "a 1 2"],
			["/constructor/toString", "proto-named"],
		]) {
			expect(await (await get(app, path)).text()).toBe(body)
			expect(await (await get(live, path)).text()).toBe(body)
		}
	})

	it("a literal :id in the request is a param value, not a static hit", async () => {
		const app = honey()
		app.get("/users/:id").handler((c) => c.res.json("ok", { id: c.params.id }))
		const loaded = honey().routeTree(app.toRouteTree())
		for (const a of [app, loaded]) {
			expect(await (await get(a, "/users/:id")).json()).toEqual({ id: ":id" })
		}
	})

	it("the loaded module stays untouched when one app adds internal and websocket routes", async () => {
		const live = honey()
		live.get("/chat").handler((c) => c.res.text("ok", "chat"))
		live.get("/health").handler((c) => c.res.text("ok", "health"))
		const tree = await evalTree(generateRouteTreeFromApp(live))
		const a = honey().routeTree(tree).wsAdapter(testWsAdapter())
		a.get("/chat").handler((c) => c.res.text("ok", "chat"))
		a.get("/health").handler((c) => c.res.text("ok", "health"))
		a.openapi({ title: "T", version: "1" })
		const b = honey().routeTree(tree)
		b.get("/chat").handler((c) => c.res.text("ok", "chat"))
		b.get("/health").handler((c) => c.res.text("ok", "health"))
		expect((await get(a, "/openapi.json")).status).toBe(200)
		expect((await get(b, "/openapi.json")).status).toBe(404)
		expect((await get(b, "/health/openapi.json")).status).toBe(404)
		expect(Object.keys(tree.root.s).sort()).toEqual(["chat", "health"])
	})
})

describe("mounting copies records and nodes", () => {
	it("two parents mounting one sub keep their own scoped middleware", async () => {
		const deny = createMiddleware(async () => new Response("denied", { status: 403 }))
		const sub = honey()
		sub.get("/api/users").handler((c) => c.res.text("ok", "users"))
		const p1 = honey()
		p1.use("/api/admin", deny)
		p1.route(sub)
		const p2 = honey()
		p2.route(sub)
		p1.get("/api/admin").handler((c) => c.res.text("ok", "admin"))
		expect((await get(p1, "/api/admin")).status).toBe(403)
		expect((await get(p2, "/api/admin")).status).toBe(404)
		expect((await get(sub, "/api/admin")).status).toBe(404)
	})

	it("routes the sub registers after mounting stay its own", async () => {
		const sub = honey()
		sub.get("/a").handler((c) => c.res.text("ok", "a"))
		const parent = honey().route(sub)
		sub.get("/b").handler((c) => c.res.text("ok", "b"))
		expect((await get(parent, "/a")).status).toBe(200)
		expect((await get(parent, "/b")).status).toBe(404)
		expect((await get(sub, "/b")).status).toBe(200)
	})

	it("route(sub) over a tree generated from the full app binds instead of conflicting", async () => {
		const build = (tree?: RouteTree) => {
			const app = honey()
			if (tree) app.routeTree(tree)
			const sub = honey()
			sub.get("/sub/a").handler((c) => c.res.text("ok", "sub a"))
			app.get("/root").handler((c) => c.res.text("ok", "root"))
			return app.route(sub)
		}
		const app = build(await evalTree(generateRouteTreeFromApp(build())))
		expect(await (await get(app, "/sub/a")).text()).toBe("sub a")
		expect(await (await get(app, "/root")).text()).toBe("root")
	})

	it("a sub-app's internal routes never travel into the parent", async () => {
		const sub = honey()
		sub.get("/items").handler((c) => c.res.json("ok", []))
		sub.openapi({ title: "Sub", version: "1" })
		const parent = honey().route(sub)
		parent.openapi({ title: "Parent", version: "1" })
		const doc = (await (await get(parent, "/openapi.json")).json()) as { info: { title: string } }
		expect(doc.info.title).toBe("Parent")
	})
})

describe("gateway catch-all", () => {
	it("is found by registration, not by matching a literal /* — a root /:slug does not break it", async () => {
		const live = honey()
		live
			.get("/svc/x")
			.meta({ worker: "svc" })
			.handler((c) => c.res.text("ok", "remote"))
		live.get("/:slug").handler((c) => c.res.text("ok", "slug"))
		const gw = honey().routeTree(stripLive(live.toRouteTree()))
		gw.get("/:slug").handler((c) => c.res.text("ok", `slug ${c.params.slug}`))
		gw.all("/*").handler((c) => c.res.json("ok", { meta: c.meta }))
		expect(await (await get(gw, "/about")).text()).toBe("slug about")
		expect(await (await get(gw, "/svc/x")).json()).toEqual({ meta: { worker: "svc" } })
	})
})

describe("websocket routes share the grammar and backtracking", () => {
	it("a static ws branch that dead-ends falls back to the param branch", async () => {
		const app = honey().wsAdapter(testWsAdapter())
		app.ws("/rooms/lobby/info").handler({})
		app.ws("/rooms/:id/live").handler({})
		const res = await app.fetch(new Request("http://x/rooms/lobby/live", { headers: { upgrade: "websocket" } }), {})
		expect(res.headers.get("x-upgraded")).toBe("1")
	})

	it("a realtime route no longer shadows an HTTP route on the same path", async () => {
		const app = honey().wsAdapter(testWsAdapter())
		app.realtime("/live", { handler: () => {} })
		app.get("/live").handler((c) => c.res.text("ok", "http"))
		expect(await (await get(app, "/live")).text()).toBe("http")
		const other = honey().wsAdapter(testWsAdapter())
		other.realtime("/live", { handler: () => {} })
		expect((await get(other, "/live")).status).toBe(426)
	})
})

/** A generated-style copy of a snapshot: same topology and data, no live records. */
function stripLive(tree: RouteTree): RouteTree {
	const routes: RouteTree["routes"] = {}
	for (const [id, entry] of Object.entries(tree.routes)) routes[id] = { bek: entry.bek, ek: entry.ek, mt: entry.mt }
	return { ...tree, routes }
}
