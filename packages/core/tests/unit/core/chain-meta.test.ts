import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { createMiddleware, honey } from "../../../src/index.ts"
import type { InferBasePath, InferCtx, InferEnv, InferMeta } from "../../../src/types.ts"

type AppMeta = { security?: string; tags?: string }

describe("chain-level .meta(values) — runtime", () => {
	it("chain meta accessible via ctx.meta in handler", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })

		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", { sec: ctx.meta.security }),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
	})

	it("route-level .meta() merges with chain meta", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })

		app
			.get("/test")
			.meta({ tags: "Auth" })
			.handler((ctx) =>
				ctx.res.json("ok", { sec: ctx.meta.security, tags: ctx.meta.tags }),
			)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
		expect(body.tags).toBe("Auth")
	})

	it("route-level .meta() overrides chain meta on conflict", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt", tags: "Default" })

		app
			.get("/test")
			.meta({ tags: "Override" })
			.handler((ctx) =>
				ctx.res.json("ok", { sec: ctx.meta.security, tags: ctx.meta.tags }),
			)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
		expect(body.tags).toBe("Override")
	})

	it("multiple .meta(values) calls on chain accumulate", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.meta({ tags: "Auth" })

		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", { sec: ctx.meta.security, tags: ctx.meta.tags }),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
		expect(body.tags).toBe("Auth")
	})

	it("chain meta propagates through .basePath()", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.basePath("/api")

		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", { sec: ctx.meta.security }),
		)

		const res = await app.fetch(new Request("http://localhost/api/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
	})

	it("chain meta propagates through .use()", async () => {
		const mw = createMiddleware(async (_ctx, next) => next({ added: true }))
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.use(mw)

		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", { added: ctx.added, sec: ctx.meta.security }),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
		expect(body.added).toBe(true)
	})

	it("chain meta propagates through .context()", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.context({ region: "eu" })

		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", { region: ctx.region, sec: ctx.meta.security }),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
		expect(body.region).toBe("eu")
	})

	it("routes without route-level .meta() still get chain meta", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt", tags: "Default" })

		app.get("/bare").handler((ctx) =>
			ctx.res.json("ok", { sec: ctx.meta.security, tags: ctx.meta.tags }),
		)

		const res = await app.fetch(new Request("http://localhost/bare"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
		expect(body.tags).toBe("Default")
	})

	it("different sub-chains can have different meta", async () => {
		const base = honey<{}>().meta<AppMeta>()
		const auth = base.meta({ security: "jwt", tags: "Auth" })
		const pub = base.meta({ tags: "Public" })

		auth.get("/authed").handler((ctx) =>
			ctx.res.json("ok", { sec: ctx.meta.security, tags: ctx.meta.tags }),
		)
		pub.get("/public").handler((ctx) =>
			ctx.res.json("ok", { sec: ctx.meta.security, tags: ctx.meta.tags }),
		)

		const r1 = await base.fetch(new Request("http://localhost/authed"), {})
		const b1 = (await r1.json()) as Record<string, unknown>
		expect(b1.sec).toBe("jwt")
		expect(b1.tags).toBe("Auth")

		const r2 = await base.fetch(new Request("http://localhost/public"), {})
		const b2 = (await r2.json()) as Record<string, unknown>
		expect(b2.sec).toBeUndefined()
		expect(b2.tags).toBe("Public")
	})

	it("works without phantom .meta<T>() — uses DefaultMeta", async () => {
		const app = honey<{}>().meta({ summary: "default summary" })

		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", { summary: ctx.meta.summary }),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.summary).toBe("default summary")
	})

	it("chain meta with .on() multi-method routes", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })

		app
			.on(["GET", "POST"], "/multi")
			.handler((ctx) => ctx.res.json("ok", { sec: ctx.meta.security }))

		const r1 = await app.fetch(new Request("http://localhost/multi"), {})
		const b1 = (await r1.json()) as Record<string, unknown>
		expect(b1.sec).toBe("jwt")

		const r2 = await app.fetch(
			new Request("http://localhost/multi", { method: "POST" }),
			{},
		)
		const b2 = (await r2.json()) as Record<string, unknown>
		expect(b2.sec).toBe("jwt")
	})

	it("chain meta + context + middleware all compose", async () => {
		const mw = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))

		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.context({ region: "eu" })
			.use(mw)

		app.get("/full").handler((ctx) =>
			ctx.res.json("ok", {
				region: ctx.region,
				sec: ctx.meta.security,
				user: ctx.userId,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/full"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
		expect(body.region).toBe("eu")
		expect(body.user).toBe("u-1")
	})

	it("sub-app via .route() keeps its own chain meta", async () => {
		const sub = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "apikey", tags: "Sub" })
			.basePath("/sub")

		sub.get("/test").handler((ctx) =>
			ctx.res.json("ok", { sec: ctx.meta.security, tags: ctx.meta.tags }),
		)

		const parent = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt", tags: "Parent" })

		parent.get("/test").handler((ctx) =>
			ctx.res.json("ok", { sec: ctx.meta.security, tags: ctx.meta.tags }),
		)
		parent.route(sub)

		const r1 = await parent.fetch(new Request("http://localhost/test"), {})
		const b1 = (await r1.json()) as Record<string, unknown>
		expect(b1.sec).toBe("jwt")
		expect(b1.tags).toBe("Parent")

		const r2 = await parent.fetch(
			new Request("http://localhost/sub/test"),
			{},
		)
		const b2 = (await r2.json()) as Record<string, unknown>
		expect(b2.sec).toBe("apikey")
		expect(b2.tags).toBe("Sub")
	})

	it("chain meta with input + output + errors compose", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt", tags: "Items" })

		app
			.post("/items")
			.meta({ operationId: "createItem" })
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { created: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("created", { id: "i-1" }))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ name: "test" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBe("i-1")
	})

	it("later chain .meta() overrides earlier on same key", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "basic" })
			.meta({ security: "jwt" })

		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", { sec: ctx.meta.security }),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
	})
})

