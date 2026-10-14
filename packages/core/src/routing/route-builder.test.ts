import { describe, expect, expectTypeOf, it } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { defineErrors } from "../errors/errors.ts"
import { defineMiddleware, type MiddlewareFn } from "../middleware/middleware.ts"
import { GRAPH, honey } from "./app.ts"
import { finalTable } from "./dispatch.ts"

const errors = defineErrors({
	email_taken: "conflict",
	invalid_input: "bad_request",
	org_limit_reached: "forbidden",
	org_slug_taken: "conflict",
})

const boundaryErrors = defineErrors({
	auth_error: "internal_server_error",
	internal_server_error: "internal_server_error",
	not_found: "not_found",
	profile_error: "internal_server_error",
	schema_error: "internal_server_error",
})

type DbCtx = { db: string }
const withDb: MiddlewareFn<{}, DbCtx> = async (_ctx, next) => next({ db: "test-db" })
type AuthCtx = { user: { id: string } }
const withAuth: MiddlewareFn<DbCtx, AuthCtx> = async (_ctx, next) => next({ user: { id: "u1" } })

const fetchJson = async (app: { fetch: (r: Request, env: {}) => Response | Promise<Response> }, path: string) => {
	const res = await app.fetch(new Request(`http://localhost${path}`), {})
	return { body: (await res.json()) as Record<string, unknown>, status: res.status }
}

describe("RouteBuilder type inference > input and output", () => {
	// v0: 0cdc648c4b
	it("handler ctx has no input property without .input()", () => {
		honey<{}>()
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx).not.toHaveProperty("input")
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 7bcc1bb352
	it("without .output(), ctx.json accepts any StatusKey", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("created", { anything: true }))
		expect(await fetchJson(app, "/test")).toEqual({ body: { anything: true }, status: 201 })
	})
})

