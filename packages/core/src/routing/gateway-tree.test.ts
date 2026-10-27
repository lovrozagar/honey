import { describe, expect, it } from "vitest"
import * as z from "zod"
import { collectRoutes } from "../openapi/collect.ts"
import { honey } from "./app.ts"
import { gatewayTree, overlaySchemas } from "./gateway-tree.ts"
import { createNode, insertRoute, type RouteEntry, type RouteTree } from "./tree.ts"
import { mergeTree } from "./tree-merge.ts"

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

/** anyrow's gateway shape: its own routes and a root /:slug beside the catch-all its downstream routes delegate to. */
function own(tree?: RouteTree) {
	const app = honey<{}>()
	if (tree !== undefined) app.routeTree(tree)
	app.get("/health").handler((c) => c.res.text("ok", "up"))
	app.get("/:slug").handler((c) => c.res.text("ok", `slug ${c.params.slug}`))
	app
		.all("/*")
		.handler((c) => c.res.json("ok", { pattern: c.routePattern, worker: (c.meta as { worker?: string }).worker }))
	return app
}

describe("gatewayTree(): what a gateway serves", () => {
	// v0: 740a227711
	// v0: e3e940e1d3
	// v0: d3867759a6
	// v0: 9c2d38b4ed
	// v0: ccfd3d3c19
	it("adds the gateway's own routes beside the downstream ones, keeps its root wildcard out, and refuses a shadowing route", async () => {
		const users = honey<{}>()
		users.get("/users/list").handler((c) => c.res.text("ok", "remote"))
		users.get("/users/:id").handler((c) => c.res.text("ok", "remote"))
		const downstream = mergeTree([users.toRouteTree(), { worker: "users" }])
		const app = own(gatewayTree(own(), downstream))
		expect([
			await call(app, "/health"),
			await call(app, "/about"),
			await call(app, "/users/list"),
			await call(app, "/users/7"),
			(await call(app, "/a/b/c"))[0],
		]).toEqual([
			[200, "up"],
			[200, "slug about"],
			[200, '{"pattern":"/users/list","worker":"users"}'],
			[200, '{"pattern":"/users/:id","worker":"users"}'],
			404,
		])
		const shadow = honey<{}>()
		shadow.get("/users/list").handler((c) => c.res.text("ok", "mine"))
		expect(() => gatewayTree(shadow, downstream)).toThrow(
			"Gateway routes are also downstream routes in the merged tree: GET /users/list",
		)
		expect(() => gatewayTree(own(), own().toRouteTree())).not.toThrow()
	})
})

describe("overlaySchemas(): a gateway documents its downstream routes' shapes", () => {
	// v0: 0f86482838
	it("copies schemas onto registered routes that lack them, keeping their own", () => {
		const mine = { json: z.object({ mine: z.string() }) }
		const theirs = { json: z.object({ theirs: z.string() }) }
		const app = honey<{}>()
		app
			.post("/a")
			.input(mine)
			.handler((c) => c.res.text("ok", "a"))
		app.post("/b/:id").handler((c) => c.res.text("ok", "b"))
		app.post("/c").handler((c) => c.res.text("ok", "c"))
		app.post("/d").handler((c) => c.res.text("ok", "d"))
		const service = honey<{}>()
		service
			.post("/c")
			.input(theirs)
			.handler((c) => c.res.text("ok", "c"))
		const live = service.toRouteTree().routes["POST /c"] as RouteEntry
		overlaySchemas(
			app,
			treeOf([
				["POST", "/a", { iv: theirs }],
				["POST", "/b/:id", { iv: theirs, out: { "text/plain": { ok: z.string() } } }],
				["POST", "/c", { h: live.h }],
				["POST", "/d"],
				["GET", "/missing", { iv: theirs }],
			]),
		)
		const [a, b, c, d] = collectRoutes(app).http
		expect([a?.input, b?.input, Object.keys(b?.output ?? {}), c?.input, d?.input]).toEqual([
			mine,
			theirs,
			["text/plain"],
			theirs,
			null,
		])
	})
	it("copies them onto the loaded leaves a gateway serving its generated tree holds without a record (bit 19 h2)", () => {
		const theirs = { json: z.object({ theirs: z.string() }) }
		const service = honey<{}>()
		service
			.post("/c")
			.input(theirs)
			.handler((c) => c.res.text("ok", "c"))
		const merged = mergeTree([service.toRouteTree(), { worker: "service" }])
		/* the generated file carries data only: no live record, no schemas */
		const written = { ...merged, routes: { "POST /c": { mt: { worker: "service" } } } } as RouteTree
		const app = honey<{}>().routeTree(written)
		app.all("/*").handler((c) => c.res.text("ok", "forwarded"))
		overlaySchemas(app, merged)
		const [c] = collectRoutes(app).http
		expect([c?.id, c?.input, c?.meta]).toEqual(["POST /c", theirs, { worker: "service" }])
	})
})
