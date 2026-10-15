import { describe, expect, expectTypeOf, it } from "vitest"
import { createMiddleware } from "../middleware/middleware.ts"
import { proxy } from "../proxy/proxy.ts"
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { honey } from "./app.ts"
import { createNode, insertRoute, insertWsRoute, type RouteEntry, type RouteTree } from "./tree.ts"

function treeOf(routes: readonly (readonly [string, string, RouteEntry?])[]): RouteTree {
	const root = createNode()
	const entries: Record<string, RouteEntry> = {}
	for (const [method, path, entry] of routes) entries[insertRoute(root, method as "GET", path)] = entry ?? {}
	return { meta: {}, root, routes: entries, v: 2 }
}

type Fetcher = { fetch: (request: Request, env: {}) => Response | Promise<Response> }

async function call(app: Fetcher, path: string, init?: RequestInit): Promise<[number, string]> {
	const res = await app.fetch(new Request(`http://x${path}`, init), {})
	return [res.status, await res.text()]
}

/** A gateway serving `tree` through a catch-all that answers with what it was delegated. */
function gateway(tree: RouteTree) {
	const app = honey<{}>().routeTree(tree)
	app.all("/*").handler((c) => c.res.json("ok", { meta: c.meta, params: c.params, pattern: c.routePattern }))
	return app
}

const TREE = () =>
	treeOf([
		["GET", "/orgs", { mt: { auth: "required" } }],
		["GET", "/health"],
		["GET", "/users/:id", { mt: { worker: "users" } }],
	])

describe("delegation: a leaf nothing serves goes to the app's catch-all", () => {
	// v0: 7701c5fa63
	// v0: 869ac2591d
	// v0: c722aca93d
	// v0: e5f4964230
	it("runs the catch-all with the leaf's own meta, pattern and params; a leaf without meta has none", async () => {
		const app = gateway(TREE())
		expect([await call(app, "/orgs"), await call(app, "/health"), await call(app, "/users/42")]).toEqual([
			[200, '{"meta":{"auth":"required"},"params":{},"pattern":"/orgs"}'],
			[200, '{"meta":{},"params":{},"pattern":"/health"}'],
			[200, '{"meta":{"worker":"users"},"params":{"id":"42"},"pattern":"/users/:id"}'],
		])
	})

	// v0: a8e03f60b0
	it("a proxy({ destination }) catch-all reads the leaf's meta at runtime", async () => {
		const app = honey<{}>().routeTree(TREE())
		app.all("*").handler(proxy({ destination: (c) => new Response(String(c.meta.auth)) }))
		expect(await call(app, "/orgs")).toEqual([200, "required"])
	})

	// v0: 8196b9bff1
	// v0: 931a464cbb
	// v0: ddc57889a9
	// v0: f499098c4e
	it("lets a local route win, answers 404 off the tree for GET and HEAD, and 405 for a method the leaf lacks", async () => {
		const app = honey<{}>().routeTree(TREE())
		app.get("/orgs").handler((c) => c.res.text("ok", "local"))
		app.all("*").handler((c) => c.res.text("ok", "catch-all"))
		expect([
			await call(app, "/orgs"),
			await call(app, "/health"),
			(await call(app, "/unknown"))[0],
			(await call(app, "/unknown", { method: "HEAD" }))[0],
			(await call(app, "/orgs", { method: "DELETE" }))[0],
			(await call(honey<{}>().routeTree(TREE()), "/unknown"))[0],
		]).toEqual([[200, "local"], [200, "catch-all"], 404, 404, 405, 404])
	})
})

describe("delegation: middleware, scopes, taps and the catch-all itself", () => {
	// v0: 038723d574
	// v0: 452e3079a4
	// v0: 381e76f483
	it("runs middleware first, guards by the leaf's own pattern, and fires taps on the leaf's meta", async () => {
		const seen: unknown[] = []
		const deny = createMiddleware<{ req: Request }>(async (_ctx, next) =>
			_ctx.req.headers.get("authorization") === "ok" ? next() : new Response("no", { status: 401 }),
		)
		const tree = treeOf([
			["GET", "/admin/users", { mt: { audit: "admin" } }],
			["GET", "/public", { mt: { audit: "public" } }],
		])
		const app = honey<{}>().routeTree(tree)
		app.tap("audit", (_ctx, value) => void seen.push(value))
		app.use("/admin", deny)
		app
			.use(createMiddleware(async (_ctx, next) => next({ token: "abc" })))
			.all("/*")
			.handler((c) => c.res.text("ok", c.token))
		expect([(await call(app, "/admin/users"))[0], await call(app, "/public")]).toEqual([401, [200, "abc"]])
		await new Promise((resolve) => setTimeout(resolve, 5))
		expect(seen).toEqual(["public"])
	})

	// v0: 3b4eaa9ff1
	// v0: 2424b76a7f
	it("finds the catch-all by registration, not by a literal /*, and calls a catch-all with nothing to delegate stale", async () => {
		const live = honey<{}>().meta<{ worker?: string }>()
		live
			.get("/svc/x")
			.meta({ worker: "svc" })
			.handler((c) => c.res.text("ok", "remote"))
		live.get("/:slug").handler((c) => c.res.text("ok", "slug"))
		const { routes, ...rest } = live.toRouteTree()
		const generated = {
			...rest,
			routes: Object.fromEntries(Object.entries(routes).map(([id, { h: _h, ...data }]) => [id, data])),
		}
		const gw = honey<{}>().routeTree(generated)
		gw.get("/:slug").handler((c) => c.res.text("ok", `slug ${c.params.slug}`))
		gw.all("/*").handler((c) => c.res.json("ok", c.meta))
		expect([await call(gw, "/about"), await call(gw, "/svc/x")]).toEqual([
			[200, "slug about"],
			[200, '{"worker":"svc"}'],
		])
		const stale = honey<{}>().routeTree(treeOf([["GET", "/a"]]))
		stale.get("/a").handler((c) => c.res.text("ok", "a"))
		stale.all("/*").handler((c) => c.res.text("ok", "spa"))
		expect(() => stale.fetch(new Request("http://x/a"), {})).toThrow(
			"ALL /* is registered but missing from the loaded route tree",
		)
	})
})

