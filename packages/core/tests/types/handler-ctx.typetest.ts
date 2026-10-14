import { describe, expectTypeOf, it } from "vitest"
import { defineErrors } from "../../src/errors/errors.ts"
import { honey } from "../../src/routing/app.ts"

describe("handler ctx.params", () => {
	// v0: 8d3b08b315
	it("parameterized route has typed params", () => {
		honey<{}>()
			.get("/users/:userId")
			.handler((ctx) => {
				expectTypeOf(ctx.params.userId).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("handler ctx.errors", () => {
	// v0: 04f36d619c
	it("errors from .errors(factory, keys) are Pick<Factory, keys>", () => {
		const errs = defineErrors({
			email_taken: "conflict",
			not_allowed: "forbidden",
			org_limit: "forbidden",
		})

		honey<{}>()
			.get("/test")
			.errors(errs, "email_taken", "org_limit")
			.handler((ctx) => {
				expectTypeOf(ctx.errors.email_taken).toBeFunction()
				expectTypeOf(ctx.errors.org_limit).toBeFunction()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: a53900b1cd
	it("errorFactory + .errors(keys) — ctx.errors has only selected keys", () => {
		const errs = defineErrors({
			a: "bad_request",
			b: "forbidden",
			c: "not_found",
		})

		honey<{}>()
			.errorFactory(errs)
			.get("/test")
			.errors("a", "b")
			.handler((ctx) => {
				expectTypeOf(ctx.errors.a).toBeFunction()
				expectTypeOf(ctx.errors.b).toBeFunction()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("handler ctx.routePattern", () => {
	// v0: 45a652f26b
	it("literal route pattern type", () => {
		honey<{}>()
			.get("/users/:id")
			.handler((ctx) => {
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/users/:id">()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("handler ctx edge cases", () => {
	// v0: 3296607f56
	it("ctx.req is Request", () => {
		honey<{}>()
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.req).toEqualTypeOf<Request>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: b5ebb2d677
	it("ctx.env typed from Honey generic", () => {
		type Env = { API_KEY: string; DB_URL: string }
		honey<Env>()
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.env.API_KEY).toEqualTypeOf<string>()
				expectTypeOf(ctx.env.DB_URL).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 6b6144b460
	it("wildcard param typed in handler", () => {
		honey<{}>()
			.get("/files/*path")
			.handler((ctx) => {
				expectTypeOf(ctx.params.path).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	// v0: 7736027c21
	it("multi-param deep nesting", () => {
		honey<{}>()
			.get("/orgs/:orgId/teams/:teamId/members/:memberId")
			.handler((ctx) => {
				expectTypeOf(ctx.params.orgId).toEqualTypeOf<string>()
				expectTypeOf(ctx.params.teamId).toEqualTypeOf<string>()
				expectTypeOf(ctx.params.memberId).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})
})
