/**
 * Tap typing: `.taps<T>()` declares each key's payload, so `ctx.tap()` takes only those keys and
 * their exact payloads, an `app.tap()` handler gets its key's payload and a TapContext (no `res`,
 * no `tap`), and route meta may carry any tap key with its payload. Without `.taps()`, `ctx.tap()`
 * takes any key. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import type { TapContext } from "../../src/routing/tap.ts"

type AppTaps = {
	audit: { action: string; actor_id: string }
	webhook: { event: string }
}

describe("ctx.tap(): keys and payloads from .taps<T>()", () => {
	// v0: fc68a018ed
	// v0: 0f942cb812
	// v0: e52161eadf
	it("a declared key takes its exact payload; any other key, shape or extra field is an error", () => {
		honey<{}>()
			.taps<AppTaps>()
			.get("/t")
			.handler((c) => {
				c.tap("audit", { action: "create", actor_id: "usr_1" })
				c.tap("webhook", { event: "created" })
				expectTypeOf<Parameters<typeof c.tap>[0]>().toEqualTypeOf<"audit" | "webhook">()
				// @ts-expect-error an undeclared key
				c.tap("nonexistent", {})
				// @ts-expect-error the wrong shape
				c.tap("audit", { wrong: true })
				// @ts-expect-error a required field missing
				c.tap("audit", { action: "create" })
				// @ts-expect-error another key's shape
				c.tap("webhook", { action: "nope" })
				// @ts-expect-error an extra field
				c.tap("audit", { action: "create", actor_id: "usr_1", extra: true })
				return c.res.json("ok", {})
			})
	})

	// v0: 931239c157
	// v0: bc13d010d8
	it("without .taps(), any key and any payload; it returns nothing either way", () => {
		honey<{}>()
			.get("/t")
			.handler((c) => {
				c.tap("anything", { any: "payload" })
				c.tap("other", 42)
				expectTypeOf(c.tap("more", null)).toBeVoid()
				return c.res.json("ok", {})
			})
	})
})

describe("app.tap(): the handler", () => {
	// v0: 9c2d380a3c
	it("gets its key's payload", () => {
		const app = honey<{}>().taps<AppTaps>()
		app.tap("audit", (_ctx, payload) => {
			expectTypeOf(payload).toEqualTypeOf<{ action: string; actor_id: string }>()
		})
		app.tap("webhook", (_ctx, payload) => {
			expectTypeOf(payload).toEqualTypeOf<{ event: string }>()
		})
	})

	// v0: ac27224138
	// v0: b5c3db911c
	it("gets a TapContext over the app's env: the request, no res and no tap", () => {
		type Env = { DB_URL: string; SECRET: string }
		honey<Env>()
			.taps<AppTaps>()
			.tap("audit", (ctx) => {
				expectTypeOf(ctx).toEqualTypeOf<TapContext<Env>>()
				expectTypeOf(ctx.env.SECRET).toEqualTypeOf<string>()
				expectTypeOf(ctx.params).toEqualTypeOf<Record<string, string>>()
				expectTypeOf(ctx.headers).toEqualTypeOf<Record<string, string>>()
				expectTypeOf(ctx.meta).toEqualTypeOf<Record<string, unknown>>()
				expectTypeOf(ctx.search).toEqualTypeOf<Record<string, string>>()
				expectTypeOf(ctx.req).toEqualTypeOf<Request>()
				expectTypeOf(ctx.background).toBeFunction()
				expectTypeOf(ctx).not.toHaveProperty("res")
				expectTypeOf(ctx).not.toHaveProperty("tap")
			})
	})

	// v0: 9f5d7cad5f
	// v0: d63932cc79
	it("may return nothing or a promise, and app.tap() returns the handle", () => {
		const app = honey<{}>().taps<AppTaps>()
		const chained = app.tap("audit", () => {}).tap("webhook", async () => {})
		expectTypeOf(chained).toEqualTypeOf(app)
	})
})

describe("route meta: tap keys with their payloads", () => {
	// v0: fe9637b053
	// v0: 0012d0d7c2
	it("a tap key in meta must carry its payload's shape; every tap key is optional there", () => {
		const app = honey<{}>().taps<AppTaps>()
		app
			.get("/a")
			.meta({ audit: { action: "create", actor_id: "usr_1" } })
			.handler((c) => {
				expectTypeOf(c.meta.audit).toEqualTypeOf<{ action: string; actor_id: string }>()
				return c.res.json("ok", {})
			})
		app
			.get("/b")
			// @ts-expect-error the wrong shape for audit
			.meta({ audit: { wrong: true } })
			.handler((c) => c.res.json("ok", {}))
		app.get("/none").handler((c) => c.res.json("ok", {}))
		app
			.get("/webhook")
			.meta({ webhook: { event: "created" } })
			.handler((c) => {
				expectTypeOf(c.meta.webhook).toEqualTypeOf<{ event: string }>()
				return c.res.json("ok", {})
			})
	})

	// v0: c81529e274
	// v0: 9a356bf11d
	// v0: d7ec11758e
	it("beside a .meta<T>() declaration, before or after it: both reach the handler's meta", () => {
		type RouteMeta = { operationId: string; security: string }
		honey<{}>()
			.meta<RouteMeta>()
			.taps<AppTaps>()
			.get("/a")
			.meta({ operationId: "a", security: "jwt", webhook: { event: "test" } })
			.handler((c) => {
				expectTypeOf(c.meta).toMatchTypeOf<
					Readonly<{ operationId: string; security: string; webhook: { event: string } }>
				>()
				return c.res.json("ok", {})
			})
		honey<{}>()
			.taps<AppTaps>()
			.meta<RouteMeta>()
			.get("/b")
			.meta({ audit: { action: "create", actor_id: "sys" }, operationId: "b", security: "jwt" })
			.handler((c) => {
				c.tap("webhook", { event: "done" })
				return c.res.json("ok", {})
			})
	})
})

describe("ctx.tap() keeps its keys through every handle", () => {
	// v0: 6d4061927d
	// v0: 6053b5e91c
	// v0: 0bb3f8b0bc
	// v0: 4b7706da43
	it("basePath, use, errorFactory and context all keep the declared taps", () => {
		const errors = defineErrors({ a: "bad_request", b: "not_found" })
		const app = honey<{}>().taps<AppTaps>()
		app
			.basePath("/api/v1")
			.get("/t")
			.handler((c) => {
				expectTypeOf(c.routePattern).toEqualTypeOf<"/api/v1/t">()
				// @ts-expect-error still declared after basePath
				c.tap("bad", {})
				return c.res.json("ok", {})
			})
		app
			.use(createMiddleware(async (_ctx, next) => next({ a: 1 })))
			.use(createMiddleware(async (_ctx, next) => next({ b: "two" })))
			.get("/u")
			.handler((c) => {
				expectTypeOf(c.a).toEqualTypeOf<number>()
				c.tap("audit", { action: "test", actor_id: "sys" })
				// @ts-expect-error still declared after use
				c.tap("bad", {})
				return c.res.json("ok", {})
			})
		app
			.errorFactory(errors)
			.defaultErrors("a")
			.get("/e")
			.errors("b")
			.handler((c) => {
				expectTypeOf(c.errors.b).toBeFunction()
				// @ts-expect-error still declared after errorFactory
				c.tap("bad", {})
				return c.res.json("ok", {})
			})
		app
			.context({ db: { query: () => [] as unknown[] } })
			.get("/c")
			.handler((c) => {
				expectTypeOf(c.db.query).toBeFunction()
				// @ts-expect-error still declared after context
				c.tap("nope", {})
				return c.res.json("ok", {})
			})
	})
})

describe("ctx.tap() beside a mounted sub-app", () => {
	// v0: f0e7d816a5
	it("a parent that mounted a sub keeps its own taps", () => {
		const child = honey<{}>()
		child.get("/child").handler((c) => c.res.json("ok", {}))
		const parent = honey<{}>().taps<AppTaps>()
		parent.route(child)
		parent.get("/parent").handler((c) => {
			c.tap("audit", { action: "test", actor_id: "sys" })
			expectTypeOf<Parameters<typeof c.tap>[0]>().toEqualTypeOf<"audit" | "webhook">()
			// @ts-expect-error still declared
			c.tap("bad", {})
			return c.res.json("ok", {})
		})
	})
})

describe("payload shapes", () => {
	// v0: 952178b9f4
	// v0: 9aff5039d2
	// v0: 6c6c854912
	it("nested objects, unions and arrays type both ends", () => {
		type Taps = {
			audit: { action: string; metadata: { ip: string; ua: string } }
			batch: { ids: string[]; operation: string }
			event: { id: string; type: "created" } | { reason: string; type: "deleted" }
		}
		const app = honey<{}>().taps<Taps>()
		app.get("/t").handler((c) => {
			c.tap("audit", { action: "create", metadata: { ip: "1.2.3.4", ua: "chrome" } })
			c.tap("event", { id: "1", type: "created" })
			c.tap("event", { reason: "cleanup", type: "deleted" })
			return c.res.json("ok", {})
		})
		app.tap("audit", (_ctx, payload) => expectTypeOf(payload.metadata.ip).toEqualTypeOf<string>())
		app.tap("batch", (_ctx, payload) => expectTypeOf(payload.ids).toEqualTypeOf<string[]>())
	})

	// v0: d33ab29fdf
	// v0: 1ca342352b
	it("one key or many: each is its own, and nothing else is a key", () => {
		honey<{}>()
			.taps<{ a: { x: number }; b: { y: string }; c: { z: boolean }; d: { w: null } }>()
			.get("/t")
			.handler((c) => {
				c.tap("a", { x: 1 })
				c.tap("d", { w: null })
				expectTypeOf<Parameters<typeof c.tap>[0]>().toEqualTypeOf<"a" | "b" | "c" | "d">()
				// @ts-expect-error e is not a key
				c.tap("e", {})
				return c.res.json("ok", {})
			})
		honey<{}>()
			.taps<{ log: { message: string } }>()
			.get("/t")
			.handler((c) => {
				c.tap("log", { message: "hello" })
				// @ts-expect-error only log
				c.tap("other", {})
				return c.res.json("ok", {})
			})
	})

	// v0: 35707c9e48
	it("$taps carries what .taps<T>() declared, and {} without it", () => {
		expectTypeOf<ReturnType<typeof honey<{}>>["$taps"]>().toEqualTypeOf<{}>()
		const app = honey<{}>().taps<AppTaps>()
		expectTypeOf<(typeof app)["$taps"]>().toEqualTypeOf<AppTaps>()
	})
})
