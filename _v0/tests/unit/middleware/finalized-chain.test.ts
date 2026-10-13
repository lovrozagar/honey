/**
 * Workstream 2 — middleware is resolved once, at finalize. What a route runs is fixed by how it
 * was registered and mounted, never by which handle serves the request.
 */
import { describe, expect, it } from "vitest"
import { generateManifest } from "../../../src/codegen.ts"
import { createMiddleware, defineErrors, defineMiddleware, HoneyError, honey } from "../../../src/index.ts"
import type { Honey } from "../../../src/index.ts"
import type { RouteTree } from "../../../src/tree.ts"
import type { WSAdapter, WSHandler } from "../../../src/ws/cloudflare.ts"
import { WSContextImpl } from "../../../src/ws/cloudflare.ts"
import { cors } from "../../../src/cors.ts"
import { csrf } from "../../../src/csrf.ts"

type App = Honey<{}>
const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init)

/** A middleware that records its name in `trace` and passes through. */
function tracer(trace: string[], name: string) {
	return createMiddleware(async (_ctx, next) => {
		trace.push(name)
		return next()
	})
}

function make101Response(): Response {
	const response = new Response(null, { status: 200 })
	Object.defineProperty(response, "status", { value: 101 })
	return response
}

function testWsAdapter(): WSAdapter {
	const raw = { close() {}, readyState: 1, send() {} }
	return {
		upgrade(_req, _env, handler: WSHandler<unknown>) {
			const socket = new WSContextImpl(raw)
			handler.onOpen?.(undefined, socket)
			return { response: make101Response(), socket }
		},
	}
}

/* ──── the matrix ──── */

type Built = { derived: App; root: App }

/**
 * One app shape — chain `A`, scope `/s` → `S`, route middleware `R` on `GET /s/x` — built
 * five ways. Each returns the root handle and a derived handle of the same graph.
 */
const shapes: Record<string, (trace: string[]) => Built> = {
	"own route": (trace) => {
		const root = honey<{}>() as App
		root.use("/s", tracer(trace, "S"))
		root
			.use(tracer(trace, "A"))
			.get("/s/x")
			.use(tracer(trace, "R"))
			.handler((ctx) => ctx.res.text("ok", "x"))
		return { derived: root.context({ v: 1 }) as unknown as App, root }
	},
	"mounted sub": (trace) => {
		const sub = honey<{}>()
		sub.use("/s", tracer(trace, "S"))
		sub
			.get("/s/x")
			.use(tracer(trace, "R"))
			.handler((ctx) => ctx.res.text("ok", "x"))
		const root = honey<{}>() as App
		const withA = root.use(tracer(trace, "A"))
		withA.route(sub)
		return { derived: withA as unknown as App, root }
	},
	"nested mount": (trace) => {
		const leaf = honey<{}>()
		leaf
			.get("/s/x")
			.use(tracer(trace, "R"))
			.handler((ctx) => ctx.res.text("ok", "x"))
		const mid = honey<{}>()
		mid.use("/s", tracer(trace, "S"))
		mid.route(leaf)
		const root = honey<{}>() as App
		const withA = root.use(tracer(trace, "A"))
		withA.route(mid)
		return { derived: withA as unknown as App, root }
	},
	"loaded tree": (trace) => {
		/* a generated tree carries topology only: the app registers the same routes after loading it */
		const register = (app: App) => {
			app.use("/s", tracer(trace, "S"))
			app
				.use(tracer(trace, "A"))
				.get("/s/x")
				.use(tracer(trace, "R"))
				.handler((ctx) => ctx.res.text("ok", "x"))
		}
		const source = honey<{}>() as App
		register(source)
		const snapshot = source.toRouteTree()
		const topology: RouteTree = { ...snapshot, routes: {} }
		for (const [id, entry] of Object.entries(snapshot.routes)) {
			const { h: _live, ...data } = entry
			topology.routes[id] = data
		}
		const root = honey<{}>() as App
		root.routeTree(topology)
		register(root)
		return { derived: root.context({ v: 1 }) as unknown as App, root }
	},
	"toRouteTree round trip": (trace) => {
		const source = honey<{}>() as App
		source.use("/s", tracer(trace, "S"))
		source
			.use(tracer(trace, "A"))
			.get("/s/x")
			.use(tracer(trace, "R"))
			.handler((ctx) => ctx.res.text("ok", "x"))
		const root = honey<{}>() as App
		root.routeTree(source.toRouteTree())
		return { derived: root.context({ v: 1 }) as unknown as App, root }
	},
}

