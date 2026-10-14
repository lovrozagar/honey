/**
 * Composing an app: basePath prefixes, handles that share one app, and mounting sub-apps with
 * route(). A mounted route runs the mounting chain before its own, keeps its own settings and
 * context, and is a copy: neither side's later registrations leak into the other.
 */
import { describe, expect, it } from "vitest"
import type { HoneyContext } from "../../src/context/context.ts"
import { HoneyError } from "../../src/errors/error.ts"
import { errorI18n } from "../../src/i18n/error-i18n.ts"
import { cors } from "../../src/middleware/cors.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { type Honey, honey } from "../../src/routing/app.ts"

type App = Honey<{}>

async function send(app: { fetch: (r: Request, env: never) => Response | Promise<Response> }, target: string) {
	const res = await app.fetch(new Request(`http://localhost${target}`), {} as never)
	return { body: await res.text(), location: res.headers.get("location"), status: res.status }
}

/** A handle of a plain app, under any basePath. */
type Handle<TBase extends string> = Honey<{}, HoneyContext<{}>, {}, never, never, never, TBase>

/** A route answering with its full pattern. */
function pattern<TBase extends string>(app: Handle<TBase>, path: string) {
	app.get(path).handler((ctx) => ctx.res.text("ok", ctx.routePattern))
}

/** A middleware that records `name` each time it runs. */
const tracer = (trace: string[], name: string) =>
	createMiddleware((_ctx, next) => {
		trace.push(name)
		return next()
	})

const deny = (status: number) => createMiddleware(async () => new Response("denied", { status }))

describe("basePath: prefixing", () => {
	// v0: c3cfdb34b5
	// v0: 713989d8d3
	// v0: f39f07caa8
	// v0: ee339cf151
	// v0: 7ec4562329
	// v0: 351797f6cf
	// v0: 87b16f8028
	// v0: c4b3cdf794
	// v0: 909a8f727d
	// v0: c9ee50eee6
	// v0: b6cb7c9c8b
	// v0: bdd89b07d3
	// v0: c07a5aad74
	// v0: 319c8086b7
	// v0: 426d350836
	it.each([
		["/api", "/api/users", "/users"],
		["/api/", "/api/users", "/users"],
		["api", "/api/users", "/users"],
		["/api/v2", "/api/v2/users", "/api/users"],
		["", "/users", "/api/users"],
	])("basePath(%j) serves /users at %s, not at %s", async (base, served, missed) => {
		const app = honey<{}>()
		pattern(app.basePath(base), "/users")
		expect(await send(app, served)).toMatchObject({ body: served, status: 200 })
		expect((await send(app, missed)).status).toBe(404)
	})

	// v0: 157bb796b6
	it("chained basePath calls compose", async () => {
		const app = honey<{}>()
		pattern(app.basePath("/api").basePath("/v2"), "/users")
		expect(await send(app, "/api/v2/users")).toMatchObject({ body: "/api/v2/users", status: 200 })
		expect((await send(app, "/v2/users")).status).toBe(404)
	})

	// v0: 2a015ca6dc
	it("a route that repeats the prefix is served under it once more, the prefix never stripped twice", async () => {
		const app = honey<{}>()
		pattern(app.basePath("/api"), "/api/deep")
		expect(await send(app, "/api/api/deep")).toMatchObject({ body: "/api/api/deep", status: 200 })
		expect((await send(app, "/api/deep")).status).toBe(404)
	})
})

