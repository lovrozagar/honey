import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type {
	InferCtx,
	InferRouteCtx,
	InferRouteErrors,
	InferRouteInput,
	InferRouteMethods,
	InferRoutePaths,
} from "../../../src/index.ts"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"

describe("type inference — full chain", () => {
	const errors = defineErrors({
		forbidden: "forbidden",
		not_found: "not_found",
	})

	const withDb = createMiddleware(async (_ctx, next) =>
		next({
			db: {
				query: (sql: string) => {
					void sql
					return [] as string[]
				},
			},
		}),
	)

	const withAuth = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))

	const app = honey<{ SECRET: string }>()
		.errorFactory(errors)
		.defaultErrors("forbidden")
		.meta<{ auth?: "public" | "required" }>()
		.use(withDb)
		.use(withAuth)
		.get("/orgs")
		.meta({ auth: "required" })
		.input({ search: z.object({ limit: z.number() }) })
		.output({
			"application/json": { ok: z.object({ items: z.string().array() }) },
		})
		.errors("not_found")
		.handler((ctx) => {
			/* verify all types resolve correctly */
			expectTypeOf(ctx.env).toEqualTypeOf<{ SECRET: string }>()
			expectTypeOf(ctx.db.query).toBeFunction()
			expectTypeOf(ctx.userId).toEqualTypeOf<string>()
			expectTypeOf(ctx.input.search.limit).toEqualTypeOf<number>()
			expectTypeOf(ctx.params).toEqualTypeOf<Record<string, string>>()
			expectTypeOf(ctx.meta).toMatchTypeOf<{ auth?: "public" | "required" }>()
			expectTypeOf(ctx.req).toEqualTypeOf<Request>()

			/* errors — should include route-specific + defaults */
			expectTypeOf(ctx.errors).toHaveProperty("not_found")
			expectTypeOf(ctx.errors).toHaveProperty("forbidden")

			return ctx.res.json("ok", { items: [] })
		})
		.get("/orgs/:orgId")
		.handler((ctx) => {
			/* params should be typed for this route */
			expectTypeOf(ctx.params.orgId).toEqualTypeOf<string>()
			return ctx.res.json("ok", { id: ctx.params.orgId })
		})
		.post("/orgs")
		.input({ json: z.object({ name: z.string(), slug: z.string() }) })
		.handler((ctx) => {
			expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
			expectTypeOf(ctx.input.json.slug).toEqualTypeOf<string>()
			return ctx.res.json("created", { name: ctx.input.json.name })
		})

	it("InferRoutePaths extracts all registered paths", () => {
		type Paths = InferRoutePaths<typeof app>
		expectTypeOf<Paths>().toEqualTypeOf<"/orgs" | "/orgs/:orgId">()
	})

	it("InferRouteMethods extracts methods for a path", () => {
		type Methods = InferRouteMethods<typeof app, "/orgs">
		expectTypeOf<Methods>().toEqualTypeOf<"get" | "post">()
	})

	it("InferRouteInput extracts validated input types", () => {
		type Input = InferRouteInput<typeof app, "/orgs", "get">
		expectTypeOf<Input>().toMatchTypeOf<{ search: { limit: number } }>()
	})

	it("InferRouteErrors extracts error keys", () => {
		type Errors = InferRouteErrors<typeof app, "/orgs", "get">
		expectTypeOf<Errors>().toEqualTypeOf<"forbidden" | "not_found">()
	})

	it("InferCtx extracts accumulated middleware context", () => {
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{
			db: { query: (sql: string) => string[] }
			userId: string
		}>()
	})

	it("InferRouteCtx includes route-specific additions", () => {
		type Ctx = InferRouteCtx<typeof app, "/orgs", "get">
		expectTypeOf<Ctx>().toMatchTypeOf<{
			db: { query: (sql: string) => string[] }
			input: { search: { limit: number } }
			userId: string
		}>()
	})
})