describe("chain-level .meta(values) — compile-time type safety", () => {
	it("phantom .meta<T>() still works unchanged", () => {
		const app = honey<{}>().meta<AppMeta>()
		type M = InferMeta<typeof app>
		expectTypeOf<M>().toEqualTypeOf<AppMeta>()
	})

	it("single-call .meta<T>(values) sets TMeta and runtime defaults", async () => {
		const app = honey<{}>().meta<AppMeta>({ security: "jwt" })
		type M = InferMeta<typeof app>
		expectTypeOf<M>().toEqualTypeOf<AppMeta>()

		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", { sec: ctx.meta.security }),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.sec).toBe("jwt")
	})

	it("chain .meta(values) preserves TMeta constraint", () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
		type M = InferMeta<typeof app>
		expectTypeOf<M>().toEqualTypeOf<AppMeta>()
	})

	it("multiple chain .meta(values) all preserve TMeta", () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.meta({ tags: "Auth" })
		type M = InferMeta<typeof app>
		expectTypeOf<M>().toEqualTypeOf<AppMeta>()
	})

	it("TMeta preserved through .use() after chain meta", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ x: 1 }))
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.use(mw)
		type M = InferMeta<typeof app>
		expectTypeOf<M>().toEqualTypeOf<AppMeta>()
	})

	it("TMeta preserved through .basePath() after chain meta", () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.basePath("/api")
		type M = InferMeta<typeof app>
		expectTypeOf<M>().toEqualTypeOf<AppMeta>()
	})

	it("TMeta preserved through .context() after chain meta", () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.context({ db: "sqlite" })
		type M = InferMeta<typeof app>
		expectTypeOf<M>().toEqualTypeOf<AppMeta>()
	})

	it("route .meta() still constrained by TMeta after chain meta", () => {
		honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.get("/test")
			.meta({ tags: "Auth" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta).toMatchTypeOf<
					Readonly<{ security?: string; tags?: string }>
				>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("ctx.meta typed from TMeta in handler — both keys present", () => {
		honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.get("/test")
			.meta({ tags: "Auth" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta.security).toEqualTypeOf<string | undefined>()
				expectTypeOf(ctx.meta.tags).toEqualTypeOf<string | undefined>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("ctx.meta typed even without route-level .meta()", () => {
		honey<{}>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.get("/bare")
			.handler((ctx) => {
				expectTypeOf(ctx.meta).toMatchTypeOf<Readonly<{}>>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("InferCtx unaffected by chain meta", () => {
		const app = honey<{ SECRET: string }>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{ env: { SECRET: string } }>()
	})

	it("env type preserved through chain meta", () => {
		type TestEnv = { DB: string; SECRET: string }
		const app = honey<TestEnv>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
		type Env = InferEnv<typeof app>
		expectTypeOf<Env>().toEqualTypeOf<TestEnv>()
	})

	it("without phantom .meta<T>() — DefaultMeta fields accepted", () => {
		const app = honey<{}>().meta({ summary: "hello", tags: "test" })
		type M = InferMeta<typeof app>
		/* TMeta stays never when no phantom call */
		expectTypeOf<M>().toEqualTypeOf<never>()
	})

	it("InferCtx unaffected by chain meta", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ x: 1 }))
		const app = honey<{ SECRET: string }>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.use(mw)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{ env: { SECRET: string }; x: number }>()
	})

	it("InferBasePath unaffected by chain meta", () => {
		const app = honey<{}>()
			.basePath("/api")
			.meta<AppMeta>()
			.meta({ security: "jwt" })
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/api">()
	})

	it("InferEnv unaffected by chain meta", () => {
		type E = { DB: string }
		const app = honey<E>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
		expectTypeOf<InferEnv<typeof app>>().toEqualTypeOf<E>()
	})

	it("ctx.meta + ctx.context + ctx.middleware all typed in handler", () => {
		const mw = createMiddleware(async (_ctx, next) =>
			next({ traceId: "t-1" }),
		)

		honey<{ SECRET: string }>()
			.meta<AppMeta>()
			.meta({ security: "jwt" })
			.context({ region: "eu" })
			.use(mw)
			.get("/orgs/:orgId")
			.meta({ tags: "Orgs" })
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => {
				/* chain meta + route meta */
				expectTypeOf(ctx.meta.security).toEqualTypeOf<string | undefined>()
				expectTypeOf(ctx.meta.tags).toEqualTypeOf<string | undefined>()
				/* context */
				expectTypeOf(ctx.region).toEqualTypeOf<string>()
				/* middleware */
				expectTypeOf(ctx.traceId).toEqualTypeOf<string>()
				/* input */
				expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
				/* params */
				expectTypeOf(ctx.params.orgId).toEqualTypeOf<string>()
				/* env */
				expectTypeOf(ctx.env.SECRET).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("different sub-chains preserve independent TMeta", () => {
		type MetaA = { auth?: string }
		type MetaB = { version?: number }

		const a = honey<{}>().meta<MetaA>().meta({ auth: "jwt" })
		const b = honey<{}>().meta<MetaB>().meta({ version: 1 })

		expectTypeOf<InferMeta<typeof a>>().toEqualTypeOf<MetaA>()
		expectTypeOf<InferMeta<typeof b>>().toEqualTypeOf<MetaB>()
	})
})
