/**
 * A live app's tree through gen's `generateRouteTree` and back: `app.toRouteTree()` → the emitted
 * `routes.gen.ts`, imported → `honey().routeTree(module.routeTree)` plus the same registrations,
 * which must serve exactly as the live app does. Gen is imported by path, test-only; calling it
 * on `toRouteTree()` typechecks core's `RouteTree` against gen's `RouteTreeV2` (the drift guard).
 */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { emittedRouteTree } from "../../../gen/src/emit/ts/__fixtures__/emitted.ts"
import { generateRouteTree } from "../../../gen/src/emit/ts/route-tree.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { generateOpenApi } from "../../src/openapi/generate.ts"
import { serveOpenApi } from "../../src/openapi/serve.ts"
import { type Honey, honey } from "../../src/routing/app.ts"
import type { RouteEntry, RouteTree } from "../../src/routing/tree.ts"
import {
	accepted,
	type Fetcher,
	methodReference,
	observeMethod,
	observePath,
	pathReference,
	randomMethodRoute,
	randomPath,
	randomPathRoute,
	REQUEST_METHODS,
	REQUEST_SEGMENTS,
	register,
	runtimeApp,
} from "./route-tree-emit/reference.ts"
import { caseLabel, rng, runs } from "./security/rng.ts"

type App = Honey<{}>

type Loaded = {
	readonly meta?: Readonly<Record<string, unknown>>
	readonly routeTree: RouteTree
	readonly routes: Readonly<Record<string, RouteEntry>>
	readonly text: string
	readonly tree: RouteTree["root"]
}

/** The module gen emits for `app`'s tree, imported. */
const emitted = async (app: App) => (await emittedRouteTree(app.toRouteTree())) as unknown as Loaded

/** An app booted from the module emitted for `make()`'s tree, then given `make`'s registrations. */
async function booted(make: (tree?: RouteTree) => App): Promise<App> {
	return make((await emitted(make())).routeTree)
}

/** Status and text of one request through `app`. */
async function call(app: Fetcher, path: string, init?: RequestInit): Promise<[number, string]> {
	const res = await app.fetch(new Request(`http://x${path}`, init), {})
	return [res.status, await res.text()]
}

/** The statuses a gateway that serves `tree` and registers nothing documents for `GET /door`. */
function doorStatuses(tree: RouteTree): string[] {
	const doc = generateOpenApi(honey<{}>().routeTree(tree), { info: { title: "T", version: "1" } })
	const paths = doc.paths as Record<string, { get: { responses: Record<string, unknown> } }>
	return Object.keys(paths["/door"]?.get.responses ?? {})
}

/** A middleware answering 401 without running the route. */
const deny = createMiddleware(async () => new Response("denied", { status: 401 }))

/** An app factory: a fresh app, booted from `tree` when given, with `routes` registered on it. */
const maker =
	(routes: (app: App) => void) =>
	(tree?: RouteTree): App => {
		const app = honey<{}>()
		if (tree) app.routeTree(tree)
		routes(app)
		return app
	}

const usersApp = maker((app) => {
	app.get("/users").handler((c) => c.res.text("ok", "list"))
	app
		.meta<{ auth?: boolean }>()
		.get("/users/:id")
		.meta({ auth: true })
		.handler((c) => c.res.text("ok", `user ${c.params.id}`))
})

const optionalApp = maker((app) => {
	app.get("/items/:id?").handler((c) => c.res.text("ok", `item ${c.params.id ?? "-"}`))
})

const shapesApp = maker((app) => {
	app.get("/opt/:id?").handler((c) => c.res.text("ok", `opt ${c.params.id ?? "-"}`))
	app.get("/files/*").handler((c) => c.res.text("ok", `files ${c.params["*"]}`))
	app.get("/users/").handler((c) => c.res.text("ok", "users"))
	app.get("/a/:id/:b?").handler((c) => c.res.text("ok", `a ${c.params.id} ${c.params.b ?? "-"}`))
	app.get("/constructor/toString").handler((c) => c.res.text("ok", "proto-named"))
})

const PROTO_SEGMENTS = ["constructor", "toString", "__proto__", "hasOwnProperty"]
const protoApp = maker((app) => {
	for (const seg of PROTO_SEGMENTS) app.get(`/p/${seg}`).handler((c) => c.res.text("ok", seg))
})

const guardedApp = maker((app) => {
	app.use("/admin", deny)
	app.get("/admin/secret").handler((c) => c.res.text("ok", "secret"))
	app.get("/public").handler((c) => c.res.text("ok", "public"))
})

const mountingApp = maker((app) => {
	const sub = honey<{}>()
	sub.get("/sub/a").handler((c) => c.res.text("ok", "sub a"))
	app.get("/root").handler((c) => c.res.text("ok", "root"))
	app.route(sub)
})

const chatApp = maker((app) => {
	app.get("/chat").handler((c) => c.res.text("ok", "chat"))
	app.get("/health").handler((c) => c.res.text("ok", "health"))
})

