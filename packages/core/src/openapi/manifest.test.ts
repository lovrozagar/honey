import { describe, expect, it } from "vitest"
import * as z from "zod"
import { HoneyError } from "../errors/error.ts"
import { defineErrors } from "../errors/errors.ts"
import { createMiddleware, defineMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import { generateManifest, type ManifestRoute } from "./manifest.ts"

/** Health, one organization, and creating one. */
function organizations() {
	const app = honey<{}>()
	app.get("/health").handler((c) => c.res.text("ok", "ok"))
	app.get("/v1/organizations/:orgId").handler((c) => c.res.json("ok", {}))
	app
		.post("/v1/organizations")
		.input({ json: z.object({ name: z.string() }) })
		.handler((c) => c.res.json("created", {}))
	return app
}

const find = (routes: readonly ManifestRoute[], method: string, path: string) =>
	routes.find((r) => r.method === method && r.path === path)

describe("generateManifest: one entry per route, by method and honey pattern", () => {
	// v0: c0233a6aa4
	// v0: e123e01a3e
	// v0: c1eda29526
	// v0: 466504544f
	// v0: 6d2bdf1853
	// v0: a722ec5e10
	it("lists each route's method, pattern and params in order", () => {
		const app = organizations()
		app.get("/orgs/:orgId/members/:memberId").handler((c) => c.res.json("ok", {}))
		expect(generateManifest(app).routes.map((r) => [r.method, r.path, r.params])).toEqual([
			["GET", "/health", []],
			["GET", "/v1/organizations/:orgId", ["orgId"]],
			["POST", "/v1/organizations", []],
			["GET", "/orgs/:orgId/members/:memberId", ["orgId", "memberId"]],
		])
	})

	// v0: f794ba99e7
	// v0: 380b8cbc40
	// v0: 22b777db17
	it("keeps a wildcard's pattern, names an optional param without ?, and lists every method of one path", () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((c) => c.res.text("ok", "f"))
		app.get("/items/:id?").handler((c) => c.res.text("ok", "i"))
		for (const method of ["get", "post", "put", "patch", "delete", "options", "head"] as const)
			app[method]("/r").handler((c) => c.res.text("ok", "r"))
		const { routes } = generateManifest(app)
		expect([
			find(routes, "GET", "/files/*path")?.params,
			routes.filter((r) => r.path.startsWith("/items")).map((r) => [r.path, r.params]),
			routes
				.filter((r) => r.path === "/r")
				.map((r) => r.method)
				.sort(),
		]).toEqual([["path"], [["/items/:id?", ["id"]]], ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]])
	})
})

describe("generateManifest: what a route declares", () => {
	// v0: 5f07005556
	// v0: 2f51fcbb53
	// v0: 6c15a64a94
	// v0: 2142fb5576
	// v0: 9167a75680
	it("gives each input source (input side) and each output media type and status (output side) as JSON Schema, and none for a route without", () => {
		const app = organizations()
		app
			.post("/test")
			.input({ json: z.object({ name: z.string() }), search: z.object({ page: z.number() }) })
			.output({
				"application/json": { created: z.object({ id: z.string() }), ok: z.object({ items: z.string().array() }) },
			})
			.handler((c) => c.res.json("ok", { items: [] }))
		const { routes } = generateManifest(app)
		const test = find(routes, "POST", "/test")
		expect([
			Object.keys(test?.input ?? {}),
			test?.input?.search,
			Object.keys(test?.output?.["application/json"] ?? {}),
			test?.output?.["application/json"]?.created,
			find(routes, "GET", "/health")?.input,
			find(routes, "GET", "/health")?.output,
		]).toEqual([
			["json", "search"],
			{ properties: { page: { type: "number" } }, required: ["page"], type: "object" },
			["created", "ok"],
			{ additionalProperties: false, properties: { id: { type: "string" } }, required: ["id"], type: "object" },
			undefined,
			undefined,
		])
	})
})

describe("generateManifest: a route's meta", () => {
	// v0: 333c08fd8f
	// v0: 7790799c89
	// v0: c31c533275
	// v0: 3ef040b604
	// v0: f4eeebd344
	// v0: 9b9191ae36
	// v0: 78e7bb7ebc
	// v0: ab8fc55fcf
	// v0: 3634311714
	it("keeps every meta key as written, invalidate included, its selectors once each, and {} for none", () => {
		const app = honey<{}>().meta<{ auth?: string; rateLimit?: string }>()
		app.get("/v1/users").handler((c) => c.res.text("ok", "ok"))
		app.get("/v1/users/:id").handler((c) => c.res.text("ok", "ok"))
		app
			.get("/orgs")
			.meta({ auth: "required", operationId: "listOrgs", rateLimit: "strict", summary: "List orgs", tags: ["Org"] })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/v1/users")
			.meta({ invalidate: ["GET /v1/users", "GET /v1/users/:id", "GET /v1/users"], operationId: "user.create" })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/v1/never")
			.meta({ invalidate: null })
			.handler((c) => c.res.text("ok", "ok"))
		app
			.post("/v1/nothing")
			.meta({ invalidate: [] })
			.handler((c) => c.res.text("ok", "ok"))
		const { routes } = generateManifest(app)
		expect([
			find(routes, "GET", "/v1/users")?.meta,
			find(routes, "GET", "/orgs")?.meta,
			find(routes, "POST", "/v1/users")?.meta,
			find(routes, "POST", "/v1/never")?.meta.invalidate,
			find(routes, "POST", "/v1/nothing")?.meta.invalidate,
		]).toEqual([
			{},
			{ auth: "required", operationId: "listOrgs", rateLimit: "strict", summary: "List orgs", tags: ["Org"] },
			{ invalidate: ["GET /v1/users", "GET /v1/users/:id"], operationId: "user.create" },
			null,
			[],
		])
	})
})

