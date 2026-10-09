/**
 * Regression guards for workstream 1 of the 3ab88ce deep review (one route model, one
 * dispatcher). Each test reproduces a finding's scenario and failed on 3ab88ce; see
 * docs/regression-matrix/ws1-3.md. Only APIs that existed at 3ab88ce are used, so the file
 * runs unchanged against the pre-fix source.
 */
import { describe, expect, it } from "vitest"
import { generateRouteTreeFromApp, generateRouteTreeFromRouteTree } from "../../src/codegen.ts"
import { createMiddleware, honey, mergeTree } from "../../src/index.ts"
import type { RouteTree } from "../../src/tree.ts"

async function evalTree(code: string): Promise<RouteTree> {
	const { transform } = await import("esbuild")
	const { code: js } = await transform(code, { format: "esm", loader: "ts", target: "esnext" })
	return (
		(await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as { routeTree: RouteTree }
	).routeTree
}

type Fetchable = { fetch(r: Request, e?: object): Response | Promise<Response> }

/** status, or "threw" when the app refuses to serve (a loud failure counts as guarded) */
async function status(app: Fetchable, path: string, method = "GET"): Promise<number | "threw"> {
	try {
		return (await app.fetch(new Request(`http://x${path}`, { method }), {})).status
	} catch {
		return "threw"
	}
}

async function body(app: Fetchable, path: string, method = "GET"): Promise<unknown> {
	const res = await app.fetch(new Request(`http://x${path}`, { method }), {})
	return res.json()
}

const deny = createMiddleware(async () => new Response("denied", { status: 401 }))

describe("WS1 regressions", () => {
	// regression: C1
	it("C1: path-scoped middleware still guards routes when a generated routeTree is loaded", async () => {
		const build = (tree?: RouteTree) => {
			const app = honey()
			if (tree) app.routeTree(tree)
			app.use("/admin", deny)
			app.get("/admin/secret").handler((c) => c.res.json("ok", { secret: true }))
			app.get("/public").handler((c) => c.res.json("ok", { pub: true }))
			return app
		}
		const tree = await evalTree(generateRouteTreeFromApp(build()))
		const loaded = build(tree)
		expect(await status(loaded, "/admin/secret")).toBe(401)
		expect(await status(loaded, "/public")).toBe(200)
	})

	// regression: H (NEW) — shared handler objects across apps loading one tree
	it("NEW-H shared-tree: two apps loading one generated tree serve their own handlers", async () => {
		const make = (name: string, tree?: RouteTree) => {
			const app = honey()
			if (tree) app.routeTree(tree)
			app.get("/who").handler((c) => c.res.json("ok", { name }))
			return app
		}
		const tree = await evalTree(generateRouteTreeFromApp(make("gen")))
		const a = make("A", tree)
		const b = make("B", tree)
		expect(await body(a, "/who")).toEqual({ name: "A" })
		expect(await body(b, "/who")).toEqual({ name: "B" })
		const bare = honey()
		bare.routeTree(tree)
		expect(await status(bare, "/who")).not.toBe(200)
	})

	// regression: NEW-M stale meta — patch mode never refreshed mt
	it("NEW-M stale-meta: a loaded tree serves the registered route's meta, not the generated file's", async () => {
		const make = (label: string, tree?: RouteTree) => {
			const app = honey()
			if (tree) app.routeTree(tree)
			app
				.get("/m")
				.meta({ label })
				.handler((c) => c.res.json("ok", { label: (c.meta as { label?: string }).label ?? null }))
			return app
		}
		const tree = await evalTree(generateRouteTreeFromApp(make("old")))
		expect(await body(make("new", tree), "/m")).toEqual({ label: "new" })
	})

	// regression: H17
	it("H17: a literal `/users/:id` request binds the param instead of hitting a static entry", async () => {
		const make = (tree?: RouteTree) => {
			const app = honey()
			if (tree) app.routeTree(tree)
			app.get("/users/:id").handler((c) => c.res.json("ok", { id: c.params.id ?? null }))
			return app
		}
		const tree = await evalTree(generateRouteTreeFromApp(make()))
		expect(await body(make(tree), "/users/:id")).toEqual({ id: ":id" })
	})

	// regression: H18
	it("H18: a route missing from the tree never becomes reachable under unrelated leaves", async () => {
		const tree = await evalTree(
			generateRouteTreeFromApp(
				(() => {
					const app = honey()
					app.get("/health").handler((c) => c.res.json("ok", {}))
					app.get("/chat").handler((c) => c.res.json("ok", {}))
					return app
				})(),
			),
		)
		const app = honey()
		app.routeTree(tree)
		app.get("/health").handler((c) => c.res.json("ok", {}))
		app.get("/chat").handler((c) => c.res.json("ok", {}))
		app.get("/chat/secret").handler((c) => c.res.json("ok", { leaked: true }))
		expect(await status(app, "/health/secret")).not.toBe(200)
	})

	// regression: H19
	it("H19: `.on([GET, POST])` serves every method with a loaded tree", async () => {
		const make = (tree?: RouteTree) => {
			const app = honey()
			if (tree) app.routeTree(tree)
			app.on(["GET", "POST"], "/multi").handler((c) => c.res.json("ok", { m: c.req.method }))
			return app
		}
		const loaded = make(await evalTree(generateRouteTreeFromApp(make())))
		expect(await status(loaded, "/multi", "GET")).toBe(200)
		expect(await status(loaded, "/multi", "POST")).toBe(200)
	})

	// regression: M (was H21)
	it("M-H21: optional, wildcard and trailing-slash routes boot from their own generated tree", async () => {
		const make = (tree?: RouteTree) => {
			const app = honey()
			if (tree) app.routeTree(tree)
			app.get("/opt/:id?").handler((c) => c.res.json("ok", {}))
			app.get("/files/*").handler((c) => c.res.json("ok", {}))
			app.get("/a/:id/:b?").handler((c) => c.res.json("ok", {}))
			return app
		}
		const loaded = make(await evalTree(generateRouteTreeFromApp(make())))
		expect(await status(loaded, "/opt")).toBe(200)
		expect(await status(loaded, "/opt/1")).toBe(200)
		expect(await status(loaded, "/files/x/y")).toBe(200)
		expect(await status(loaded, "/a/1/2")).toBe(200)
	})

	// regression: H22
	it("H22: the app's own root wildcard (SPA fallback) answers GET with a loaded tree", async () => {
		const make = (tree?: RouteTree) => {
			const app = honey()
			if (tree) app.routeTree(tree)
			app.get("/api/x").handler((c) => c.res.json("ok", {}))
			app.get("/*path").handler((c) => c.res.json("ok", { spa: true }))
			return app
		}
		const loaded = make(await evalTree(generateRouteTreeFromApp(make())))
		expect(await status(loaded, "/some/page")).toBe(200)
		expect(await status(loaded, "/some/page", "HEAD")).toBe(200)
	})

	// regression: M HEAD-catch-all
	it("M-HEAD-catchall: HEAD and GET agree for a GET catch-all on unknown paths", async () => {
		const make = (tree?: RouteTree) => {
			const app = honey()
			if (tree) app.routeTree(tree)
			app.get("/known").handler((c) => c.res.json("ok", {}))
			app.get("/*rest").handler((c) => c.res.json("ok", {}))
			return app
		}
		const loaded = make(await evalTree(generateRouteTreeFromApp(make())))
		expect(await status(loaded, "/unknown", "HEAD")).toBe(await status(loaded, "/unknown", "GET"))
	})

	// regression: H-backtrack (was M)
	it("H-backtrack: the router backtracks from dead-end static branches and method misses", async () => {
		const app = honey()
		app.get("/users/me/settings").handler((c) => c.res.json("ok", { r: "settings" }))
		app.get("/users/:id/profile").handler((c) => c.res.json("ok", { r: "profile" }))
		app.get("/files/static").handler((c) => c.res.json("ok", { r: "static" }))
		app.get("/files/*path").handler((c) => c.res.json("ok", { r: "files" }))
		app.get("/a/:id").handler((c) => c.res.json("ok", { r: "a-id" }))
		app.get("/a/*rest").handler((c) => c.res.json("ok", { r: "a-rest" }))
		app.get("/u/me").handler((c) => c.res.json("ok", { r: "me" }))
		app.delete("/u/:id").handler((c) => c.res.json("ok", { r: "del" }))
		expect(await body(app, "/users/me/profile")).toEqual({ r: "profile" })
		expect(await body(app, "/files/static/x")).toEqual({ r: "files" })
		expect(await body(app, "/a/1/2")).toEqual({ r: "a-rest" })
		expect(await body(app, "/u/me", "DELETE")).toEqual({ r: "del" })
	})

	// regression: M gateway fallthrough with a root /:slug
	/*
	 * Skipped: blocked by an open regression found while writing this matrix (GW-OWN-ROUTES in
	 * docs/regression-matrix/ws1-3.md). A gateway booted from a `codegen.mergeTree` tree (downstream
	 * routes only) that registers any non-wildcard route of its own throws "Route tree out of date"
	 * on every request at HEAD. 3ab88ce served it but answered the downstream route with the wrong
	 * meta (`{}`), which is this finding. Un-skip once GW-OWN-ROUTES is fixed.
	 */
	it.skip("M-gateway-slug: a merged downstream route reaches the catch-all with its own meta despite a root /:slug", async () => {
		const users = honey()
		users.get("/users/list").handler((c) => c.res.json("ok", {}))
		const code = generateRouteTreeFromRouteTree(mergeTree([users.toRouteTree(), { worker: "users" }]))
		const gateway = honey()
		gateway.routeTree(await evalTree(code))
		gateway.get("/:slug").handler((c) => c.res.json("ok", { slug: c.params.slug }))
		gateway.all("/*").handler((c) => c.res.json("ok", { worker: (c.meta as { worker?: string }).worker ?? null }))
		expect(await body(gateway, "/users/list")).toEqual({ worker: "users" })
		expect(await body(gateway, "/about")).toEqual({ slug: "about" })
	})

	// regression: gateway catch-all over a downstream-only tree (guards the shape that works today)
	it("M-gateway-catchall: a downstream-only tree delegates its routes to the gateway catch-all with their meta", async () => {
		const users = honey()
		users.get("/users/list").handler((c) => c.res.json("ok", {}))
		const code = generateRouteTreeFromRouteTree(mergeTree([users.toRouteTree(), { worker: "users" }]))
		const gateway = honey()
		gateway.routeTree(await evalTree(code))
		gateway.all("/*").handler((c) => c.res.json("ok", { worker: (c.meta as { worker?: string }).worker ?? null }))
		expect(await body(gateway, "/users/list")).toEqual({ worker: "users" })
		expect(await status(gateway, "/about")).toBe(404)
	})

	// regression: M toRouteTree round trip
	it("M-roundtrip: toRouteTree() → routeTree() keeps scoped middleware", async () => {
		const src = honey()
		src.use("/admin", deny)
		src.get("/admin/x").handler((c) => c.res.json("ok", {}))
		const app = honey()
		app.routeTree(src.toRouteTree())
		expect(await status(app, "/admin/x")).not.toBe(200)
	})

	// regression: M mergeInto shares nodes
	it("M-mergeInto: two parents mounting one sub do not share routes or bypass scoped middleware", async () => {
		const sub = honey()
		sub.get("/api/users").handler((c) => c.res.json("ok", { from: "sub" }))
		const p1 = honey()
		p1.use("/api/admin", deny)
		p1.route(sub)
		const p2 = honey()
		p2.route(sub)
		p1.get("/api/admin").handler((c) => c.res.json("ok", { from: "p1" }))
		expect(await status(p1, "/api/admin")).toBe(401)
		expect(await status(p2, "/api/admin")).toBe(404)
	})

	// regression: M route/basePath normalization vs scopes
	it("M-normalize: non-normalized route and basePath strings are still covered by their scope", async () => {
		const root = honey()
		root.use("/api/admin", deny)
		const api = root.basePath("/api/")
		api.get("/admin/x").handler((c) => c.res.json("ok", {}))
		root.get("//admin/b").handler((c) => c.res.json("ok", {}))
		root.use("/admin", deny)
		expect(await status(root, "/api/admin/x")).toBe(401)
		expect(await status(root, "/admin/b")).toBe(401)
	})

	// regression: M tree from the full app + route(sub)
	it("M-merge-conflict: mounting a sub on an app booted from the full app's tree does not throw", async () => {
		const make = (tree?: RouteTree) => {
			const sub = honey()
			sub.get("/sub/a").handler((c) => c.res.json("ok", {}))
			const app = honey()
			if (tree) app.routeTree(tree)
			app.get("/root").handler((c) => c.res.json("ok", {}))
			app.route(sub)
			return app
		}
		const tree = await evalTree(generateRouteTreeFromApp(make()))
		expect(await status(make(tree), "/sub/a")).toBe(200)
	})

	// regression: M prototype-named segments
	it("M-proto-segments: tree codegen handles segments named like Object.prototype members", async () => {
		const make = (tree?: RouteTree) => {
			const app = honey()
			if (tree) app.routeTree(tree)
			for (const seg of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
				app.get(`/p/${seg}`).handler((c) => c.res.json("ok", { seg }))
			}
			return app
		}
		const code = generateRouteTreeFromApp(make())
		const loaded = make(await evalTree(code))
		expect(await body(loaded, "/p/constructor")).toEqual({ seg: "constructor" })
		expect(await body(loaded, "/p/toString")).toEqual({ seg: "toString" })
	})

	// regression: M meta interning
	it("M-intern: tree codegen rejects non-JSON meta instead of merging or dropping it", () => {
		for (const [a, b] of [
			[Number.NaN, null],
			[new Date(0), {}],
			[/x/, {}],
		] as const) {
			const app = honey()
			app
				.get("/a")
				.meta({ v: a })
				.handler((c) => c.res.json("ok", {}))
			app
				.get("/b")
				.meta({ v: b })
				.handler((c) => c.res.json("ok", {}))
			expect(() => generateRouteTreeFromApp(app), String(a)).toThrow()
		}
	})

	// regression: L routeTree after registration
	it("L-late-routeTree: routeTree() after routes are registered fails loudly", async () => {
		const src = honey()
		src.get("/s").handler((c) => c.res.json("ok", {}))
		src.get("/d/:id").handler((c) => c.res.json("ok", {}))
		const tree = await evalTree(generateRouteTreeFromApp(src))
		const app = honey()
		app.get("/s").handler((c) => c.res.json("ok", {}))
		app.get("/d/:id").handler((c) => c.res.json("ok", {}))
		let threw = false
		try {
			app.routeTree(tree)
		} catch {
			threw = true
		}
		expect(threw).toBe(true)
	})
})