const PASS = {
	"~standard": { validate: (value: unknown) => ({ value }), vendor: "t", version: 1 },
} satisfies StandardSchemaLike

/** A proxying gateway over a JSON route, a params-only route and a GET, counting what reaches the destination. */
function proxied() {
	const reached: string[] = []
	const tree = treeOf([
		["POST", "/items", { iv: { json: PASS } }],
		["POST", "/items/:id/restore", { iv: { params: PASS } }],
		["GET", "/items"],
	])
	const app = honey<{}>().routeTree(tree)
	const waiting = createMiddleware<{ req: Request }>(async (ctx, next) =>
		ctx.req.headers.get("x-wait") === "1" ? new Response("waited") : next(),
	)
	app
		.use(waiting)
		.all("/*")
		.handler(
			proxy({
				destination: async (_ctx, url, init) => {
					reached.push(
						`${url} ${init.body === undefined || init.body === null ? "" : await new Response(init.body).text()}`,
					)
					return new Response("proxied")
				},
			}),
		)
	return { app, reached }
}

describe("delegation: a leaf's declared body media type is checked before anything runs", () => {
	// v0: 220d30ae89
	// v0: 039d645295
	// v0: f7a9dfe9e8
	// v0: a9c6c544b1
	// v0: 53a74fcb51
	// v0: 58ec114a32
	it("refuses another media type or none with 415 before the middleware, and leaves the body for the destination", async () => {
		const { app, reached } = proxied()
		const post = (path: string, headers: Record<string, string>, body = '{"a":1}') =>
			call(app, path, { body, headers, method: "POST" })
		const noType = new Request("http://x/items", { body: "xx", method: "POST" })
		noType.headers.delete("content-type")
		expect([
			(await post("/items", { "content-type": "text/plain", "x-wait": "1" }))[0],
			(await app.fetch(noType, {})).status,
			await post("/items", { "content-type": "application/json" }),
			await post("/items/7/restore", {}),
			await call(app, "/items"),
		]).toEqual([415, 415, [200, "proxied"], [200, "proxied"], [200, "proxied"]])
		expect(reached).toEqual(['/items {"a":1}', '/items/7/restore {"a":1}', "/items "])
	})

	// v0: dc076737af
	it("leaves a registered route's own input step to refuse the media type", async () => {
		const app = honey<{}>().routeTree(treeOf([["POST", "/items"]]))
		app
			.post("/items")
			.input({ json: PASS })
			.handler((c) => c.res.text("ok", "local"))
		expect(
			(await call(app, "/items", { body: "x", headers: { "content-type": "text/plain" }, method: "POST" }))[0],
		).toBe(415)
	})
})

describe("delegation: a binary body, and what is never delegated", () => {
	it("checks a declared binary type, and leaves a WebSocket leaf to no catch-all", async () => {
		const root = createNode()
		const routes: Record<string, RouteEntry> = { [insertRoute(root, "PUT", "/files")]: { iv: { binary: "image/png" } } }
		routes[insertWsRoute(root, "/live")] = {}
		const app = gateway({ meta: {}, root, routes, v: 2 })
		const put = (type: string) => call(app, "/files", { body: "x", headers: { "content-type": type }, method: "PUT" })
		expect([(await put("text/plain"))[0], (await put("image/png"))[0], (await call(app, "/live"))[0]]).toEqual([
			415, 200, 404,
		])
	})
})

describe("delegation: types", () => {
	type AppMeta = { auth: string; worker: string }

	// v0: 41543b756c
	// v0: 59632093db
	// v0: 06a428d1ef
	// v0: b55bcc034b
	// v0: 8909d51c36
	it("types the catch-all's ctx.meta from the app's meta, proxy destination included", () => {
		const app = honey<{}>().meta<AppMeta>().routeTree(TREE())
		app.all("*").handler((c) => {
			expectTypeOf(c.meta.worker).toEqualTypeOf<string>()
			return c.res.text("ok", c.meta.auth)
		})
		honey<{}>()
			.meta<AppMeta>()
			.all("*")
			.handler(proxy({ destination: (c) => new Response(c.meta.worker) }))
		honey<{}>()
			.meta<{ auth: string }>()
			.get("/t")
			.meta({ auth: "jwt" })
			.handler((c) => {
				expectTypeOf(c.meta.auth).toEqualTypeOf<string>()
				return c.res.text("ok", c.meta.auth)
			})
		expect(true).toBe(true)
	})
})