describe("route-tree emit: a booted app serves as the live one", () => {
	// v0: 1606b2c8cb
	it("emits tree, routes and routeTree for a live app's tree, its meta exported, and serves the same", async () => {
		const live = usersApp()
		const text: string = generateRouteTree(live.toRouteTree())
		const module = await emitted(live)
		expect([module.text === text, Object.keys(module.routes), module.meta, module.routeTree.v]).toEqual([
			true,
			["GET /users", "GET /users/:id"],
			{ "GET /users/:id": { auth: true } },
			2,
		])
		const app = usersApp(module.routeTree)
		for (const target of [live, app]) {
			expect([await call(target, "/users"), await call(target, "/users/7"), (await call(target, "/x"))[0]]).toEqual([
				[200, "list"],
				[200, "user 7"],
				404,
			])
		}
	})

	// v0: 17ac0bc299
	it("places one route id at both leaves of an optional param, and the booted app serves both", async () => {
		const { routes, tree } = await emitted(optionalApp())
		expect([Object.keys(routes), tree.s.items?.m, tree.s.items?.d?.c.m]).toEqual([
			["GET /items/:id?"],
			{ GET: "GET /items/:id?" },
			{ GET: "GET /items/:id?" },
		])
		const app = await booted(optionalApp)
		expect([await call(app, "/items"), await call(app, "/items/7")]).toEqual([
			[200, "item -"],
			[200, "item 7"],
		])
	})

	// v0: 8217438ad1
	// v0: f569aee4b9
	it("boots from its own emitted tree with optional params, wildcards, trailing slashes and multi-param routes", async () => {
		const [live, app] = [shapesApp(), await booted(shapesApp)]
		const paths = ["/opt", "/opt/7", "/files/a/b", "/users", "/users/", "/a/1", "/a/1/2", "/constructor/toString"]
		const served = async (target: App) => Promise.all(paths.map((path) => call(target, path)))
		expect(await served(app)).toEqual(await served(live))
		expect((await served(app)).map(([, body]) => body)).toEqual([
			"opt -",
			"opt 7",
			"files a/b",
			"users",
			"users",
			"a 1 -",
			"a 1 2",
			"proto-named",
		])
	})
})

describe("route-tree emit: a booted app keeps the live app's scopes and mounts", () => {
	// v0: d379f8f413
	it("serves segments named like Object.prototype members after emit and import", async () => {
		const app = await booted(protoApp)
		expect(await Promise.all(PROTO_SEGMENTS.map((seg) => call(app, `/p/${seg}`)))).toEqual(
			PROTO_SEGMENTS.map((seg) => [200, seg]),
		)
	})

	// v0: d63fdb6ada
	it("still guards routes with path-scoped middleware after the emitted tree is loaded", async () => {
		const app = await booted(guardedApp)
		expect([await call(app, "/admin/secret"), await call(app, "/public")]).toEqual([
			[401, "denied"],
			[200, "public"],
		])
	})

	// v0: 9fd398499c
	// v0: f12280f631
	it("binds a mounted sub-app's routes to a tree emitted from the full app instead of conflicting", async () => {
		const app = await booted(mountingApp)
		expect([await call(app, "/sub/a"), await call(app, "/root")]).toEqual([
			[200, "sub a"],
			[200, "root"],
		])
	})

	// v0: 4c53d6cec5
	it("leaves the imported module untouched when one app serves its document and a websocket route beside it", async () => {
		const live = chatApp()
		live.ws("/live").handler({})
		const module = await emitted(live)
		const a = chatApp(module.routeTree).wsAdapter({
			upgrade: () => ({ response: new Response(), socket: {} as never }),
		})
		a.ws("/live").handler({})
		serveOpenApi(a, { title: "T", version: "1" })
		const b = chatApp(module.routeTree)
		expect([
			(await call(a, "/openapi.json"))[0],
			(await call(b, "/openapi.json"))[0],
			(await call(b, "/health/openapi.json"))[0],
			await call(b, "/health"),
		]).toEqual([200, 404, 404, [200, "health"]])
		expect([Object.keys(module.tree.s), Object.keys(module.routes), module.tree.s.live?.ws]).toEqual([
			["chat", "health", "live"],
			["GET /chat", "GET /health", "WS /live"],
			"WS /live",
		])
	})
})

