import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { defineErrors, defineMiddleware, honey } from "../../../src/index.ts"
import type { MiddlewareFn } from "../../../src/middleware.ts"

/* ---- shared fixtures ---- */

const errors = defineErrors({
	email_taken: "conflict",
	invalid_input: "bad_request",
	org_limit_reached: "forbidden",
	org_slug_taken: "conflict",
})

type DbCtx = { db: string }
const withDb: MiddlewareFn<{}, DbCtx> = async (_ctx, next) => {
	return next({ db: "test-db" })
}

type AuthCtx = { user: { id: string } }
const withAuth: MiddlewareFn<DbCtx, AuthCtx> = async (_ctx, next) => {
	return next({ user: { id: "u1" } })
}

/* ---- type-level tests ---- */

describe("RouteBuilder type inference", () => {
	describe(".input() types", () => {
		it("handler ctx includes typed input.search", () => {
			const h = honey<{}>()
			h.get("/test")
				.input({ search: z.object({ id: z.string(), page: z.number() }) })
				.handler((ctx) => {
					expectTypeOf(ctx.input.search.id).toEqualTypeOf<string>()
					expectTypeOf(ctx.input.search.page).toEqualTypeOf<number>()
					return ctx.res.text("ok", "ok")
				})
		})

		it("handler ctx includes typed input.json", () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: z.object({ age: z.number(), name: z.string() }) })
				.handler((ctx) => {
					expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
					expectTypeOf(ctx.input.json.age).toEqualTypeOf<number>()
					return ctx.res.text("ok", "ok")
				})
		})

		it("handler ctx has no input property without .input()", () => {
			const h = honey<{}>()
			h.get("/test").handler((ctx) => {
				expectTypeOf(ctx).not.toHaveProperty("input")
				return ctx.res.text("ok", "ok")
			})
		})

		it("multiple input sources combine", () => {
			const h = honey<{}>()
			h.post("/test")
				.input({
					headers: z.object({ authorization: z.string() }),
					json: z.object({ data: z.string() }),
					search: z.object({ page: z.number() }),
				})
				.handler((ctx) => {
					expectTypeOf(ctx.input.search.page).toEqualTypeOf<number>()
					expectTypeOf(ctx.input.json.data).toEqualTypeOf<string>()
					expectTypeOf(ctx.input.headers.authorization).toEqualTypeOf<string>()
					return ctx.res.text("ok", "ok")
				})
		})
	})

	describe(".errors() types", () => {
		it("constrains keys to factory keys", () => {
			const h = honey<{}>()
			/* valid keys — should compile */
			h.get("/test")
				.errors(errors, "email_taken", "org_slug_taken")
				.handler((ctx) => ctx.res.text("ok", "ok"))
		})
	})

	describe(".output() types", () => {
		it("ctx.json constrains status key to output schema keys", () => {
			const h = honey<{}>()
			h.get("/test")
				.output({
					"application/json": {
						created: z.object({ id: z.string() }),
						ok: z.object({ items: z.array(z.string()) }),
					},
				})
				.handler((ctx) => {
					/* output-constrained json() accepts typed data */
					return ctx.res.json("ok", { items: ["a"] })
				})
		})

		it("without .output(), ctx.json accepts any StatusKey", () => {
			const h = honey<{}>()
			h.get("/test").handler((ctx) => {
				/* should accept any StatusKey + unknown data */
				return ctx.res.json("ok", { anything: true })
			})
		})

		it("output + input combined", () => {
			const h = honey<{}>()
			h.post("/test")
				.input({ json: z.object({ name: z.string() }) })
				.output({ "application/json": { created: z.object({ id: z.string() }) } })
				.handler((ctx) => {
					expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
					return ctx.res.json("created", { id: "abc" })
				})
		})

		it("output + middleware + input combined", () => {
			const h = honey<{}>()
			const authed = h.use(withDb).use(withAuth)
			authed
				.get("/test")
				.input({ search: z.object({ q: z.string() }) })
				.output({ "application/json": { ok: z.object({ results: z.array(z.string()) }) } })
				.handler((ctx) => {
					expectTypeOf(ctx.db).toEqualTypeOf<string>()
					expectTypeOf(ctx.user.id).toEqualTypeOf<string>()
					expectTypeOf(ctx.input.search.q).toEqualTypeOf<string>()
					return ctx.res.json("ok", { results: ["found"] })
				})
		})
	})

	describe("path param types", () => {
		it("single param inferred from path", () => {
			const h = honey<{}>()
			h.get("/users/:id").handler((ctx) => {
				expectTypeOf(ctx.params.id).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
		})

		it("multiple params inferred from path", () => {
			const h = honey<{}>()
			h.get("/users/:userId/posts/:postId").handler((ctx) => {
				expectTypeOf(ctx.params.userId).toEqualTypeOf<string>()
				expectTypeOf(ctx.params.postId).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
		})

		it("wildcard param inferred", () => {
			const h = honey<{}>()
			h.get("/files/*path").handler((ctx) => {
				expectTypeOf(ctx.params.path).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
		})

		it("no params → Record<string, string>", () => {
			const h = honey<{}>()
			h.get("/static").handler((ctx) => {
				expectTypeOf(ctx.params).toEqualTypeOf<Record<string, string>>()
				return ctx.res.text("ok", "ok")
			})
		})

		it("params + input + output + middleware combined", () => {
			const h = honey<{}>()
			const authed = h.use(withDb).use(withAuth)
			authed
				.get("/orgs/:orgId/members/:memberId")
				.input({ search: z.object({ q: z.string() }) })
				.output({ "application/json": { ok: z.object({ name: z.string() }) } })
				.handler((ctx) => {
					expectTypeOf(ctx.params.orgId).toEqualTypeOf<string>()
					expectTypeOf(ctx.params.memberId).toEqualTypeOf<string>()
					expectTypeOf(ctx.db).toEqualTypeOf<string>()
					expectTypeOf(ctx.user.id).toEqualTypeOf<string>()
					expectTypeOf(ctx.input.search.q).toEqualTypeOf<string>()
					return ctx.res.json("ok", { name: "Alice" })
				})
		})

		it("handler returns app with accumulated route types", () => {
			const app = honey<{}>()
				.get("/users/:id")
				.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
				.post("/users")
				.input({ json: z.object({ name: z.string() }) })
				.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name }))

			type Routes = typeof app.$routes
			expectTypeOf<Routes>().toHaveProperty("/users/:id")
			expectTypeOf<Routes>().toHaveProperty("/users")
		})
	})

	describe("per-route .use() type accumulation", () => {
		it("per-route .use() adds typed context to handler", () => {
			const h = honey<{}>()
			h.get("/test")
				.use(withDb)
				.handler((ctx) => {
					expectTypeOf(ctx.db).toEqualTypeOf<string>()
					return ctx.res.text("ok", "ok")
				})
		})

		it("chained per-route .use() accumulates context", () => {
			const h = honey<{}>()
			h.get("/test")
				.use(withDb)
				.use(withAuth)
				.handler((ctx) => {
					expectTypeOf(ctx.db).toEqualTypeOf<string>()
					expectTypeOf(ctx.user.id).toEqualTypeOf<string>()
					return ctx.res.text("ok", "ok")
				})
		})

		it("per-route .use() ctx available at runtime", async () => {
			const h = honey<{}>()
			h.get("/test")
				.use(withDb)
				.handler((ctx) => ctx.res.json("ok", { db: ctx.db }))

			const res = await h.fetch(new Request("http://localhost/test"), {})
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.db).toBe("test-db")
		})

		it("per-route + global middleware combine", async () => {
			const h = honey<{}>()
			const chain = h.use(withDb)
			chain
				.get("/test")
				.use(withAuth)
				.handler((ctx) => {
					expectTypeOf(ctx.db).toEqualTypeOf<string>()
					expectTypeOf(ctx.user.id).toEqualTypeOf<string>()
					return ctx.res.json("ok", { db: ctx.db, userId: ctx.user.id })
				})

			const res = await chain.fetch(new Request("http://localhost/test"), {})
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.db).toBe("test-db")
			expect(body.userId).toBe("u1")
		})
	})

	describe("middleware requirement enforcement", () => {
		it("handler ctx has middleware additions + typed input", () => {
			const h = honey<{}>()
			const authed = h.use(withDb).use(withAuth)
			authed
				.get("/test")
				.input({ search: z.object({ q: z.string() }) })
				.handler((ctx) => {
					expectTypeOf(ctx.db).toEqualTypeOf<string>()
					expectTypeOf(ctx.user.id).toEqualTypeOf<string>()
					expectTypeOf(ctx.input.search.q).toEqualTypeOf<string>()
					return ctx.res.text("ok", "ok")
				})
		})

		it("chained middleware requirements enforced", () => {
			const h = honey<{}>()
			/* withDb requires {}, so OK on fresh app */
			const withDbChain = h.use(withDb)
			/* withAuth requires { db: string }, which withDb provides — OK */
			const authed = withDbChain.use(withAuth)
			expectTypeOf(authed).toHaveProperty("get")
		})
	})

	describe("middleware errors tied to factory", () => {
		it("defineMiddleware constrains error keys to factory", () => {
			const mw = defineMiddleware({
				errors: [errors, "email_taken", "org_slug_taken"],
				fn: async (_ctx, next) => next(),
			})

			expect(mw.errors).toEqual(["email_taken", "org_slug_taken"])
		})

		it("middleware errors auto-accumulated on route", async () => {
			const mw = defineMiddleware({
				errors: [errors, "email_taken"],
				fn: async (_ctx, next) => next(),
			})

			const h = honey<{}>()
			h.get("/test")
				.use(mw)
				.handler(() => {
					throw errors.email_taken()
				})

			const res = await h.fetch(new Request("http://localhost/test"), {})
			expect(res.status).toBe(409)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.error_key).toBe("email_taken")
		})
	})
})

