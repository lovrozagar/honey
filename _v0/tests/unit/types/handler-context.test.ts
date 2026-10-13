import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"
import type { TypedResponse } from "../../../src/response.ts"

describe("handler ctx.params", () => {
	it("parameterized route has typed params", () => {
		honey<{}>()
			.get("/users/:userId")
			.handler((ctx) => {
				expectTypeOf(ctx.params.userId).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("static route has generic params", () => {
		honey<{}>()
			.get("/health")
			.handler((ctx) => {
				expectTypeOf(ctx.params).toEqualTypeOf<Record<string, string>>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("handler ctx.input narrowing", () => {
	it("json input typed from schema", () => {
		honey<{}>()
			.post("/users")
			.input({ json: z.object({ email: z.string(), name: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.json.email).toEqualTypeOf<string>()
				return ctx.res.json("created", { id: "1" })
			})
	})

	it("search input typed from schema", () => {
		honey<{}>()
			.get("/search")
			.input({ search: z.object({ limit: z.string(), q: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.input.search.q).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.search.limit).toEqualTypeOf<string>()
				return ctx.res.json("ok", {})
			})
	})
})

describe("output constrains ctx.res", () => {
	it("declared json output — ctx.res.json available with constrained status keys", () => {
		honey<{}>()
			.get("/users")
			.output({
				"application/json": {
					ok: z.object({ id: z.string(), name: z.string() }),
				},
			})
			.handler((ctx) => {
				const r = ctx.res.json("ok", { id: "1", name: "test" })
				expectTypeOf(r).toEqualTypeOf<TypedResponse<"application/json", "ok">>()
				return r
			})
	})

	it("declared json removes text/html/csv/binary/xml methods", () => {
		honey<{}>()
			.get("/users")
			.output({
				"application/json": { ok: z.object({ id: z.string() }) },
			})
			.handler((ctx) => {
				expectTypeOf(ctx.res).not.toHaveProperty("text")
				expectTypeOf(ctx.res).not.toHaveProperty("html")
				expectTypeOf(ctx.res).not.toHaveProperty("csv")
				expectTypeOf(ctx.res).not.toHaveProperty("binary")
				expectTypeOf(ctx.res).not.toHaveProperty("xml")
				return ctx.res.json("ok", { id: "1" })
			})
	})

	it("universal methods always available regardless of output", () => {
		honey<{}>()
			.get("/users")
			.output({
				"application/json": { ok: z.object({ id: z.string() }) },
			})
			.handler((ctx) => {
				expectTypeOf(ctx.res.noContent).toBeFunction()
				expectTypeOf(ctx.res.redirect).toBeFunction()
				expectTypeOf(ctx.res.raw).toBeFunction()
				expectTypeOf(ctx.res.stream).toBeFunction()
				return ctx.res.json("ok", { id: "1" })
			})
	})

	it("SSE output makes ctx.res.sse available", () => {
		honey<{}>()
			.get("/events")
			.output({
				"text/event-stream": { ok: z.object({ data: z.string() }) },
			})
			.handler((ctx) => {
				expectTypeOf(ctx.res.sse).toBeFunction()
				return ctx.res.sse(async () => {})
			})
	})

	it("multiple content types — both methods available", () => {
		honey<{}>()
			.get("/data")
			.output({
				"application/json": { ok: z.object({ id: z.string() }) },
				"text/plain": { ok: z.string() },
			})
			.handler((ctx) => {
				expectTypeOf(ctx.res.json).toBeFunction()
				expectTypeOf(ctx.res.text).toBeFunction()
				return ctx.res.json("ok", { id: "1" })
			})
	})

	it("no output — ctx.res has all methods", () => {
		honey<{}>()
			.get("/anything")
			.handler((ctx) => {
				expectTypeOf(ctx.res.json).toBeFunction()
				expectTypeOf(ctx.res.text).toBeFunction()
				expectTypeOf(ctx.res.html).toBeFunction()
				expectTypeOf(ctx.res.csv).toBeFunction()
				expectTypeOf(ctx.res.binary).toBeFunction()
				expectTypeOf(ctx.res.xml).toBeFunction()
				expectTypeOf(ctx.res.sse).toBeFunction()
				expectTypeOf(ctx.res.stream).toBeFunction()
				expectTypeOf(ctx.res.noContent).toBeFunction()
				expectTypeOf(ctx.res.redirect).toBeFunction()
				expectTypeOf(ctx.res.raw).toBeFunction()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("handler ctx.meta", () => {
	it("meta typed from .meta() call", () => {
		honey<{}>()
			.get("/docs")
			.meta({ summary: "Get docs", tags: ["docs"] })
			.handler((ctx) => {
				expectTypeOf(ctx.meta).toMatchTypeOf<Readonly<{}>>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("handler ctx.errors", () => {
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
	it("literal route pattern type", () => {
		honey<{}>()
			.get("/users/:id")
			.handler((ctx) => {
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/users/:id">()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("combined: middleware + input + output + params", () => {
	it("full handler context composition", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ requestId: "r-1" }))

		honey<{}>()
			.use(mw)
			.post("/users/:orgId")
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { created: z.object({ id: z.string() }) } })
			.handler((ctx) => {
				expectTypeOf(ctx.requestId).toEqualTypeOf<string>()
				expectTypeOf(ctx.params.orgId).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/users/:orgId">()
				expectTypeOf(ctx.res.noContent).toBeFunction()
				expectTypeOf(ctx.res).not.toHaveProperty("text")
				return ctx.res.json("created", { id: "1" })
			})
	})
})

describe("handler ctx edge cases", () => {
	it("form input typed from schema", () => {
		honey<{}>()
			.post("/upload")
			.input({ form: z.object({ file: z.string(), name: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.input.form.file).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.form.name).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("headers input typed from schema", () => {
		honey<{}>()
			.get("/protected")
			.input({ headers: z.object({ authorization: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.input.headers.authorization).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("cookies input typed from schema", () => {
		honey<{}>()
			.get("/session")
			.input({ cookies: z.object({ session_id: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.input.cookies.session_id).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("combined json + search input", () => {
		honey<{}>()
			.post("/search")
			.input({
				json: z.object({ filters: z.string().array() }),
				search: z.object({ page: z.string() }),
			})
			.handler((ctx) => {
				expectTypeOf(ctx.input.json.filters).toEqualTypeOf<string[]>()
				expectTypeOf(ctx.input.search.page).toEqualTypeOf<string>()
				return ctx.res.json("ok", {})
			})
	})

	it("ctx.req is Request", () => {
		honey<{}>()
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.req).toEqualTypeOf<Request>()
				return ctx.res.text("ok", "ok")
			})
	})

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

	it("wildcard param typed in handler", () => {
		honey<{}>()
			.get("/files/*path")
			.handler((ctx) => {
				expectTypeOf(ctx.params.path).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

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

	it("basePath + params + middleware + output combined", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ tenant: "t-1" }))
		const errs = defineErrors({ not_found: "not_found" })

		honey<{ SECRET: string }>()
			.basePath("/api/v1")
			.use(mw)
			.get("/users/:id")
			.input({ search: z.object({ fields: z.string().optional() }) })
			.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }) } })
			.errors(errs, "not_found")
			.handler((ctx) => {
				expectTypeOf(ctx.env.SECRET).toEqualTypeOf<string>()
				expectTypeOf(ctx.tenant).toEqualTypeOf<string>()
				expectTypeOf(ctx.params.id).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.search.fields).toEqualTypeOf<string | undefined>()
				expectTypeOf(ctx.routePattern).toEqualTypeOf<"/api/v1/users/:id">()
				expectTypeOf(ctx.errors.not_found).toBeFunction()
				expectTypeOf(ctx.res.json).toBeFunction()
				expectTypeOf(ctx.res).not.toHaveProperty("text")
				return ctx.res.json("ok", { id: "1", name: "test" })
			})
	})
})
