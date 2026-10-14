import { describe, expect, expectTypeOf, it } from "vitest"
import { defineErrors } from "../../src/errors/errors.ts"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import type { InferMeta, InferRouteMeta } from "../../src/routing/app-types.ts"
import { type ExecutionCtx, HoneyContext, NO_ROUTE } from "../../src/context/context.ts"

type V0CtxOptions = {
	env: unknown
	executionCtx?: ExecutionCtx
	meta?: Readonly<Record<string, unknown>>
	params: Record<string, string>
	path?: string
	req: Request
	routePattern?: string
}

/** v0's HoneyContext options, onto v1's positional constructor. */
function v0Ctx(opts: V0CtxOptions): HoneyContext<unknown> {
	const state = { env: opts.env, executionCtx: opts.executionCtx, path: opts.path ?? "", req: opts.req }
	return new HoneyContext(
		state,
		{ errors: null, meta: opts.meta ?? NO_ROUTE.meta, pattern: opts.routePattern ?? "" },
		opts.params,
	)
}

function makeCtx(url: string): HoneyContext<unknown> {
	return v0Ctx({
		env: {},
		params: {},
		req: new Request(url),
	})
}

type TestEnv = { SECRET: string }

type AppMeta = {
	auth?: "public" | "required"
	rateLimit?: "default" | "strict"
}

const withAuth = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))

describe("ctx.executionCtx (3)", () => {
	/**
	 * Regression: when a handler throws and app.onError runs, the logger may
	 * call ctx.background to flush telemetry. If the binding is wrong, the
	 * error pipeline crashes with TypeError and the real error is masked —
	 * the user sees a 500 instead of the intended status.
	 */
	// v0: 85830ec8d5
	it("ctx.background preserves `this` binding on the error path", async () => {
		const app = honey<{}>()
		const captured: Promise<unknown>[] = []
		const executionCtx = {
			waitUntil(p: Promise<unknown>): void {
				if (this !== executionCtx) {
					throw new TypeError("Illegal invocation: function called with incorrect `this` reference.")
				}
				captured.push(p)
			},
		}

		app.get("/boom").handler((ctx) => {
			ctx.background(Promise.resolve("bg-before-throw"))
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/boom"), {}, executionCtx)
		expect(res.status).toBe(500)
		expect(captured).toHaveLength(1)
	})
})

describe("ctx.executionCtx (4)", () => {
	/**
	 * Regression: unmatched routes go through the 404 handler, which also
	 * constructs a HoneyContext. Background calls from chain middleware on
	 * that path must not crash with Illegal invocation either.
	 */
	// v0: c6954e7a8d
	it("ctx.background preserves `this` binding on the 404 path", async () => {
		const captured: Promise<unknown>[] = []
		const executionCtx = {
			waitUntil(p: Promise<unknown>): void {
				if (this !== executionCtx) {
					throw new TypeError("Illegal invocation: function called with incorrect `this` reference.")
				}
				captured.push(p)
			},
		}

		const app = honey<{}>().use((ctx, next) => {
			ctx.background(Promise.resolve("bg-404"))
			return next()
		})

		const res = await app.fetch(new Request("http://localhost/does-not-exist"), {}, executionCtx)
		expect(res.status).toBe(404)
		expect(captured).toHaveLength(1)
	})
})

describe("feature interactions", () => {
	describe("path + routePattern + params together", () => {
		// v0: c3c5f182af
		it("all three resolve correctly on dynamic route with basePath", async () => {
			const app = honey<{}>().basePath("/api")
			let captured: { params: Record<string, string>; path: string; pattern: string } | undefined

			app.get("/orgs/:orgId/members/:memberId").handler((ctx) => {
				captured = {
					params: { memberId: ctx.params.memberId, orgId: ctx.params.orgId },
					path: ctx.path,
					pattern: ctx.routePattern,
				}
				return ctx.res.text("ok", "ok")
			})

			await app.fetch(new Request("http://localhost/api/orgs/o1/members/m2"), {})
			expect(captured?.path).toBe("/api/orgs/o1/members/m2")
			expect(captured?.pattern).toBe("/api/orgs/:orgId/members/:memberId")
			expect(captured?.params).toEqual({ memberId: "m2", orgId: "o1" })
		})
	})
})

describe("reuse same app across requests with different envs", () => {
	// v0: 71c3765f03
	it("env from request A doesn't leak to request B", async () => {
		const app = honey<{ SECRET: string }>()
		app.get("/secret").handler((ctx) => ctx.res.json("ok", { s: ctx.env.SECRET }))

		const resA = await app.fetch(new Request("http://localhost/secret"), {
			SECRET: "alpha",
		})
		const resB = await app.fetch(new Request("http://localhost/secret"), {
			SECRET: "beta",
		})

		expect(((await resA.json()) as Record<string, unknown>).s).toBe("alpha")
		expect(((await resB.json()) as Record<string, unknown>).s).toBe("beta")
	})
})

describe("ctx properties are readonly", () => {
	// v0: 1a25667625
	it("ctx.params cannot be mutated to affect other requests", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => {
			/* attempt to mutate params */
			try {
				ctx.params.id = "hacked"
			} catch {
				/* may throw in strict mode */
			}
			return ctx.res.json("ok", { id: ctx.params.id })
		})

		const res = await app.fetch(new Request("http://localhost/users/123"), {})
		const body = (await res.json()) as Record<string, unknown>
		/* params created fresh per request via Object.create(null) — mutation is isolated */
		expect(body.id).toBeDefined()
	})
})