describe("one ordered chain: chain → scoped → route, wherever the route came from", () => {
	for (const [shape, build] of Object.entries(shapes)) {
		for (const via of ["root", "derived"] as const) {
			it(`${shape}, served from the ${via} handle`, async () => {
				const trace: string[] = []
				const app = build(trace)[via]
				const res = await app.fetch(req("/s/x"), {})
				expect(res.status).toBe(200)
				expect(trace).toEqual(["A", "S", "R"])
			})
		}
	}

	it("every shape and handle answers the same, request after request", async () => {
		for (const build of Object.values(shapes)) {
			const trace: string[] = []
			const { derived, root } = build(trace)
			await derived.fetch(req("/s/x"), {})
			await root.fetch(req("/s/x"), {})
			await derived.fetch(req("/s/x"), {})
			expect(trace).toEqual(["A", "S", "R", "A", "S", "R", "A", "S", "R"])
		}
	})
})

/* ──── H10, H11, H13, H15 ──── */

describe("what a route runs does not depend on the serving handle", () => {
	const deny = createMiddleware(async () => new Response("denied", { status: 401 }))

	it("H10: serving the sub first does not leak its chain into the parent (or back)", async () => {
		const sub = honey<{}>()
		sub.get("/data").handler((ctx) => ctx.res.text("ok", "data"))
		expect((await sub.fetch(req("/data"), {})).status).toBe(200)
		const parent = honey<{}>().use(deny).route(sub)
		expect((await parent.fetch(req("/data"), {})).status).toBe(401)
		expect((await sub.fetch(req("/data"), {})).status).toBe(200)
	})

	it("H11: routes mounted on a chain run the chain, like routes registered on it", async () => {
		const app = honey<{}>()
		const authed = app.use(deny)
		authed.get("/me").handler((ctx) => ctx.res.text("ok", "me"))
		const admin = honey<{}>()
		admin.get("/admin/users").handler((ctx) => ctx.res.text("ok", "users"))
		authed.route(admin)
		expect((await app.fetch(req("/me"), {})).status).toBe(401)
		expect((await app.fetch(req("/admin/users"), {})).status).toBe(401)
		expect((await authed.fetch(req("/admin/users"), {})).status).toBe(401)
	})

	it("H13: chain middleware runs before scoped middleware on mounted routes", async () => {
		const sub = honey<{}>()
		const requireAdmin = createMiddleware(async (ctx, next) => {
			const user = (ctx as { user?: { admin: boolean } }).user
			if (!user?.admin) return new Response("no user", { status: 403 })
			return next()
		})
		sub.use("/admin", requireAdmin)
		sub.get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))
		const auth = createMiddleware(async (_ctx, next) => next({ user: { admin: true } }))
		const app = honey<{}>().use(auth).route(sub)
		expect((await app.fetch(req("/admin/x"), {})).status).toBe(200)
	})

	it("H15: a route registered before a later use() runs its chain once and not the later middleware", async () => {
		const trace: string[] = []
		const withA = honey<{}>().use(tracer(trace, "a"))
		withA.get("/public").handler((ctx) => ctx.res.text("ok", "p"))
		const withB = withA.use(tracer(trace, "b"))
		withB.get("/private").handler((ctx) => ctx.res.text("ok", "x"))
		await withB.fetch(req("/public"), {})
		expect(trace).toEqual(["a"])
		trace.length = 0
		await withB.fetch(req("/private"), {})
		expect(trace).toEqual(["a", "b"])
	})
})

/* ──── H12: scopes guard request paths ──── */

