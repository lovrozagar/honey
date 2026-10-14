import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { HoneyRes } from "../../src/response/response.ts"
import type { InferBasePath, InferCtx, InferEnv, InferMeta } from "../../src/routing/app-types.ts"
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

describe("what if HoneyRes methods called outside request", () => {
	// v0: 0a58fdc5a5
	it("HoneyRes.json works standalone (no request context needed)", () => {
		const res = new HoneyRes()
		const response = res.json("ok", { standalone: true })
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("application/json")
	})

	// v0: 33cccc4f70
	it("HoneyRes.text works standalone", () => {
		const res = new HoneyRes()
		const response = res.text("created", "hello")
		expect(response.status).toBe(201)
	})
})

describe("app.context() — compile-time type safety", () => {
	// v0: 4aa5223310
	it("single .context() adds fields to InferCtx", () => {
		const app = honey<{}>().context({ db: "sqlite", version: 3 })
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{ readonly db: string; readonly version: number }>()
	})

	// v0: 4af2f1ad51
	it("multiple .context() calls accumulate types", () => {
		const app = honey<{}>().context({ a: 1 }).context({ b: "two" }).context({ c: true })
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{
			readonly a: number
			readonly b: string
			readonly c: boolean
		}>()
	})

	// v0: 15a01a5968
	it("context values are Readonly in the type", () => {
		const app = honey<{}>().context({ config: { debug: true } })
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{
			readonly config: { debug: boolean }
		}>()
	})

	// v0: a05cd6822b
	it("env type preserved through .context()", () => {
		type TestEnv = { SECRET: string; DB_URL: string }
		const app = honey<TestEnv>().context({ ready: true })
		expectTypeOf<InferEnv<typeof app>>().toEqualTypeOf<TestEnv>()
	})

	// v0: ba08ca3116
	it("basePath type preserved through .context()", () => {
		const app = honey<{}>().basePath("/api").context({ v: 1 })
		expectTypeOf<InferBasePath<typeof app>>().toEqualTypeOf<"/api">()
	})

	// v0: 22f939dce9
	it(".context() + .use() types accumulate together", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))
		const app = honey<{}>().context({ region: "eu" }).use(mw)
		type Ctx = InferCtx<typeof app>
		expectTypeOf<Ctx>().toMatchTypeOf<{
			readonly region: string
			userId: string
		}>()
	})
})

describe("app.context() — compile-time type safety (2)", () => {
	// v0: 3bc43be1a6
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

	// v0: 10be49f6aa
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

	// v0: 70672703cc
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
})