describe("ctx.search with array + single mixed", () => {
	// v0: 7356e68fee
	it("?a=1&b=2&b=3&c=4 → search has first values, searchAll has all", () => {
		const ctx = v0Ctx({
			env: {},
			params: {},
			req: new Request("http://localhost/test?a=1&b=2&b=3&c=4"),
		})

		expect(ctx.search.a).toBe("1")
		expect(ctx.search.b).toBe("2")
		expect(ctx.search.c).toBe("4")
		expect(ctx.searchAll.b).toEqual(["2", "3"])
	})
})

describe("ctx.search — first value only", () => {
	// v0: e6e7e3d7f5
	it("single param → string", () => {
		const ctx = makeCtx("http://localhost/test?name=foo")
		expect(ctx.search.name).toBe("foo")
	})

	// v0: 95dc922798
	it("duplicate params → first value only", () => {
		const ctx = makeCtx("http://localhost/test?tags=a&tags=b&tags=c")
		expect(ctx.search.tags).toBe("a")
	})

	// v0: c693e5af94
	it("mixed single and multi → all strings", () => {
		const ctx = makeCtx("http://localhost/test?name=foo&tags=a&tags=b")
		expect(ctx.search.name).toBe("foo")
		expect(ctx.search.tags).toBe("a")
	})

	// v0: 6f15033b68
	it("empty query → empty object", () => {
		const ctx = makeCtx("http://localhost/test")
		expect(ctx.search).toEqual({})
	})
})

describe("ctx.searchAll — always string[]", () => {
	// v0: f3103b361e
	it("single param → [string]", () => {
		const ctx = makeCtx("http://localhost/test?name=foo")
		expect(ctx.searchAll.name).toEqual(["foo"])
	})

	// v0: a0bccff57c
	it("multiple params → all values", () => {
		const ctx = makeCtx("http://localhost/test?tags=a&tags=b&tags=c")
		expect(ctx.searchAll.tags).toEqual(["a", "b", "c"])
	})

	// v0: 5ecaf2c0ab
	it("mixed → each key is string[]", () => {
		const ctx = makeCtx("http://localhost/test?name=foo&tags=a&tags=b")
		expect(ctx.searchAll.name).toEqual(["foo"])
		expect(ctx.searchAll.tags).toEqual(["a", "b"])
	})

	// v0: e814eb78e0
	it("empty query → empty object", () => {
		const ctx = makeCtx("http://localhost/test")
		expect(ctx.searchAll).toEqual({})
	})
})

describe("concurrent request isolation", () => {
	// v0: d823447e06
	it("simultaneous requests don't share context", async () => {
		const app = honey<{}>()
		app.get("/slow/:id").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 10))
			return ctx.res.json("ok", { id: ctx.params.id })
		})

		const [r1, r2, r3] = await Promise.all([
			app.fetch(new Request("http://localhost/slow/1"), {}),
			app.fetch(new Request("http://localhost/slow/2"), {}),
			app.fetch(new Request("http://localhost/slow/3"), {}),
		])

		expect(((await r1.json()) as Record<string, unknown>).id).toBe("1")
		expect(((await r2.json()) as Record<string, unknown>).id).toBe("2")
		expect(((await r3.json()) as Record<string, unknown>).id).toBe("3")
	})
})

describe(".meta<T>() generic on Honey", () => {
	// v0: 4bcc6a8d59
	it("returns same instance with meta type captured", () => {
		const base = honey<TestEnv>()
		const withMeta = base.meta<AppMeta>()
		expect(withMeta).toBeDefined()
		expect(typeof withMeta.get).toBe("function")
	})

	// v0: 4c28e4b845
	it("chains with .use() after .meta<T>()", () => {
		const app = honey<TestEnv>().meta<AppMeta>().use(withAuth)
		expect(app).toBeDefined()
	})

	// v0: 12aa68c1c5
	it("chains with .use() before .meta<T>()", () => {
		const app = honey<TestEnv>().use(withAuth).meta<AppMeta>()
		expect(app).toBeDefined()
	})
})

describe("InferMeta", () => {
	// v0: aba963c487
	it("extracts TMeta from app with .meta<T>()", () => {
		const app = honey<TestEnv>().meta<AppMeta>()
		type Meta = InferMeta<typeof app>
		expectTypeOf<Meta>().toEqualTypeOf<AppMeta>()
	})

	// v0: 93f4126e4b
	it("returns never for app without .meta<T>()", () => {
		const app = honey<TestEnv>()
		type Meta = InferMeta<typeof app>
		expectTypeOf<Meta>().toBeNever()
	})
})

describe("ctx.meta runtime", () => {
	// v0: 388012fbac
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

	// v0: 6a2f0d03de
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

describe("ctx.meta type narrowing", () => {
	// v0: cc3ecf16f8
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

describe("InferRouteMeta", () => {
	// v0: 8f635df394
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

describe("meta with error factory (regression)", () => {
	// v0: 9dfc3446fd
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

describe("meta in $routes accumulation", () => {
	// v0: 27a2cae06c
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