describe("RouteBuilder type inference > path param types", () => {
	// v0: 2feb2fc30d
	it("single param inferred from path", () => {
		honey<{}>()
			.get("/users/:id")
			.handler((ctx) => {
				expectTypeOf(ctx.params.id).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 85d5006667
	it("multiple params inferred from path", () => {
		honey<{}>()
			.get("/users/:userId/posts/:postId")
			.handler((ctx) => {
				expectTypeOf(ctx.params.userId).toEqualTypeOf<string>()
				expectTypeOf(ctx.params.postId).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 7c0132f759
	it("wildcard param inferred", () => {
		honey<{}>()
			.get("/files/*path")
			.handler((ctx) => {
				expectTypeOf(ctx.params.path).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 3f6106e491
	it("no params → Record<string, string>", () => {
		honey<{}>()
			.get("/static")
			.handler((ctx) => {
				expectTypeOf(ctx.params).toEqualTypeOf<Record<string, string>>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("RouteBuilder type inference > per-route .use() type accumulation", () => {
	// v0: 28c9af69a7
	it("per-route .use() adds typed context to handler", () => {
		honey<{}>()
			.get("/test")
			.use(withDb)
			.handler((ctx) => {
				expectTypeOf(ctx.db).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: f95826d9d6
	it("chained per-route .use() accumulates context", () => {
		honey<{}>()
			.get("/test")
			.use(withDb)
			.use(withAuth)
			.handler((ctx) => {
				expectTypeOf(ctx.user.id).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: ba5b946902
	it("per-route .use() ctx available at runtime", async () => {
		const h = honey<{}>()
		h.get("/test")
			.use(withDb)
			.handler((ctx) => ctx.res.json("ok", { db: ctx.db }))
		expect(await fetchJson(h, "/test")).toEqual({ body: { db: "test-db" }, status: 200 })
	})

	// v0: 5b31b6f015
	it("per-route + global middleware combine", async () => {
		const chain = honey<{}>().use(withDb)
		chain
			.get("/test")
			.use(withAuth)
			.handler((ctx) => ctx.res.json("ok", { db: ctx.db, userId: ctx.user.id }))
		expect((await fetchJson(chain, "/test")).body).toEqual({ db: "test-db", userId: "u1" })
	})

	// v0: fb9d3b3996
	it("chained middleware requirements enforced", () => {
		expectTypeOf(honey<{}>().use(withDb).use(withAuth)).toHaveProperty("get")
	})
})

describe("RouteBuilder type inference > middleware errors tied to factory", () => {
	// v0: e83975eeb1
	it("defineMiddleware constrains error keys to factory", () => {
		const mw = defineMiddleware({ errors: [errors, "email_taken", "org_slug_taken"], fn: async (_ctx, next) => next() })
		expect(mw.errors).toEqual(["email_taken", "org_slug_taken"])
	})

	// v0: cc8702d138
	it("middleware errors auto-accumulated on route", async () => {
		const mw = defineMiddleware({ errors: [errors, "email_taken"], fn: async (_ctx, next) => next() })
		const h = honey<{}>()
		h.get("/test")
			.use(mw)
			.handler(() => {
				throw errors.email_taken()
			})
		expect(await fetchJson(h, "/test")).toMatchObject({ body: { error_key: "email_taken" }, status: 409 })
	})
})

describe("global error factory", () => {
	// v0: dbe17bc0c7
	it("global factory preserved through .use() chain", () => {
		const app = honey<{}>()
			.errorFactory(errors)
			.use(withDb)
			.get("/test")
			.errors("email_taken")
			.handler((ctx) => ctx.res.text("ok", ctx.db))
		expect(app).toBeDefined()
	})
})

describe("ctx.errors", () => {
	// v0: e536dc6e3f
	it("handler receives callable errors from global factory", async () => {
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("email_taken", "org_slug_taken")
			.handler((ctx) => {
				throw ctx.errors.email_taken()
			})
		expect(await fetchJson(app, "/test")).toMatchObject({ body: { error_key: "email_taken" }, status: 409 })
	})

	// v0: ce588ead87
	it("ctx.errors is frozen", async () => {
		let captured: unknown
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("email_taken")
			.handler((ctx) => {
				captured = ctx.errors
				return ctx.res.text("ok", "ok")
			})
		await app.fetch(new Request("http://localhost/test"), {})
		expect(Object.isFrozen(captured)).toBe(true)
	})
})

describe("ctx.errors: declared keys", () => {
	// v0: 055a967c28
	it("ctx.errors only contains declared keys (type-level)", () => {
		honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("email_taken")
			.handler((ctx) => {
				expectTypeOf(ctx.errors).toHaveProperty("email_taken")
				expectTypeOf(ctx.errors).not.toHaveProperty("org_slug_taken")
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: e7cd539ce9
	it("defaultErrors available on every route's ctx.errors", async () => {
		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrors("invalid_input")
			.get("/test")
			.errors("email_taken")
			.handler((ctx) => {
				expectTypeOf(ctx.errors).toHaveProperty("invalid_input")
				expectTypeOf(ctx.errors).toHaveProperty("email_taken")
				throw ctx.errors.invalid_input()
			})
		expect(await fetchJson(app, "/test")).toMatchObject({ body: { error_key: "invalid_input" }, status: 400 })
	})

	// v0: d8b2121635
	it("defaultErrors present even without route-level .errors()", async () => {
		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrors("invalid_input")
			.get("/test")
			.handler((ctx) => {
				throw ctx.errors.invalid_input()
			})
		expect((await fetchJson(app, "/test")).status).toBe(400)
	})

	// v0: 7754770a73
	it("route .errors() rejects keys already in defaultErrors (type-level)", () => {
		const route = honey<{}>().errorFactory(errors).defaultErrors("invalid_input").get("/test")
		// @ts-expect-error invalid_input is already a default error
		route.errors("invalid_input")
		route.errors("email_taken").handler((ctx) => {
			expectTypeOf(ctx.errors).toHaveProperty("invalid_input")
			return ctx.res.text("ok", "ok")
		})
	})
})

describe(".boundary() per-route", () => {
	const throwing = (thrown: () => unknown) => {
		const h = honey<{}>().errorFactory(boundaryErrors)
		h.get("/me")
			.errors("not_found")
			.boundary("profile_error")
			.handler(() => {
				throw thrown()
			})
		return h
	}

	// v0: b4486ba413
	it("wraps undeclared HoneyError in boundary key", async () => {
		const h = throwing(() => new HoneyError({ errorKey: "something_unknown", status: "conflict" }))
		expect(await fetchJson(h, "/me")).toMatchObject({ body: { error_key: "profile_error" }, status: 500 })
	})

	// v0: a116eca180
	it("wraps non-HoneyError throw in boundary key", async () => {
		expect(
			(
				await fetchJson(
					throwing(() => new Error("db connection failed")),
					"/me",
				)
			).body.error_key,
		).toBe("profile_error")
	})

	// v0: 1d0d61b024
	it("wraps string throw in boundary key", async () => {
		expect(
			(
				await fetchJson(
					throwing(() => "oops"),
					"/me",
				)
			).body.error_key,
		).toBe("profile_error")
	})

	// v0: 14c568d896
	it("boundary key auto-added to route errorKeys (available on ctx.errors)", async () => {
		const h = honey<{}>().errorFactory(boundaryErrors)
		h.get("/me")
			.boundary("profile_error")
			.handler((ctx) => ctx.res.json("ok", { key: ctx.errors.profile_error().errorKey }))
		expect(await fetchJson(h, "/me")).toEqual({ body: { key: "profile_error" }, status: 200 })
	})
})

describe(".defaultBoundary() app-level", () => {
	// v0: 98bf3d6a4b
	it("applies to all routes when no per-route boundary", async () => {
		const h = honey<{}>().errorFactory(boundaryErrors).defaultBoundary("internal_server_error")
		h.get("/a")
			.errors("not_found")
			.handler(() => {
				throw new Error("boom")
			})
		h.get("/b")
			.errors("not_found")
			.handler(() => {
				throw new HoneyError({ errorKey: "undeclared", status: "conflict" })
			})
		expect((await fetchJson(h, "/a")).body.error_key).toBe("internal_server_error")
		expect(await fetchJson(h, "/b")).toMatchObject({ body: { error_key: "internal_server_error" }, status: 500 })
	})

	// v0: e4980f2aea
	it("per-route .boundary() overrides .defaultBoundary()", async () => {
		const h = honey<{}>().errorFactory(boundaryErrors).defaultBoundary("internal_server_error")
		h.get("/me")
			.errors(boundaryErrors, "not_found")
			.boundary("profile_error")
			.handler(() => {
				throw new Error("boom")
			})
		expect((await fetchJson(h, "/me")).body.error_key).toBe("profile_error")
	})

	// v0: a85cd7425e
	it("routes without .boundary() use defaultBoundary", async () => {
		const h = honey<{}>().errorFactory(boundaryErrors).defaultBoundary("auth_error")
		h.get("/login")
			.errors("not_found")
			.handler(() => {
				throw new Error("something unexpected")
			})
		expect((await fetchJson(h, "/login")).body.error_key).toBe("auth_error")
	})
})

describe("no boundary set", () => {
	// v0: 02a96b4dbf
	it("existing behavior unchanged: undeclared → internal_server_error", async () => {
		const h = honey<{}>().errorFactory(boundaryErrors)
		h.get("/fail")
			.errors("not_found")
			.handler(() => {
				throw new HoneyError({ errorKey: "undeclared", status: "conflict" })
			})
		expect(await fetchJson(h, "/fail")).toMatchObject({ body: { error_key: "internal_server_error" }, status: 500 })
	})

	// v0: 0c6e33b336
	it("existing behavior unchanged: non-HoneyError → internal_server_error", async () => {
		const h = honey<{}>()
		h.get("/fail").handler(() => {
			throw new Error("raw")
		})
		expect((await fetchJson(h, "/fail")).body.error_key).toBe("internal_server_error")
	})
})

describe("RouteBuilder runtime", () => {
	it("a one-shot method disappears once used", () => {
		const route = honey<{}>().errorFactory(errors).get("/x").errors("email_taken").meta({ summary: "s" })
		expectTypeOf(route).not.toHaveProperty("errors")
		expectTypeOf(route).not.toHaveProperty("meta")
		expectTypeOf(route).toHaveProperty("use")
	})

	it("route meta merges over chain meta and dedupes invalidate", async () => {
		const app = honey<{}>()
		app
			.meta({ summary: "chain", tags: "a" })
			.get("/m")
			.meta({ invalidate: ["GET /a", "GET /a", "GET /b"], summary: "route" })
			.handler((ctx) => ctx.res.json("ok", ctx.meta))
		expect((await fetchJson(app, "/m")).body).toEqual({ invalidate: ["GET /a", "GET /b"], summary: "route", tags: "a" })
		app
			.get("/one")
			.meta({ invalidate: ["GET /a"] })
			.handler((ctx) => ctx.res.json("ok", ctx.meta))
		/* the root handle carries no chain meta: meta() returned a derived handle */
		expect((await fetchJson(app, "/one")).body).toEqual({ invalidate: ["GET /a"] })
	})

	it(".on() registers one record per method, sharing the handler", async () => {
		const app = honey<{}>()
		app.on(["GET", "POST"], "/both").handler((ctx) => ctx.res.text("ok", ctx.req.method))
		expect([...finalTable(app[GRAPH]).plans.keys()]).toEqual(["GET /both", "POST /both"])
		const res = await app.fetch(new Request("http://localhost/both", { method: "POST" }), {})
		expect(await res.text()).toBe("POST")
	})
})