/* ---- global error factory ---- */

describe("global error factory", () => {
	it("enables keys-only .errors() on routes", () => {
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("email_taken", "org_slug_taken")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		expect(app).toBeDefined()
	})

	it("factory+keys form still works alongside global factory", () => {
		const otherErrors = defineErrors({
			special_error: "bad_request",
		})

		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors(otherErrors, "special_error")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		expect(app).toBeDefined()
	})

	it("runtime: global factory errors register keys", async () => {
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("email_taken")
			.handler(() => {
				throw errors.email_taken()
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(409)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("email_taken")
	})

	it("runtime: undeclared error key from global factory → 500", async () => {
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("email_taken")
			.handler(() => {
				throw errors.org_slug_taken()
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})

	it("global factory preserved through .use() chain", () => {
		const app = honey<{}>()
			.errorFactory(errors)
			.use(withDb)
			.get("/test")
			.errors("email_taken")
			.handler((ctx) => ctx.res.text("ok", ctx.db))

		expect(app).toBeDefined()
	})

	it("global factory preserved through .meta() chain", () => {
		type AppMeta = { auth?: "public" | "required" }

		const app = honey<{}>()
			.errorFactory(errors)
			.meta<AppMeta>()
			.get("/test")
			.meta({ auth: "required" })
			.errors("email_taken")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		expect(app).toBeDefined()
	})
})

/* ---- ctx.errors ---- */

describe("ctx.errors", () => {
	it("handler receives callable errors from global factory", async () => {
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("email_taken", "org_slug_taken")
			.handler((ctx) => {
				throw ctx.errors.email_taken()
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(409)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("email_taken")
	})

	it("ctx.errors is frozen", async () => {
		let capturedErrors: Record<string, unknown> | undefined
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("email_taken")
			.handler((ctx) => {
				capturedErrors = ctx.errors as unknown as Record<string, unknown>
				return ctx.res.text("ok", "ok")
			})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(Object.isFrozen(capturedErrors)).toBe(true)
	})

	it("ctx.errors only contains declared keys (type-level)", () => {
		honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("email_taken")
			.handler((ctx) => {
				expectTypeOf(ctx.errors).toHaveProperty("email_taken")
				return ctx.res.text("ok", "ok")
			})
	})

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

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(400)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("invalid_input")
	})

	it("defaultErrors present even without route-level .errors()", async () => {
		const app = honey<{}>()
			.errorFactory(errors)
			.defaultErrors("invalid_input")
			.get("/test")
			.handler((ctx) => {
				throw ctx.errors.invalid_input()
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(400)
	})

	it("route .errors() rejects keys already in defaultErrors (type-level)", () => {
		honey<{}>()
			.errorFactory(errors)
			.defaultErrors("invalid_input")
			.get("/test")
			.errors("email_taken")
			.handler((ctx) => {
				expectTypeOf(ctx.errors).toHaveProperty("email_taken")
				expectTypeOf(ctx.errors).toHaveProperty("invalid_input")
				return ctx.res.text("ok", "ok")
			})
	})
})

/* ---- runtime tests ---- */

describe("RouteBuilder runtime validation", () => {
	it("valid search params → handler receives validated input", async () => {
		const h = honey<{}>()
		h.get("/test")
			.input({ search: z.object({ id: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.input.search.id }))

		const res = await h.fetch(new Request("http://localhost/test?id=abc"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBe("abc")
	})

	it("missing required search param → 400 validation error", async () => {
		const h = honey<{}>()
		h.get("/test")
			.input({ search: z.object({ id: z.string() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(400)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("validation_failed")
	})

	it("valid JSON body → handler receives validated input", async () => {
		const h = honey<{}>()
		h.post("/test")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name }))

		const res = await h.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ name: "Alice" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.name).toBe("Alice")
	})

	it("invalid JSON body → 400", async () => {
		const h = honey<{}>()
		h.post("/test")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ name: 123 }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
	})

	it("no .input() → handler runs without input validation", async () => {
		const h = honey<{}>()
		h.get("/test").handler((ctx) => ctx.res.text("ok", "no-validation"))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("no-validation")
	})

	it("middleware ctx + validated input both available in handler", async () => {
		const h = honey<{}>()
		const chain = h.use(withDb)
		chain
			.get("/test")
			.input({ search: z.object({ q: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { db: ctx.db, q: ctx.input.search.q }))

		const res = await chain.fetch(new Request("http://localhost/test?q=hello"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.db).toBe("test-db")
		expect(body.q).toBe("hello")
	})

	it("params validation works", async () => {
		const h = honey<{}>()
		h.get("/users/:userId")
			.input({ params: z.object({ userId: z.string().min(3) }) })
			.handler((ctx) => ctx.res.json("ok", { userId: ctx.input.params.userId }))

		const res = await h.fetch(new Request("http://localhost/users/abc"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.userId).toBe("abc")
	})

	it("params validation failure → 400", async () => {
		const h = honey<{}>()
		h.get("/users/:userId")
			.input({ params: z.object({ userId: z.string().min(3) }) })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/users/ab"), {})
		expect(res.status).toBe(400)
	})

	it(".errors() constrains runtime error keys", async () => {
		const h = honey<{}>()
		h.get("/test")
			.errors(errors, "email_taken")
			.handler(() => {
				throw errors.email_taken()
			})

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(409)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("email_taken")
	})
})