describe("route-tree emit: no schema data in the module", () => {
	// v0: 1ee83dce78
	// v0: b7de30d109
	// v0: 7e284ba526
	// v0: 93fc232f69
	// v0: 262ea9454c
	// v0: 55cd3dbcf2
	it("carries no input or output schema, media type, input source or validator for any route", async () => {
		const listQuery = z
			.object({ cursor: z.string().optional(), limit: z.string() })
			.transform((q) => ({ ...q, limit: Number(q.limit) }))
		const app = honey<{}>()
		app
			.post("/multi")
			.meta({ summary: "multi" })
			.input({
				cookies: z.object({ sid: z.string() }),
				headers: z.object({ "x-req": z.string() }),
				json: z.object({ email: z.string().email(), name: z.string() }),
				search: z.object({ q: z.string() }),
			})
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/page")
			.output({ "application/json": { ok: z.object({ ok: z.boolean() }) }, "text/html": { ok: z.string() } })
			.handler((c) => c.res.html("ok", "<p>ok</p>"))
		app
			.get("/r")
			.output({ redirect: { found: true, moved_permanently: true } })
			.handler((c) => c.res.redirect("/somewhere"))
		app
			.get("/items")
			.input({ search: listQuery })
			.handler((c) => c.res.text("ok", "ok"))
		app.get("/health").handler((c) => c.res.text("ok", "ok"))
		const { routes, text } = await emitted(app)
		const leaked = Object.values(routes).flatMap((entry) =>
			Object.keys(entry).filter((k) => !["bek", "ek", "es", "mt"].includes(k)),
		)
		const words = ["application/json", "text/html", "redirect", "moved_permanently", "cursor", "email", '"json"']
		expect([leaked, words.filter((word) => text.includes(word)), text.includes('"cookies"')]).toEqual([[], [], false])
	})
})

describe("route-tree emit: route data the module carries", () => {
	// v0: 943e56dc6a
	it("bakes middleware meta into the route's mt and never serializes the middleware itself", async () => {
		const shard = createMiddleware(async (_c, next) => next({ marker: "middleware-body-marker" }), {
			meta: { tenant: "project_id" },
		})
		const app = honey<{}>()
		app
			.use(shard)
			.get("/a")
			.handler((c) => c.res.json("ok", {}))
		const { routes, text } = await emitted(app)
		expect([routes["GET /a"]?.mt, text.includes("middleware-body-marker")]).toEqual([{ tenant: "project_id" }, false])
	})

	it("carries each error key's status, so a gateway serving the tree documents it with no factory", async () => {
		const app = honey<{}>()
		app
			.get("/door")
			.errors(defineErrors({ locked: "conflict" }), "locked")
			.handler((c) => c.res.text("ok", "open"))
		const { routeTree } = await emitted(app)
		const { es: _es, ...withoutStatus } = routeTree.routes["GET /door"] as RouteEntry
		const stripped = { ...routeTree, routes: { ...routeTree.routes, "GET /door": withoutStatus } }
		expect([routeTree.routes["GET /door"]?.es, doorStatuses(routeTree).includes("409")]).toEqual([
			{ locked: "conflict" },
			true,
		])
		expect(doorStatuses(stripped).includes("409")).toBe(false)
	})
})

describe("route-tree emit: property, emitted ≡ runtime ≡ reference", () => {
	// v0: 7a9e1deef3
	it("agrees with the runtime router and a naive reference on random route sets, methods and paths", async () => {
		const r = rng(41)
		for (let round = 0; round < runs(120); round++) {
			const routes = accepted(Array.from({ length: 2 + r.int(9) }, () => randomMethodRoute(r)))
			const apps: [string, Fetcher][] = [["runtime", runtimeApp(routes)]]
			/* the emitted module is the expensive mode: every fourth round */
			if (round % 4 === 0) {
				const hydrated = honey<{}>().routeTree((await emitted(runtimeApp(routes))).routeTree)
				register(hydrated, routes)
				apps.push(["emitted", hydrated])
			}
			for (let q = 0; q < 25; q++) {
				const [method, path] = [r.pick(REQUEST_METHODS), randomPath(r)]
				const expected = methodReference(routes, method, path)
				for (const [mode, app] of apps) {
					const label = caseLabel(41, round, { method, mode, path, routes })
					expect(await observeMethod(app, method, path), label).toEqual(expected)
				}
			}
		}
	})

	// v0: 2b93176f37
	it("serves encoded, dotted and empty segments like the runtime router and the reference", async () => {
		const r = rng(31)
		for (let round = 0; round < runs(60); round++) {
			const routes = accepted(Array.from({ length: 2 + r.int(7) }, () => randomPathRoute(r)))
			const apps: [string, Fetcher][] = [["runtime", runtimeApp(routes)]]
			if (round % 4 === 0) {
				const hydrated = honey<{}>().routeTree((await emitted(runtimeApp(routes))).routeTree)
				register(hydrated, routes)
				apps.push(["emitted", hydrated])
			}
			for (let q = 0; q < 20; q++) {
				const parts = Array.from({ length: r.int(5) }, () => r.pick(REQUEST_SEGMENTS))
				const target = `/${parts.join("/")}${r.bool(0.1) ? "/" : ""}`
				const expected = pathReference(routes, target)
				for (const [mode, app] of apps) {
					const label = caseLabel(31, round, { mode, routes: routes.map((x) => x.pattern), target })
					expect(await observePath(app, target), label).toEqual(expected)
				}
			}
		}
	})
})