describe("basePath: the bare prefix and segment boundaries", () => {
	// v0: f34b479d8b
	// v0: a0aee81a59
	// v0: fde3ba9be9
	// v0: 008d960bed
	// v0: b987b43110
	// v0: dff98d40b5
	// v0: 814476e66c
	// v0: a44e143d94
	// v0: 5dccddb08d
	it("the root route under a basePath answers the bare prefix, with or without a trailing slash", async () => {
		const app = honey<{}>()
		pattern(app.basePath("/api"), "/")
		for (const target of ["/api", "/api/"]) expect(await send(app, target)).toMatchObject({ body: "/api", status: 200 })
		expect((await send(app, "/")).status).toBe(404)
	})

	// v0: e792c8dc20
	// v0: a8e9297de5
	// v0: 11f9af4e6f
	// v0: 7232f16606
	// v0: 850e20cc92
	it("a basePath matches whole segments only, and an encoded slash never makes one", async () => {
		const app = honey<{}>()
		const api = app.basePath("/api")
		pattern(api, "/health")
		pattern(api, "/-docs")
		pattern(api, "/ary")
		expect((await send(app, "/api/health")).status).toBe(200)
		expect((await send(app, "/api-docs")).status).toBe(404)
		expect((await send(app, "/apiary")).status).toBe(404)
		expect((await send(app, "/api%2Fhealth")).status).toBe(400)
	})

	// v0: 11e02c0725
	it("a dot segment resolves before the prefix is matched: it cannot climb out of the prefix", async () => {
		const app = honey<{}>()
		pattern(app.basePath("/api"), "/secret")
		expect((await send(app, "/api/../secret")).status).toBe(404)
		/* a target the runtime left unresolved resolves the same way */
		const raw = new Request("http://localhost/")
		Object.defineProperty(raw, "url", { value: "http://localhost/api/../secret" })
		expect((await app.fetch(raw, {})).status).toBe(404)
		expect((await send(app, "/api/x/../secret")).status).toBe(200)
	})

	// v0: 4e11d0b655
	// v0: a5e2e64182
	// v0: 40b5b2f749
	it("the trailing-slash policy redirects the full path, prefix included", async () => {
		const app = honey<{}>().trailingSlash("strip")
		pattern(app.basePath("/api"), "/health")
		expect(await send(app, "/api/health/")).toMatchObject({ location: "/api/health", status: 308 })
		const enforced = honey<{}>().trailingSlash("enforce")
		pattern(enforced.basePath("/api"), "/")
		expect(await send(enforced, "/api")).toMatchObject({ location: "/api/", status: 308 })
		expect(await send(enforced, "/api/")).toMatchObject({ body: "/api", status: 200 })
	})
})

describe("handles share one app", () => {
	// v0: f36fd2d49c
	// v0: 7229de28b0
	// v0: 0565c75477
	// v0: 079c03dde6
	it("a setting made on one handle applies to routes on every handle", async () => {
		const root = honey<{}>()
			.onNotFound(() => new Response("custom 404", { status: 404 }))
			.onMethodNotAllowed(() => new Response("custom 405", { status: 405 }))
			.defaultErrorFormatter((error) => ({ formatted: error.errorKey }))
		const authed = root.basePath("/api").use(createMiddleware((_ctx, next) => next()))
		authed.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "test", status: "bad_request" })
		})
		expect(await send(authed, "/nope")).toMatchObject({ body: "custom 404", status: 404 })
		const wrong = await authed.fetch(new Request("http://localhost/api/fail", { method: "POST" }), {})
		expect([wrong.status, await wrong.text()]).toEqual([405, "custom 405"])
		expect(await send(authed, "/api/fail")).toEqual({ body: '{"formatted":"test"}', location: null, status: 400 })
	})
})