describe("generateManifest: errors", () => {
	// v0: 7ce5c80e46
	// v0: 6fa210cc8c
	it("lists each route's keys, and every key once across routes with the status its factory gives it", () => {
		const errors = defineErrors({ custom_err: "conflict", not_found: "not_found", other_err: "forbidden" })
		const app = honey<{}>().meta<{ auth?: boolean }>().errorFactory(errors)
		app
			.get("/items/:id")
			.errors("not_found")
			.meta({ auth: true })
			.handler((c) => c.res.json("ok", {}))
		app
			.get("/a")
			.errors(errors, "custom_err", "not_found")
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/b")
			.errors(errors, "other_err")
			.handler((c) => c.res.text("ok", "ok"))
		const manifest = generateManifest(app)
		expect([manifest.routes.map((r) => r.errors), manifest.routes[0]?.meta, manifest.errors]).toEqual([
			[["not_found"], ["custom_err", "not_found"], ["other_err"]],
			{ auth: true },
			[
				{ errorKey: "custom_err", status: 409, statusKey: "conflict" },
				{ errorKey: "not_found", status: 404, statusKey: "not_found" },
				{ errorKey: "other_err", status: 403, statusKey: "forbidden" },
			],
		])
	})

	// v0: 24f75dc7df
	// v0: 068d758463
	it("reads a key's status off its factory's ERROR_META, never by calling it, else its suffix, else unknown at 0", () => {
		const throwing = {
			broken_error: (): HoneyError => {
				throw new Error("factory called")
			},
		}
		const plain = { custom_error: () => new HoneyError({ errorKey: "custom_error", status: "bad_request" }) }
		const app = honey<{}>()
		app
			.get("/broken")
			.errors(throwing, "broken_error")
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/plain")
			.errors(plain, "custom_error")
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/inferred")
			.errors(defineErrors({ billing_not_found: "not_found" }), "billing_not_found")
			.handler((c) => c.res.text("ok", "ok"))
		expect(generateManifest(app).errors).toEqual([
			{ errorKey: "billing_not_found", status: 404, statusKey: "not_found" },
			{ errorKey: "broken_error", status: 0, statusKey: "unknown" },
			{ errorKey: "custom_error", status: 0, statusKey: "unknown" },
		])
	})
})

describe("generateManifest: the middleware a route runs", () => {
	// v0: 178e8aeccd
	// v0: f82f6740dd
	it("names each middleware a route runs, an anonymous one as anonymous", () => {
		const auth = createMiddleware(async (_c, next) => next())
		Object.defineProperty(auth, "name", { value: "authMiddleware" })
		const app = honey<{}>()
		app
			.get("/test")
			.use(auth)
			.use(createMiddleware(async (_c, next) => next()))
			.handler((c) => c.res.text("ok", "ok"))
		expect(generateManifest(app).routes[0]?.middleware).toEqual(["authMiddleware", "anonymous"])
	})

	// v0: bcdf605127
	it("gives a mounted route's keys, meta and middleware exactly as its request sees them", async () => {
		const errors = defineErrors({ gone: "gone", nope: "bad_request" })
		const scoped = defineMiddleware({ errors: [errors, "nope"], fn: async (_c, next) => next(), meta: { area: "s" } })
		const seen: { errorKeys: string[]; meta: unknown }[] = []
		const sub = honey<{}>().errorFactory(errors).defaultErrors("gone")
		sub.use("/s", scoped)
		sub.get("/s/x").handler((c) => {
			seen.push({ errorKeys: Object.keys(c.errors).sort(), meta: c.meta })
			return c.res.text("ok", "x")
		})
		const app = honey<{}>().route(sub)
		await app.fetch(new Request("http://x/s/x"), {})
		const [route] = generateManifest(app).routes
		expect([route?.errors, route?.meta, route?.middleware]).toEqual([seen[0]?.errorKeys, { area: "s" }, ["fn"]])
		expect(seen[0]?.meta).toEqual({ area: "s" })
	})
})

describe("generateManifest: what a served manifest publishes", () => {
	// v0: 2eaa86f90a
	it("leaves internal routes and every meta key the document would not show out of the published manifest", () => {
		const app = honey<{}>()
		app.metaSpec({ meta: { captcha: false, team: "x-team" } } as never)
		app
			.get("/public")
			.meta({ captcha: true, summary: "Public", team: "core", worker: "origin" } as never)
			.handler((c) => c.res.text("ok", "ok"))
		app
			.get("/admin/secret")
			.meta({ internal: true } as never)
			.handler((c) => c.res.text("ok", "ok"))
		const published = generateManifest(app, { visibility: "published" })
		expect([published.routes.map((r) => [r.path, r.meta]), generateManifest(app).routes.map((r) => r.path)]).toEqual([
			[["/public", { summary: "Public", team: "core" }]],
			["/public", "/admin/secret"],
		])
	})

	it("drops the routes filterRoutes rejects, shown each route's meta, method and pattern", () => {
		const shown: string[] = []
		const manifest = generateManifest(organizations(), {
			filterRoutes: ({ meta, method, path }) => {
				shown.push(`${method} ${path} ${JSON.stringify(meta)}`)
				return path !== "/health"
			},
		})
		expect([manifest.routes.map((r) => r.path), shown]).toEqual([
			["/v1/organizations/:orgId", "/v1/organizations"],
			["GET /health {}", "GET /v1/organizations/:orgId {}", "POST /v1/organizations {}"],
		])
	})
})