describe("scopes guard request paths, in the route grammar", () => {
	const deny = createMiddleware(async () => new Response("denied", { status: 401 }))

	it("a scope covers a root wildcard route for paths inside it, not outside", async () => {
		const app = honey<{}>()
		app.use("/admin", deny)
		app.all("/*").handler((ctx) => ctx.res.text("ok", "spa"))
		expect((await app.fetch(req("/admin/secret"), {})).status).toBe(401)
		expect((await app.fetch(req("/admin"), {})).status).toBe(401)
		expect((await app.fetch(req("/home"), {})).status).toBe(200)
		expect((await app.fetch(req("/administrator"), {})).status).toBe(200)
	})

	it("a scope covers a param route when the param lands on the scoped literal", async () => {
		const app = honey<{}>()
		app.use("/admin", deny)
		app.get("/:section/users").handler((ctx) => ctx.res.text("ok", ctx.params.section))
		expect((await app.fetch(req("/admin/users"), {})).status).toBe(401)
		expect((await app.fetch(req("/%61dmin/users"), {})).status).toBe(401)
		expect((await app.fetch(req("//admin/users"), {})).status).toBe(401)
		expect((await app.fetch(req("/blog/users"), {})).status).toBe(200)
	})

	it("`/admin/*` scopes everything under /admin", async () => {
		const app = honey<{}>()
		app.use("/admin/*", deny)
		app.get("/admin").handler((ctx) => ctx.res.text("ok", "a"))
		app.get("/admin/x/y").handler((ctx) => ctx.res.text("ok", "b"))
		expect((await app.fetch(req("/admin"), {})).status).toBe(401)
		expect((await app.fetch(req("/admin/x/y"), {})).status).toBe(401)
	})

	it("`/orgs/:id` scopes `/orgs/:orgId/members` whatever the param is called", async () => {
		const app = honey<{}>()
		app.use("/orgs/:id", deny)
		app.get("/orgs/:orgId/members").handler((ctx) => ctx.res.text("ok", "m"))
		expect((await app.fetch(req("/orgs/7/members"), {})).status).toBe(401)
	})

	it("a scope string the grammar cannot express is rejected", () => {
		expect(() => honey<{}>().use("/a/../b", deny)).toThrow(/Invalid route pattern/)
		expect(() => honey<{}>().use("/*/x", deny)).toThrow(/Invalid route pattern/)
	})

	it("a scope registered after a route still guards it, from any handle", async () => {
		const app = honey<{}>()
		const v1 = app.basePath("/v1")
		v1.get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))
		app.use("/v1/admin", deny)
		expect((await v1.fetch(req("/v1/admin/x"), {})).status).toBe(401)
	})
})

/* ──── H16: every next() is an error boundary ──── */