describe("handles share one app: its error settings", () => {
	// v0: 74ce58529c
	// v0: 7f7e45f108
	it("errorI18n and onError set on the app answer for routes registered through a use() handle", async () => {
		const app = honey<{}>()
			.errorI18n(errorI18n({ errors: { en: { test: "Translated" } }, resolveLocale: () => "en" }))
			.onError((error) => (error instanceof HoneyError ? undefined : new Response("custom", { status: 503 })))
		const authed = app.use(createMiddleware((_ctx, next) => next()))
		authed.get("/known").handler(() => {
			throw new HoneyError({ errorKey: "test", status: "bad_request" })
		})
		authed.get("/unknown").handler(() => {
			throw new Error("boom")
		})
		const known = await authed.fetch(new Request("http://localhost/known"), {})
		expect([known.status, ((await known.json()) as { message: string }).message]).toEqual([400, "Translated"])
		expect(await send(authed, "/unknown")).toMatchObject({ body: "custom", status: 503 })
	})

	// v0: 2c2daa6f20
	// v0: b1a781301c
	// v0: edaea58d24
	it("a route registered on any handle is served by every handle, running the chain it was registered with", async () => {
		const base = honey<{}>()
		base.get("/public").handler((ctx) => ctx.res.json("ok", { public: true }))
		const authed = base.use(createMiddleware((_ctx, next) => next({ auth: true })))
		authed.get("/private").handler((ctx) => ctx.res.json("ok", { auth: ctx.auth }))
		/* registered on the parent after the child handle exists */
		base.get("/late").handler((ctx) => ctx.res.json("ok", { late: true }))
		for (const handle of [base, authed]) {
			expect(JSON.parse((await send(handle, "/public")).body)).toEqual({ public: true })
			expect(JSON.parse((await send(handle, "/private")).body)).toEqual({ auth: true })
			expect(JSON.parse((await send(handle, "/late")).body)).toEqual({ late: true })
		}
	})

	// v0: 40d0c4778e
	it("separate apps share nothing", async () => {
		const a = honey<{}>()
		const b = honey<{}>()
		a.get("/shared").handler((ctx) => ctx.res.text("ok", "a"))
		b.get("/shared").handler((ctx) => ctx.res.text("ok", "b"))
		a.get("/only-a").handler((ctx) => ctx.res.text("ok", "a"))
		expect([(await send(a, "/shared")).body, (await send(b, "/shared")).body]).toEqual(["a", "b"])
		expect((await send(b, "/only-a")).status).toBe(404)
	})
})

describe("mounting a sub-app: what is served", () => {
	// v0: 3fff9f50df
	// v0: a9d8773b18
	// v0: 68ed5d6d3a
	// v0: 98e0f243fd
	// v0: 7a10e3def8
	it("route(sub) serves every sub's routes, params included, beside the parent's own", async () => {
		const auth = honey<{}>()
		auth.get("/login").handler((ctx) => ctx.res.text("ok", "login"))
		const orgs = honey<{}>()
		orgs.get("/orgs/:orgId").handler((ctx) => ctx.res.json("ok", { id: ctx.params.orgId }))
		const app = honey<{}>()
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))
		app.route(auth).route(orgs)
		expect((await send(app, "/")).body).toBe("root")
		expect((await send(app, "/login")).body).toBe("login")
		expect(JSON.parse((await send(app, "/orgs/o-1")).body)).toEqual({ id: "o-1" })
	})

	// v0: dccba08be1
	// v0: 4fb2a147db
	// v0: a8d598ea9a
	// v0: 90392c4dac
	it.each([
		["route(sub)", (app: App, sub: App) => app.route(sub), ["/users", "/admin/x", "/"], "/v1/users"],
		[
			"basePath('/v1').route(sub)",
			(app: App, sub: App) => app.basePath("/v1").route(sub),
			["/v1/users", "/v1/admin/x", "/v1"],
			"/users",
		],
		["route('/v2', sub)", (app: App, sub: App) => app.route("/v2", sub), ["/v2/users", "/v2/admin/x", "/v2"], "/users"],
	] as const)(
		"%s serves the sub's routes, its own basePath kept, under the mount",
		async (_label, mount, paths, missed) => {
			const sub = honey<{}>()
			pattern(sub, "/users")
			pattern(sub, "/")
			pattern(sub.basePath("/admin"), "/x")
			const app = honey<{}>()
			mount(app, sub)
			for (const path of paths) expect(await send(app, path)).toMatchObject({ body: path, status: 200 })
			expect((await send(app, missed)).status).toBe(404)
		},
	)

	// v0: 97f2d31012
	// v0: 4bb887656f
	it("a route both sides register, or route(prefix) with no sub, is an error", () => {
		const sub = honey<{}>()
		pattern(sub, "/health")
		const app = honey<{}>()
		pattern(app, "/health")
		expect(() => app.route(sub)).toThrow("Duplicate route: GET /health")
		expect(() => (app as unknown as { route: (p: string) => unknown }).route("/x")).toThrow(/needs the sub-app/)
	})
})

