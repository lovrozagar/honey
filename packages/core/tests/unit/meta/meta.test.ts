import { describe, expect, expectTypeOf, it } from "vitest"
import type { InferMeta, InferRouteMeta } from "../../../src/index.ts"
import type { HoneyMeta } from "../../../src/index.ts"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"

/* ---- fixtures ---- */

type TestEnv = { SECRET: string }

type AppMeta = {
	auth?: "public" | "required"
	rateLimit?: "default" | "strict"
}

const withAuth = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))

/* ---- .meta<T>() on Honey ---- */

describe(".meta<T>() generic on Honey", () => {
	it("returns same instance with meta type captured", () => {
		const base = honey<TestEnv>()
		const withMeta = base.meta<AppMeta>()
		expect(withMeta).toBeDefined()
		expect(typeof withMeta.get).toBe("function")
	})

	it("chains with .use() after .meta<T>()", () => {
		const app = honey<TestEnv>().meta<AppMeta>().use(withAuth)
		expect(app).toBeDefined()
	})

	it("chains with .use() before .meta<T>()", () => {
		const app = honey<TestEnv>().use(withAuth).meta<AppMeta>()
		expect(app).toBeDefined()
	})
})

/* ---- InferMeta ---- */

describe("InferMeta", () => {
	it("extracts TMeta from app with .meta<T>()", () => {
		const app = honey<TestEnv>().meta<AppMeta>()
		type Meta = InferMeta<typeof app>
		expectTypeOf<Meta>().toEqualTypeOf<AppMeta>()
	})

	it("returns never for app without .meta<T>()", () => {
		const app = honey<TestEnv>()
		type Meta = InferMeta<typeof app>
		expectTypeOf<Meta>().toBeNever()
	})
})

/* ---- route .meta() typed against DefaultMeta & TMeta ---- */

describe("route .meta() typing", () => {
	it("accepts DefaultMeta fields (openApi) without .meta<T>()", () => {
		const app = honey<TestEnv>()
			.get("/health")
			.meta({ summary: "Health check" })
			.handler((c) => c.res.text("ok", "ok"))

		expect(app).toBeDefined()
	})

	it("accepts TMeta fields when .meta<T>() is set", () => {
		const app = honey<TestEnv>()
			.meta<AppMeta>()
			.get("/orgs")
			.meta({ auth: "required", rateLimit: "strict" })
			.handler((c) => c.res.text("ok", "ok"))

		expect(app).toBeDefined()
	})

	it("accepts both DefaultMeta and TMeta fields together", () => {
		const app = honey<TestEnv>()
			.meta<AppMeta>()
			.get("/orgs")
			.meta({
				auth: "required",
				rateLimit: "strict",
				summary: "List orgs",
				tags: ["Organization"],
			})
			.handler((c) => c.res.text("ok", "ok"))

		expect(app).toBeDefined()
	})

	it("accumulates multiple .meta() calls via intersection", () => {
		const app = honey<TestEnv>()
			.meta<AppMeta>()
			.get("/orgs")
			.meta({ auth: "required" })
			.meta({ rateLimit: "strict" })
			.handler((c) => c.res.text("ok", "ok"))

		expect(app).toBeDefined()
	})
})

/* ---- ctx.meta runtime access ---- */

describe("ctx.meta runtime", () => {
	it("provides meta on handler context", async () => {
		let captured: Record<string, unknown> | undefined

		const app = honey<TestEnv>()
			.meta<AppMeta>()
			.get("/orgs")
			.meta({ auth: "required", rateLimit: "strict" })
			.handler((c) => {
				captured = c.meta as Record<string, unknown>
				return c.res.text("ok", "ok")
			})

		const res = await app.fetch(new Request("http://localhost/orgs"), { SECRET: "s" })
		expect(res.status).toBe(200)
		expect(captured).toEqual({ auth: "required", rateLimit: "strict" })
	})

	it("provides empty object when no .meta() on route", async () => {
		let captured: unknown

		const app = honey<TestEnv>()
			.meta<AppMeta>()
			.get("/health")
			.handler((c) => {
				captured = c.meta
				return c.res.text("ok", "ok")
			})

		const res = await app.fetch(new Request("http://localhost/health"), { SECRET: "s" })
		expect(res.status).toBe(200)
		expect(captured).toEqual({})
	})

	it("openApi fields are flat on ctx.meta at runtime", async () => {
		let captured: Record<string, unknown> | undefined

		const app = honey<TestEnv>()
			.get("/docs")
			.meta({ summary: "Docs endpoint" })
			.handler((c) => {
				captured = c.meta as unknown as Record<string, unknown>
				return c.res.text("ok", "ok")
			})

		const res = await app.fetch(new Request("http://localhost/docs"), { SECRET: "s" })
		expect(res.status).toBe(200)
		expect(captured).toEqual({ summary: "Docs endpoint" })
	})

	it("ctx.meta is readonly at type level", () => {
		honey<TestEnv>()
			.meta<AppMeta>()
			.get("/x")
			.meta({ auth: "required" })
			.handler((c) => {
				expectTypeOf(c.meta).toMatchTypeOf<Readonly<{ auth: "required" }>>()
				return c.res.text("ok", "ok")
			})
	})
})