describe("app.context() — compile-time type safety (3)", () => {
	// v0: 8521d1da18
	it("middleware with TReqs depending on context — types compose", () => {
		const mw = createMiddleware(async (ctx: { db: string }, next) => {
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

	// v0: 84dca20c67
	it("later .context() overwrite narrows type for same key", () => {
		const app = honey<{}>()
			.context({ x: "first" as string })
			.context({ x: "second" as const })
		type Ctx = InferCtx<typeof app>
		/* last .context() type wins via intersection — "second" is narrower */
		expectTypeOf<Ctx>().toMatchTypeOf<{ readonly x: "second" }>()
	})

	// v0: 05f38f4f3e
	it("context does not affect InferMeta", () => {
		type AppMeta = { tags?: string }
		const app = honey<{}>().meta<AppMeta>().context({ db: "sqlite" })
		type M = InferMeta<typeof app>
		expectTypeOf<M>().toEqualTypeOf<AppMeta>()
	})

	// v0: 7c994b6cd7
	it("route-level .use() sees context types in TReqs", () => {
		const routeMw = createMiddleware(async (ctx: { config: { timeout: number } }, next) => {
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

describe("header case insensitivity", () => {
	// v0: 450b1f20f3
	it("ctx.headers lowercases all keys", () => {
		const ctx = v0Ctx({
			env: {},
			params: {},
			req: new Request("http://localhost/test", {
				headers: { Authorization: "Bearer abc", "X-Custom-Header": "value" },
			}),
		})

		expect(ctx.headers["x-custom-header"]).toBe("value")
		expect(ctx.headers["authorization"]).toBe("Bearer abc")
		/* original casing not preserved */
		expect(ctx.headers["X-Custom-Header"]).toBeUndefined()
	})
})

describe("path and routePattern with complex routes", () => {
	// v0: 2e2f81028c
	it("wildcard route pattern preserved", async () => {
		const app = honey<{}>()
		let pattern: string | undefined

		app.get("/files/*path").handler((ctx) => {
			pattern = ctx.routePattern
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/files/a/b/c"), {})
		expect(pattern).toBe("/files/*path")
	})

	// v0: e4887f8a9a
	it("optional param route pattern preserved", async () => {
		const app = honey<{}>()
		let pattern: string | undefined

		app.get("/:lang?").handler((ctx) => {
			pattern = ctx.routePattern
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/en"), {})
		expect(pattern).toBe("/:lang?")
	})
})

describe("returning ctx.res.json() result from a different route's handler", () => {
	// v0: 4c71266875
	it("precomputed response object reused across requests → each request isolated", async () => {
		const app = honey<{}>()

		/* developer caches a response — BAD but shouldn't crash */
		let cached: Response | undefined
		app.get("/cache").handler((ctx) => {
			if (!cached) {
				cached = ctx.res.json("ok", { cached: true })
			}
			return ctx.res.raw(cached)
		})

		const r1 = await app.fetch(new Request("http://localhost/cache"), {})
		expect(r1.status).toBe(200)

		/* second request — cached Response body was already consumed */
		const r2 = await app.fetch(new Request("http://localhost/cache"), {})
		/* body may be empty (consumed) or work (depends on runtime) — must not crash */
		expect([200, 500]).toContain(r2.status)
	})
})

describe("ctx.routePattern", () => {
	// v0: ccd34081e7
	it("param route → pattern contains :param", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { pattern: ctx.routePattern }))

		const res = await app.fetch(new Request("http://localhost/users/42"), {})
		const data = (await res.json()) as Record<string, string>
		expect(data.pattern).toBe("/users/:id")
	})

	// v0: 046f3f6b14
	it("wildcard route → pattern contains *", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { pattern: ctx.routePattern }))

		const res = await app.fetch(new Request("http://localhost/files/a/b/c"), {})
		const data = (await res.json()) as Record<string, string>
		expect(data.pattern).toBe("/files/*path")
	})

	// v0: b441d104e3
	it("nested param route → full pattern preserved", async () => {
		const app = honey<{}>()
		app.get("/orgs/:orgId/users/:userId").handler((ctx) => ctx.res.json("ok", { pattern: ctx.routePattern }))

		const res = await app.fetch(new Request("http://localhost/orgs/a/users/b"), {})
		const data = (await res.json()) as Record<string, string>
		expect(data.pattern).toBe("/orgs/:orgId/users/:userId")
	})
})

describe("concurrent requests: state isolation", () => {
	// v0: 086c7815fe
	it("100 parallel requests with different params → no cross-contamination", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const results = await Promise.all(
			Array.from({ length: 100 }, (_, i) =>
				Promise.resolve(app.fetch(new Request(`http://localhost/users/${i}`), {})).then(
					(r) => r.json() as Promise<Record<string, string>>,
				),
			),
		)

		for (let i = 0; i < 100; i++) {
			expect(results[i].id).toBe(String(i))
		}
	})
})

describe("optional param at root", () => {
	// v0: 1119079a6a
	it("/:lang? matches both / and /en", async () => {
		const app = honey<{}>()
		app.get("/:lang?").handler((ctx) => ctx.res.json("ok", { lang: ctx.params.lang ?? "default" }))

		const root = await app.fetch(new Request("http://localhost/"), {})
		expect(root.status).toBe(200)
		const rootBody = (await root.json()) as Record<string, unknown>
		expect(rootBody.lang).toBe("default")

		const en = await app.fetch(new Request("http://localhost/en"), {})
		expect(en.status).toBe(200)
		const enBody = (await en.json()) as Record<string, unknown>
		expect(enBody.lang).toBe("en")
	})
})

describe("double slash in URL", () => {
	// v0: 059275d8dd
	it("//health normalizes to /health", async () => {
		const app = honey<{}>()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost//health"), {})
		expect(res.status).toBe(200)
	})
})

describe("ctx.executionCtx", () => {
	// v0: 4cdb0f86ab
	it("returns execution context when provided", async () => {
		const app = honey<{}>()
		let captured: unknown

		app.get("/test").handler((ctx) => {
			captured = ctx.executionCtx
			return ctx.res.text("ok", "ok")
		})

		const waitUntil = vi.fn<(p: Promise<unknown>) => void>()
		await app.fetch(new Request("http://localhost/test"), {}, { waitUntil })
		expect(captured).toEqual({ waitUntil })
	})

	// v0: 2b0365b6c3
	it("is undefined when not provided", async () => {
		const app = honey<{}>()
		let captured: unknown = "not-set"

		app.get("/test").handler((ctx) => {
			captured = ctx.executionCtx
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/test"), {})
		expect(captured).toBeUndefined()
	})

	// v0: d41b1bcb2d
	it("ctx.background still works alongside executionCtx", async () => {
		const app = honey<{}>()
		const waitUntil = vi.fn<(p: Promise<unknown>) => void>()

		app.get("/test").handler((ctx) => {
			ctx.background(Promise.resolve("bg"))
			return ctx.res.text("ok", "ok")
		})

		await app.fetch(new Request("http://localhost/test"), {}, { waitUntil })
		expect(waitUntil).toHaveBeenCalledOnce()
	})
})

describe("ctx.executionCtx (2)", () => {
	/**
	 * Regression: workerd's ExecutionContext.waitUntil is a native method that
	 * throws "Illegal invocation" when called with the wrong `this`. Earlier
	 * mocks used vi.fn() (a plain arrow-like function) which hid the bug —
	 * HoneyContext was capturing opts.waitUntil detached and invoking it without
	 * its owning executionCtx. This test models workerd's contract.
	 */
	// v0: f5a5019dfa
	it("ctx.background preserves `this` binding when executionCtx.waitUntil is a method", async () => {
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

		app.get("/test").handler((ctx) => {
			ctx.background(Promise.resolve("bg"))
			return ctx.res.text("ok", "ok")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {}, executionCtx)
		expect(res.status).toBe(200)
		expect(captured).toHaveLength(1)
	})
})