describe("mounting a sub-app: chains and scopes", () => {
	// v0: a2f656dadb
	// v0: 6de3a06f3e
	// v0: 93450d5123
	// v0: 0147d10cc1
	it("mounted routes run the mounting chain, then their own chain and scopes; the parent's routes run neither", async () => {
		const trace: string[] = []
		const sub = honey<{}>()
		sub.use("/secret", deny(403))
		sub
			.use(tracer(trace, "sub"))
			.get("/guarded")
			.handler((ctx) => ctx.res.text("ok", ctx.path))
		sub.get("/secret/a").handler((ctx) => ctx.res.text("ok", "secret"))
		const app = honey<{}>()
		const withParent = app.use(tracer(trace, "parent"))
		withParent.get("/parent").handler((ctx) => ctx.res.text("ok", "parent"))
		withParent.route("/api", sub)
		expect(await send(app, "/api/guarded")).toMatchObject({ body: "/api/guarded", status: 200 })
		expect(trace).toEqual(["parent", "sub"])
		trace.length = 0
		expect((await send(app, "/parent")).status).toBe(200)
		expect(trace).toEqual(["parent"])
		expect((await send(app, "/api/secret/a")).status).toBe(403)
	})
})

describe("a mounted route is a copy", () => {
	// v0: 84fe069da7
	it("two parents mounting one sub each keep their own scopes", async () => {
		const sub = honey<{}>()
		pattern(sub, "/api/users")
		const p1 = honey<{}>()
		p1.use("/api/admin", deny(403))
		p1.route(sub)
		pattern(p1, "/api/admin")
		const p2 = honey<{}>().route(sub)
		expect((await send(p1, "/api/admin")).status).toBe(403)
		expect((await send(p2, "/api/admin")).status).toBe(404)
		expect((await send(sub, "/api/admin")).status).toBe(404)
		for (const app of [p1, p2, sub]) expect((await send(app, "/api/users")).status).toBe(200)
	})

	// v0: e5126955a5
	it("routes the sub registers after mounting stay its own", async () => {
		const sub = honey<{}>()
		pattern(sub, "/a")
		const parent = honey<{}>().route(sub)
		pattern(sub, "/b")
		expect((await send(parent, "/a")).status).toBe(200)
		expect((await send(parent, "/b")).status).toBe(404)
		expect((await send(sub, "/b")).status).toBe(200)
	})
})

describe("a mounted app under concurrent requests", () => {
	// v0: 75644bc34e
	it("route() beside a scoped use and an app-wide CORS: every answer right, preflights on unknown paths included", async () => {
		const parent = honey<{}>().use(cors({ origin: "*" }))
		parent
			.use(
				"/admin",
				createMiddleware(async (_ctx, next) => next({ rid: "r1" })),
			)
			.get("/admin/x")
			.handler((ctx) => ctx.res.json("ok", { rid: ctx.rid }))
		const extra = honey<{}>()
		extra.get("/extra").handler((ctx) => ctx.res.text("ok", "extra"))
		parent.route(extra)
		const origin = { origin: "http://app.example" }
		const preflight = { headers: { ...origin, "access-control-request-method": "GET" }, method: "OPTIONS" }
		const jobs = Array.from({ length: 60 }, (_, i) =>
			[
				() => parent.fetch(new Request("http://localhost/admin/x", { headers: origin }), {}),
				() => parent.fetch(new Request("http://localhost/extra"), {}),
				() => parent.fetch(new Request("http://localhost/missing", preflight), {}),
			][i % 3]?.(),
		)
		const answers = await Promise.all(
			jobs.map(async (job) => {
				const res = (await job) as Response
				return [res.status, res.headers.get("access-control-allow-origin"), await res.text()]
			}),
		)
		expect(answers).toEqual(
			Array.from(
				{ length: 60 },
				(_, i) =>
					[
						[200, "*", '{"rid":"r1"}'],
						/* same-origin: CORS has nothing to say */
						[200, null, "extra"],
						[204, "*", ""],
					][i % 3],
			),
		)
	})
})