/* ---- ctx.meta type narrowing ---- */

describe("ctx.meta type narrowing", () => {
	it("narrows to exact literal passed in .meta()", () => {
		honey<TestEnv>()
			.meta<AppMeta>()
			.get("/orgs")
			.meta({ auth: "required", rateLimit: "strict" })
			.handler((c) => {
				expectTypeOf(c.meta.auth).toEqualTypeOf<"required">()
				expectTypeOf(c.meta.rateLimit).toEqualTypeOf<"strict">()
				return c.res.text("ok", "ok")
			})
	})

	it("different routes get different narrowed types", () => {
		const base = honey<TestEnv>().meta<AppMeta>()

		base
			.get("/public")
			.meta({ auth: "public" })
			.handler((c) => {
				expectTypeOf(c.meta.auth).toEqualTypeOf<"public">()
				return c.res.text("ok", "ok")
			})

		base
			.get("/private")
			.meta({ auth: "required" })
			.handler((c) => {
				expectTypeOf(c.meta.auth).toEqualTypeOf<"required">()
				return c.res.text("ok", "ok")
			})
	})
})

/* ---- InferRouteMeta ---- */

describe("InferRouteMeta", () => {
	it("extracts meta from route type map", () => {
		type Routes = {
			"/orgs": {
				get: {
					ctx: unknown
					input: {}
					meta: { auth: "required"; rateLimit: "strict" }
					output: {}
				}
			}
		}

		type Meta = InferRouteMeta<{ $routes: Routes }, "/orgs", "get">
		expectTypeOf<Meta>().toEqualTypeOf<{ auth: "required"; rateLimit: "strict" }>()
	})
})

describe("HoneyMeta", () => {
	it("includes built-in OpenAPI meta fields alongside custom meta", () => {
		type Meta = HoneyMeta<AppMeta>

		expectTypeOf<Meta>().toMatchTypeOf<{
			internal?: boolean
			auth?: "public" | "required"
			invalidate?: readonly string[] | null
			operationId?: string
			rateLimit?: "default" | "strict"
			security?: string | string[] | Array<Record<string, string[]>>
			summary?: string
			tags?: string | string[]
		}>()
	})

	it("allows built-in meta fields when middleware ctx uses HoneyMeta<T>", () => {
		type Ctx = { meta: HoneyMeta<AppMeta> }

		const readInternal = (ctx: Ctx) => ctx.meta.internal
		expectTypeOf(readInternal).toBeFunction()
	})
})

/* ---- meta + error factory regression ---- */

describe("meta with error factory (regression)", () => {
	it("meta works when global error factory is set", () => {
		const errs = defineErrors({
			email_taken: "conflict",
		})

		const app = honey<TestEnv>()
			.meta<AppMeta>()
			.errorFactory(errs)
			.get("/orgs")
			.meta({ auth: "required" })
			.errors("email_taken")
			.handler((c) => {
				expectTypeOf(c.meta.auth).toEqualTypeOf<"required">()
				return c.res.text("ok", "ok")
			})

		expect(app).toBeDefined()
	})

	it("meta + error factory + middleware all chain together", async () => {
		const errs = defineErrors({
			not_allowed: "forbidden",
		})

		let captured: Record<string, unknown> | undefined

		const app = honey<TestEnv>()
			.meta<AppMeta>()
			.errorFactory(errs)
			.use(withAuth)
			.get("/orgs")
			.meta({ auth: "required", rateLimit: "strict" })
			.errors("not_allowed")
			.handler((c) => {
				captured = c.meta as Record<string, unknown>
				return c.res.text("ok", "ok")
			})

		const res = await app.fetch(new Request("http://localhost/orgs"), { SECRET: "s" })
		expect(res.status).toBe(200)
		expect(captured).toEqual({ auth: "required", rateLimit: "strict" })
	})
})

/* ---- MergeRoute includes meta ---- */

describe("meta in $routes accumulation", () => {
	it("meta appears in InferRouteMeta from app instance", () => {
		const app = honey<TestEnv>()
			.meta<AppMeta>()
			.get("/orgs")
			.meta({ auth: "required" })
			.handler((c) => c.res.text("ok", "ok"))

		type Meta = InferRouteMeta<typeof app, "/orgs", "get">
		expectTypeOf<Meta>().toMatchTypeOf<{ auth: "required" }>()
	})
})