describe("errors thrown inside the chain still pass through outer middleware", () => {
	const stamp = createMiddleware(async (_ctx, next) => {
		const res = await next()
		const out = new Response(res.body, res)
		out.headers.set("x-outer", "1")
		return out
	})

	it("a middleware throw reaches outer post-next() code as a response", async () => {
		const failing = createMiddleware(async () => {
			throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
		})
		const app = honey<{}>().use(stamp).use(failing)
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const res = await app.fetch(req("/x"), {})
		expect(res.status).toBe(403)
		expect(res.headers.get("x-outer")).toBe("1")
	})

	it("built-in csrf, body validation and handler throws all keep outer headers", async () => {
		const { z } = await import("zod")
		const app = honey<{}>()
			.use(stamp)
			.use(csrf({ origin: "https://app.example" }))
		app.post("/form").handler((ctx) => ctx.res.text("ok", "x"))
		app
			.post("/json")
			.input({ json: z.object({ n: z.number() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json))
		app.get("/boom").handler(() => {
			throw new Error("boom")
		})
		const blocked = await app.fetch(
			req("/form", {
				body: "a=1",
				headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
				method: "POST",
			}),
			{},
		)
		expect(blocked.status).toBe(403)
		expect(blocked.headers.get("x-outer")).toBe("1")
		const invalid = await app.fetch(
			req("/json", { body: '{"n":"x"}', headers: { "content-type": "application/json" }, method: "POST" }),
			{},
		)
		expect(invalid.status).toBe(400)
		expect(invalid.headers.get("x-outer")).toBe("1")
		const boom = await app.fetch(req("/boom"), {})
		expect(boom.status).toBe(500)
		expect(boom.headers.get("x-outer")).toBe("1")
	})

	it("the 404 and 405 pipelines convert errors the same way", async () => {
		const failing = createMiddleware(async (ctx, next) => {
			if ((ctx as { path: string }).path.startsWith("/locked")) {
				throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
			}
			return next()
		})
		const app = honey<{}>().use(stamp).use(failing)
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const res = await app.fetch(req("/locked/missing"), {})
		expect(res.status).toBe(403)
		expect(res.headers.get("x-outer")).toBe("1")
	})
})

/* ──── 404, 405, preflight ──── */

describe("404, 405 and preflight run through the same pipeline", () => {
	const errors = defineErrors({ unauthorized: "unauthorized" })

	it("H14: ctx.errors and ctx.path exist on unknown paths", async () => {
		const seen: string[] = []
		const auth = createMiddleware(async (ctx, next) => {
			seen.push((ctx as { path: string }).path)
			if (!(ctx as { headers: Record<string, string> }).headers["authorization"]) {
				throw (ctx as unknown as { errors: typeof errors }).errors.unauthorized()
			}
			return next()
		})
		const app = honey<{}>().errorFactory(errors).use(auth)
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const missing = await app.fetch(req("/nope"), {})
		expect(missing.status).toBe(401)
		const notAllowed = await app.fetch(req("/x", { method: "POST" }), {})
		expect(notAllowed.status).toBe(401)
		expect(seen).toEqual(["/nope", "/x"])
	})

	it("the app-wide chain runs exactly once on 404 and 405, whichever handle serves", async () => {
		const trace: string[] = []
		const root = honey<{}>()
		const app = root.use(tracer(trace, "log"))
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		for (const handle of [root, app]) {
			trace.length = 0
			expect((await handle.fetch(req("/missing"), {})).status).toBe(404)
			expect((await handle.fetch(req("/x", { method: "DELETE" }), {})).status).toBe(405)
			expect(trace).toEqual(["log", "log"])
		}
	})

	it("preflight runs the requested method's chain, including scoped cors", async () => {
		const app = honey<{}>()
		app.use("/api", cors({ origin: "https://admin.example" }))
		app.get("/api/x").handler((ctx) => ctx.res.text("ok", "x"))
		app.post("/api/x").handler((ctx) => ctx.res.text("ok", "x"))
		const res = await app.fetch(
			req("/api/x", {
				headers: { "access-control-request-method": "POST", origin: "https://admin.example" },
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("https://admin.example")
	})

	it("a GET route's open policy does not answer the preflight for a restricted POST", async () => {
		const app = honey<{}>()
		app
			.use(cors({ origin: "*" }))
			.get("/thing")
			.handler((ctx) => ctx.res.text("ok", "x"))
		app
			.use(cors({ origin: "https://admin.example" }))
			.post("/thing")
			.handler((ctx) => ctx.res.text("ok", "x"))
		const res = await app.fetch(
			req("/thing", {
				headers: { "access-control-request-method": "POST", origin: "https://evil.example" },
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})

	it("a preflight nothing answers runs the chain once and returns the 405", async () => {
		const trace: string[] = []
		const app = honey<{}>().use(tracer(trace, "a"))
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const res = await app.fetch(
			req("/x", { headers: { "access-control-request-method": "GET" }, method: "OPTIONS" }),
			{},
		)
		expect(res.status).toBe(405)
		expect(trace).toEqual(["a"])
	})
})

/* ──── error keys, meta, factory, context: from the finalized chain ──── */

describe("errors and meta come from the chain that runs", () => {
	const errors = defineErrors({ forbidden: "forbidden", gone: "gone", nope: "bad_request" })

	it("chain-level middleware errors are declared, and csrf's 403 survives defaultErrors", async () => {
		const guard = defineMiddleware({
			errors: [errors, "nope"],
			fn: async (_c, next) => next(),
		})
		const app = honey<{}>().errorFactory(errors).defaultErrors("gone").use(guard).use(csrf())
		app.post("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const [route] = generateManifest(app).routes
		expect(route?.errors).toEqual(["gone", "nope"])
		const res = await app.fetch(
			req("/x", {
				body: "a=1",
				headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("defaultErrors applies to routes registered before the call; internal routes do not leak scoped keys", () => {
		const scopedGuard = defineMiddleware({ errors: [errors, "nope"], fn: async (_c, next) => next() })
		const app = honey<{}>().errorFactory(errors)
		app.get("/early").handler((ctx) => ctx.res.text("ok", "x"))
		app.defaultErrors("gone")
		app.manifest()
		app.use("/admin", scopedGuard)
		app.get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))
		app.get("/later").handler((ctx) => ctx.res.text("ok", "x"))
		const byPath = Object.fromEntries(generateManifest(app).routes.map((r) => [r.path, r.errors]))
		expect(byPath["/early"]).toEqual(["gone"])
		expect(byPath["/admin/x"]).toEqual(["gone", "nope"])
		expect(byPath["/later"]).toEqual(["gone"])
	})

	it("mounted routes keep their own error factory and context values", async () => {
		const subErrors = defineErrors({ sub_failed: "conflict" })
		const sub = honey<{}>().errorFactory(subErrors).context({ tenant: "sub" })
		sub
			.get("/sub")
			.errors("sub_failed")
			.handler((ctx) => {
				if (ctx.tenant !== "sub") return ctx.res.text("ok", "wrong")
				throw ctx.errors.sub_failed()
			})
		const app = honey<{}>().errorFactory(errors).route(sub)
		const res = await app.fetch(req("/sub"), {})
		expect(res.status).toBe(409)
		const [route] = generateManifest(app).errors.filter((e) => e.errorKey === "sub_failed")
		expect(route?.status).toBe(409)
	})

	it("contributed meta merges in run order and explicit meta wins; mounted routes get it too", () => {
		const a = createMiddleware(async (_c, next) => next(), { meta: { owner: "chain", tier: 1 } })
		const s = createMiddleware(async (_c, next) => next(), { meta: { tier: 2 } })
		const sub = honey<{}>()
		sub
			.get("/s/x")
			.meta({ owner: "route" })
			.handler((ctx) => ctx.res.text("ok", "x"))
		const app = honey<{}>()
		app.use("/s", s)
		app.use(a).route(sub)
		const [route] = generateManifest(app).routes
		expect(route?.meta).toEqual({ owner: "route", tier: 2 })
		expect(route?.middleware).toHaveLength(2)
	})
})

/* ──── WS routes ──── */

describe("websocket routes use the same order", () => {
	it("chain runs before scoped on WS routes", async () => {
		const trace: string[] = []
		const app = honey<{}>().wsAdapter(testWsAdapter())
		app.use("/rooms", tracer(trace, "scoped"))
		app.use(tracer(trace, "chain")).ws("/rooms/:id").use(tracer(trace, "route")).handler({})
		const res = await app.fetch(req("/rooms/1", { headers: { upgrade: "websocket" } }), {})
		expect(res.status).toBe(101)
		expect(trace).toEqual(["chain", "scoped", "route"])
	})
})

describe("websocket input is validated before the upgrade", () => {
	it("a missing token answers 400 and never upgrades", async () => {
		const { z } = await import("zod")
		let opened = false
		const app = honey<{}>().wsAdapter(testWsAdapter())
		app
			.ws("/live")
			.input({ search: z.object({ token: z.string().min(1) }) })
			.handler({
				onOpen() {
					opened = true
				},
			})
		const rejected = await app.fetch(req("/live", { headers: { upgrade: "websocket" } }), {})
		expect(rejected.status).toBe(400)
		expect(opened).toBe(false)
		const ok = await app.fetch(req("/live?token=t", { headers: { upgrade: "websocket" } }), {})
		expect(ok.status).toBe(101)
		expect(opened).toBe(true)
	})
})

describe("codegen sees what runs", () => {
	it("manifest error keys, meta and middleware equal the runtime record, for every shape", async () => {
		const errors = defineErrors({ gone: "gone", nope: "bad_request" })
		const scoped = defineMiddleware({
			errors: [errors, "nope"],
			fn: async (_c, next) => next(),
			meta: { area: "s" },
		})
		const seen: Array<{ errorKeys: string[]; meta: unknown }> = []
		const sub = honey<{}>().errorFactory(errors).defaultErrors("gone")
		sub.use("/s", scoped)
		sub.get("/s/x").handler((ctx) => {
			seen.push({ errorKeys: Object.keys(ctx.errors).sort(), meta: ctx.meta })
			return ctx.res.text("ok", "x")
		})
		const app = honey<{}>().route(sub)
		await app.fetch(req("/s/x"), {})
		const [route] = generateManifest(app).routes
		expect([...(route?.errors ?? [])].sort()).toEqual(seen[0]?.errorKeys)
		expect(route?.meta).toEqual(seen[0]?.meta)
		expect(route?.meta).toEqual({ area: "s" })
		expect(route?.middleware).toHaveLength(1)
	})
})

/* ──── reporting what would silently not run ──── */

describe("finalize reports middleware and routes that would silently be missing", () => {
	const auth = createMiddleware(async () => new Response("denied", { status: 401 }))

	it("app.use(mw) as a bare statement is an error, not an unprotected route", () => {
		const app = honey<{}>()
		app.use(auth)
		app.get("/secret").handler((ctx) => ctx.res.text("ok", "secret"))
		expect(() => app.fetch(req("/secret"), {})).toThrow(/returned a handle that never registers a route/)
	})

	it("a route builder without .handler() is an error", () => {
		const app = honey<{}>()
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		app.get("/forgotten")
		expect(() => app.fetch(req("/a"), {})).toThrow(/GET \/forgotten was declared but never got a \.handler\(\)/)
	})

	it("a chain used only through a derived handle counts as used", async () => {
		const app = honey<{}>()
		app
			.use(auth)
			.basePath("/v1")
			.get("/x")
			.handler((ctx) => ctx.res.text("ok", "x"))
		expect((await app.fetch(req("/v1/x"), {})).status).toBe(401)
	})
})

/* ──── small ones ──── */

describe("context, telemetry and errors", () => {
	it("context() rejects every framework key at registration", () => {
		for (const key of ["searchAll", "meta", "path", "routePattern", "errors", "input", "realtime", "tap"]) {
			expect(() => honey<{}>().context({ [key]: 1 })).toThrow(/reserved key/)
		}
	})

	it("middleware additions cannot replace framework fields", async () => {
		const sneaky = createMiddleware(async (_ctx, next) => next({ path: "/admin", routePattern: "/x" }))
		const app = honey<{}>()
			.use(sneaky)
			.get("/x")
			.handler((ctx) => ctx.res.text("ok", `${ctx.path} ${ctx.routePattern}`))
		expect(await (await app.fetch(req("/x"), {})).text()).toBe("/x /x")
	})

	it("telemetry.onResponse fires once for a handler throw, a 404 and a 405", async () => {
		const statuses: number[] = []
		const app = honey<{}>().telemetry({ onResponse: ({ status }) => statuses.push(status) })
		app.get("/boom").handler(() => {
			throw new Error("x")
		})
		await app.fetch(req("/boom"), {})
		await app.fetch(req("/missing"), {})
		await app.fetch(req("/boom", { method: "POST" }), {})
		expect(statuses).toEqual([500, 404, 405])
	})

	it("an unknown status key is a 500, never a 200", () => {
		const err = new HoneyError({ errorKey: "x", status: "nonsense" as "conflict" })
		expect(err.status).toBe(500)
		expect(err.statusKey).toBe("internal_server_error")
	})
})