describe("type safety — output constraints", () => {
	it("json constrained to declared status keys and data", () => {
		honey<{}>()
			.get("/test")
			.output({
				"application/json": {
					created: z.object({ id: z.string() }),
					ok: z.object({ items: z.string().array() }),
				},
			})
			.handler((ctx) => {
				/* valid calls */
				ctx.res.json("ok", { items: ["a"] })
				ctx.res.json("created", { id: "1" })

				/* @ts-expect-error — wrong status key */
				ctx.res.json("not_found", {})

				/* @ts-expect-error — wrong data shape for "ok" */
				ctx.res.json("ok", { id: "wrong" })

				return ctx.res.json("ok", { items: [] })
			})
	})

	it("text constrained when text/plain output declared", () => {
		honey<{}>()
			.get("/test")
			.output({ "text/plain": { ok: z.string() } })
			.handler((ctx) => {
				ctx.res.text("ok", "valid")

				/* @ts-expect-error — wrong status key */
				ctx.res.text("created", "invalid")

				return ctx.res.text("ok", "done")
			})
	})

	it("undeclared methods removed when output declared", () => {
		honey<{}>()
			.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => {
				/* @ts-expect-error — text not declared */
				ctx.res.text("ok", "should fail")

				/* universal methods always available */
				ctx.res.noContent()
				ctx.res.redirect("/foo")

				return ctx.res.json("ok", { id: "1" })
			})
	})

	it("no output → all methods available", () => {
		honey<{}>()
			.get("/test")
			.handler((ctx) => {
				ctx.res.json("ok", {})
				ctx.res.text("ok", "")
				ctx.res.html("ok", "")
				ctx.res.xml("ok", "")
				ctx.res.csv("ok", "")
				ctx.res.redirect("/")
				ctx.res.noContent()
				return ctx.res.json("ok", {})
			})
	})
})

describe("type safety — middleware deps", () => {
	it("createMiddleware with TReqs enforces ordering", () => {
		type DbCtx = { db: { query: (sql: string) => unknown[] } }

		const withDb = createMiddleware(async (_ctx, next) =>
			next({
				db: {
					query: (sql: string) => {
						void sql
						return [] as unknown[]
					},
				},
			}),
		)

		const withAuth = createMiddleware<DbCtx, { userId: string }>(async (ctx, next) => {
			ctx.db.query("SELECT 1")
			return next({ userId: "u-1" })
		})

		/* correct order compiles */
		const app = honey().use(withDb).use(withAuth)
		app.get("/test").handler((ctx) => {
			expectTypeOf(ctx.userId).toEqualTypeOf<string>()
			return ctx.res.text("ok", "ok")
		})
	})
})

describe("type safety — .route() preserves types", () => {
	it("sub-router routes appear in parent's type", () => {
		const sub = honey<{}>()
			.get("/sub")
			.handler((ctx) => ctx.res.text("ok", "sub"))

		const app = honey<{}>()
			.get("/main")
			.handler((ctx) => ctx.res.text("ok", "main"))
			.route(sub)

		type Paths = InferRoutePaths<typeof app>
		expectTypeOf<Paths>().toEqualTypeOf<"/main" | "/sub">()
	})
})

describe("type safety — handler return type", () => {
	it("handler must return TypedResponse, not plain Response", () => {
		honey<{}>()
			.get("/test")
			/* @ts-expect-error — handler returning plain Response not assignable to TypedResponse */
			.handler(() => new Response("raw"))
	})

	it("ctx.res.raw() wraps plain Response for escape hatch", () => {
		honey<{}>()
			.get("/test")
			.handler((ctx) => {
				return ctx.res.raw(new Response("proxied"))
			})
	})
})

describe("type safety — error factory", () => {
	it("only declared error keys accessible on ctx.errors", () => {
		const errors = defineErrors({
			forbidden: "forbidden",
			not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("not_found")
			.handler((ctx) => {
				/* declared on this route → available */
				expectTypeOf(ctx.errors).toHaveProperty("not_found")

				/* not declared on this route → should not be available
				 * (only default errors + route errors) */
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("type safety — meta", () => {
	it("meta constrained to declared shape — narrows to exact value passed", () => {
		honey<{}>()
			.meta<{ auth?: "public" | "required" }>()
			.get("/test")
			.meta({ auth: "required" })
			.handler((ctx) => {
				/* .meta({ auth: "required" }) narrows to exact literal */
				expectTypeOf(ctx.meta.auth).toEqualTypeOf<"required">()
				return ctx.res.text("ok", "ok")
			})
	})
})
