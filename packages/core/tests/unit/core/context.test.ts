import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { generateTypes } from "../../../src/codegen.ts"
import { createMiddleware, honey } from "../../../src/index.ts"
import type { InferBasePath, InferCtx, InferEnv, InferMeta } from "../../../src/types.ts"

describe("app.context() — static type-safe context", () => {
	it("values accessible in handler", async () => {
		const app = honey<{}>().context({ greeting: "hello" })

		app.get("/test").handler((ctx) => ctx.res.json("ok", { msg: ctx.greeting }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.msg).toBe("hello")
	})

	it("values accessible in middleware", async () => {
		let captured: unknown
		const mw = createMiddleware<{ greeting: string }>(async (ctx, next) => {
			captured = ctx.greeting
			return next()
		})

		const app = honey<{}>().context({ greeting: "hello" }).use(mw)

		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(captured).toBe("hello")
	})

	it("multiple .context() calls accumulate", async () => {
		const app = honey<{}>().context({ a: 1 }).context({ b: 2 })

		app.get("/test").handler((ctx) => ctx.res.json("ok", { a: ctx.a, b: ctx.b }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.a).toBe(1)
		expect(body.b).toBe(2)
	})

	it("rejects reserved context keys", () => {
		const reserved = ["background", "cookies", "env", "headers", "params", "req", "res", "search"]
		for (const key of reserved) {
			expect(() => honey<{}>().context({ [key]: "nope" }), `expected .context({ ${key} }) to throw`).toThrow()
		}
	})

	it("composes with .use() — middleware additions merge with context", async () => {
		const mw = createMiddleware(async (_ctx, next) => next({ added: "fromMw" }))

		const app = honey<{}>().context({ static: "fromCtx" }).use(mw)

		app.get("/test").handler((ctx) => ctx.res.json("ok", { added: ctx.added, static: ctx.static }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.static).toBe("fromCtx")
		expect(body.added).toBe("fromMw")
	})

	it("values shared across requests (static references, not cloned)", async () => {
		const shared = { count: 0 }
		const app = honey<{}>().context({ shared })

		app.get("/inc").handler((ctx) => {
			ctx.shared.count++
			return ctx.res.json("ok", { count: ctx.shared.count })
		})

		await app.fetch(new Request("http://localhost/inc"), {})
		const res = await app.fetch(new Request("http://localhost/inc"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.count).toBe(2)
	})

	it("propagates through .basePath()", async () => {
		const sub = honey<{}>().context({ version: "v1" }).basePath("/api")

		sub.get("/test").handler((ctx) => ctx.res.json("ok", { v: ctx.version }))

		const res = await sub.fetch(new Request("http://localhost/api/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.v).toBe("v1")
	})

	it("codegen includes context-added types via inlineMiddlewareType", () => {
		const app = honey<{}>().context({ db: "placeholder" })

		app.get("/test").handler((ctx) => ctx.res.json("ok", { db: ctx.db }))

		const code = generateTypes(app, {
			inlineEnvType: "{ SECRET: string }",
			inlineMiddlewareType: "Readonly<{ db: string }>",
		})

		expect(code).toContain("export type BaseCtx")
		expect(code).toContain("Readonly<{ db: string }>")
		expect(code).toContain('"/test"')
	})

	it("later .context() overwrites earlier values for same key", async () => {
		const app = honey<{}>().context({ x: "first" }).context({ x: "second" })

		app.get("/test").handler((ctx) => ctx.res.json("ok", { x: ctx.x }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.x).toBe("second")
	})

	it("context accessible in route-level middleware via .use()", async () => {
		let captured: unknown
		const routeMw = createMiddleware<{ db: string }>(async (ctx, next) => {
			captured = ctx.db
			return next({ checked: true })
		})

		const app = honey<{}>().context({ db: "sqlite" })

		app
			.get("/test")
			.use(routeMw)
			.handler((ctx) => ctx.res.json("ok", { checked: ctx.checked, db: ctx.db }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(captured).toBe("sqlite")
		expect(body.db).toBe("sqlite")
		expect(body.checked).toBe(true)
	})

	it("context + input + middleware all compose in handler", async () => {
		const mw = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))

		const app = honey<{}>().context({ region: "eu" }).use(mw)

		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) =>
				ctx.res.json("ok", {
					name: ctx.input.json.name,
					region: ctx.region,
					user: ctx.userId,
				}),
			)

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ name: "item1" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.region).toBe("eu")
		expect(body.user).toBe("u-1")
		expect(body.name).toBe("item1")
	})

	it("context with path params both accessible", async () => {
		const app = honey<{}>().context({ prefix: "org" })

		app.get("/items/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, prefix: ctx.prefix }))

		const res = await app.fetch(new Request("http://localhost/items/42"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.prefix).toBe("org")
		expect(body.id).toBe("42")
	})

	it(".route() merged routes use parent context, not sub context", async () => {
		/* context is on the app instance, merged at request time —
		   when parent.fetch() handles a merged sub-app route,
		   the parent's context applies, not the sub-app's.
		   Use middleware for per-sub-app values that need to survive .route(). */
		const sub = honey<{}>().context({ subVal: "from-sub" }).basePath("/sub")
		sub.get("/test").handler((ctx) => ctx.res.json("ok", { v: ctx.parentVal }))

		const parent = honey<{}>().context({ parentVal: "from-parent" })
		parent.get("/test").handler((ctx) => ctx.res.json("ok", { v: ctx.parentVal }))
		parent.route(sub)

		const r1 = await parent.fetch(new Request("http://localhost/test"), {})
		const b1 = (await r1.json()) as Record<string, unknown>
		expect(b1.v).toBe("from-parent")

		/* sub route also gets parent's context since parent.fetch() handles it */
		const r2 = await parent.fetch(new Request("http://localhost/sub/test"), {})
		const b2 = (await r2.json()) as Record<string, unknown>
		expect(b2.v).toBe("from-parent")
	})

	it("context with env — both accessible without interference", async () => {
		type TestEnv = { SECRET: string }
		const app = honey<TestEnv>().context({ appName: "test" })

		app.get("/test").handler((ctx) => ctx.res.json("ok", { app: ctx.appName, secret: ctx.env.SECRET }))

		const res = await app.fetch(new Request("http://localhost/test"), {
			SECRET: "s3cr3t",
		})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.app).toBe("test")
		expect(body.secret).toBe("s3cr3t")
	})
})

describe("app.context() — compile-time type safety", () => {
	it("single .context() adds fields to InferCtx", () => {
		const app = honey<{}>().context({ db: "sqlite", version: 3 })
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{ readonly db: string; readonly version: number }>()
	})

	it("multiple .context() calls accumulate types", () => {
		const app = honey<{}>().context({ a: 1 }).context({ b: "two" }).context({ c: true })
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{
			readonly a: number
			readonly b: string
			readonly c: boolean
		}>()
	})

	it("context values are Readonly in the type", () => {
		const app = honey<{}>().context({ config: { debug: true } })
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{
			readonly config: { debug: boolean }
		}>()
	})

	it("env type preserved through .context()", () => {
		type TestEnv = { SECRET: string; DB_URL: string }
		const app = honey<TestEnv>().context({ ready: true })
		expectTypeOf<InferEnv<typeof app>>().toEqualTypeOf<TestEnv>()
	})

	it("basePath type preserved through .context()", () => {
		const app = honey<{}>().basePath("/api").context({ v: 1 })
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/api">()
	})

	it(".context() + .use() types accumulate together", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))
		const app = honey<{}>().context({ region: "eu" }).use(mw)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{
			readonly region: string
			userId: string
		}>()
	})

	it("context types flow into handler ctx", () => {
		honey<{}>()
			.context({ appName: "test", maxRetries: 3 })
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.appName).toEqualTypeOf<string>()
				expectTypeOf(ctx.maxRetries).toEqualTypeOf<number>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("context + middleware types both visible in handler", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ traceId: "t-1" }))

		honey<{}>()
			.context({ config: { timeout: 5000 } })
			.use(mw)
			.get("/test")
			.handler((ctx) => {
				expectTypeOf(ctx.config).toEqualTypeOf<{ timeout: number }>()
				expectTypeOf(ctx.traceId).toEqualTypeOf<string>()
				expectTypeOf(ctx.env).toEqualTypeOf<{}>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("complex context types preserved", () => {
		type Cache = { get: (k: string) => string | null; set: (k: string, v: string) => void }
		const cache: Cache = {
			get: () => null,
			set: () => {},
		}

		const app = honey<{}>().context({ cache })
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{ readonly cache: Cache }>()
	})

	it("middleware with TReqs depending on context — types compose", () => {
		const mw = createMiddleware<{ db: string }, { queried: boolean }>(async (ctx, next) => {
			expectTypeOf(ctx.db).toEqualTypeOf<string>()
			return next({ queried: true })
		})

		const app = honey<{}>().context({ db: "sqlite" }).use(mw)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{
			readonly db: string
			queried: boolean
		}>()
	})

	it("context + input + middleware + params all typed in handler", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))

		honey<{ SECRET: string }>()
			.context({ region: "eu" })
			.use(mw)
			.post("/orgs/:orgId/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.region).toEqualTypeOf<string>()
				expectTypeOf(ctx.userId).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
				expectTypeOf(ctx.params.orgId).toEqualTypeOf<string>()
				expectTypeOf(ctx.env.SECRET).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("later .context() overwrite narrows type for same key", () => {
		const app = honey<{}>()
			.context({ x: "first" as string })
			.context({ x: "second" as const })
		type Ctx = InferCtx<typeof app>
		/* last .context() type wins via intersection — "second" is narrower */
		expectTypeOf<Ctx>().toMatchTypeOf<{ readonly x: "second" }>()
	})

	it("context does not affect InferMeta", () => {
		type AppMeta = { tags?: string }
		const app = honey<{}>().meta<AppMeta>().context({ db: "sqlite" })
		type M = InferMeta<typeof app>
		expectTypeOf<M>().toEqualTypeOf<AppMeta>()
	})

	it("route-level .use() sees context types in TReqs", () => {
		const routeMw = createMiddleware<{ config: { timeout: number } }, { validated: true }>(async (ctx, next) => {
			expectTypeOf(ctx.config.timeout).toEqualTypeOf<number>()
			return next({ validated: true as const })
		})

		honey<{}>()
			.context({ config: { timeout: 5000 } })
			.get("/test")
			.use(routeMw)
			.handler((ctx) => {
				expectTypeOf(ctx.config).toEqualTypeOf<{ timeout: number }>()
				expectTypeOf(ctx.validated).toEqualTypeOf<true>()
				return ctx.res.text("ok", "ok")
			})
	})
})
