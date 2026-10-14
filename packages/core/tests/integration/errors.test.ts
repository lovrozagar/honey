import { describe, expect, it } from "vitest"
import { HoneyError } from "../../src/errors/error.ts"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { defineErrors } from "../../src/errors/errors.ts"

/**
 * Middleware that sets a custom header on every response (simulates secureHeaders/poweredBy).
 * Exercises the post-next() path that was previously skipped for error responses.
 */
const headerMw = (name: string, value: string) =>
	createMiddleware(async (_ctx, next) => {
		const res = await next()
		res.headers.set(name, value)
		return res
	})

describe("handler returning nothing", () => {
	// v0: 35d8feadcd
	it("handler returning null → 500", async () => {
		const app = honey<{}>()
		app.get("/oops").handler((() => null) as never)

		const res = await app.fetch(new Request("http://localhost/oops"), {})
		expect(res.status).toBe(500)
	})
})

describe("middleware returning nothing", () => {
	// v0: 7512c45a97
	it("middleware that calls next() but doesn't return it → 500", async () => {
		const badMw = createMiddleware((async (_ctx: Record<string, unknown>, next: (a?: {}) => Promise<Response>) => {
			await next()
			/* forgot to return */
		}) as never)

		const app = honey<{}>().use(badMw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("sync errors in handlers", () => {
	// v0: a361ade160
	it("sync throw in middleware before next() → 500", async () => {
		const mw = createMiddleware(async () => {
			throw new RangeError("out of range")
		})

		const app = honey<{}>().use(mw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("defaultErrors expands enforcement", () => {
	// v0: 57575ddf02
	it("defaultErrors key allowed even when route only declares other keys", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		const app = honey<{}>().errorFactory(errors).defaultErrors("auth_failed")

		app
			.get("/item")
			.errors("not_found")
			.handler(() => {
				/* auth_failed is a defaultError, not declared on this route */
				throw errors.auth_failed()
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		/* auth_failed should be allowed (it's in defaultErrors) → 401 */
		expect(res.status).toBe(401)
		const data = (await res.json()) as Record<string, string>
		expect(data.error_key).toBe("auth_failed")
	})
})

describe("HoneyError construction", () => {
	// v0: 1d261c36cc
	it("error with cause preserves chain", () => {
		const cause = new Error("original")
		const err = new HoneyError({
			cause,
			errorKey: "internal_server_error",
			status: "internal_server_error",
		})
		expect(err.cause).toBe(cause)
		expect(err.status).toBe(500)
	})
})

describe("defaultErrors propagation", () => {
	// v0: ce007f0a3e
	it("defaultErrors keys available on all routes", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
		})

		const app = honey<{}>().errorFactory(errors).defaultErrors("auth_failed")

		/* route only declares not_found, but auth_failed is a default */
		app
			.get("/item")
			.errors("not_found")
			.handler(() => {
				/* throw auth_failed — should be allowed because it's a default */
				throw errors.auth_failed()
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		/* auth_failed is in defaultErrors, so should be allowed (not wrapped) */
		expect(res.status).toBe(401)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("auth_failed")
	})
})

describe("ctx.errors factory subsetting", () => {
	// v0: 7241a672c9
	it("route with specific error keys → ctx.errors only has those keys", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		const app = honey<{}>().errorFactory(errors)
		app
			.get("/item")
			.errors("not_found")
			.handler((ctx) => {
				const keys = Object.keys(ctx.errors as Record<string, unknown>)
				return ctx.res.json("ok", { errorKeys: keys })
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string[]>
		/* only not_found should be in the subset (plus any defaultErrors) */
		expect(data.errorKeys).toContain("not_found")
		expect(data.errorKeys).not.toContain("rate_limited")
	})

	// v0: a88f6dff48
	it("route with no error keys → full factory available", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
		})

		const app = honey<{}>().errorFactory(errors)
		app.get("/item").handler((ctx) => {
			const keys = Object.keys(ctx.errors as Record<string, unknown>)
			return ctx.res.json("ok", { errorKeys: keys })
		})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string[]>
		expect(data.errorKeys).toContain("not_found")
		expect(data.errorKeys).toContain("auth_failed")
	})
})

describe("middleware error wrapping", () => {
	// v0: fb311f828e
	it("middleware detects error response and rewrites it", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			if (res.status >= 500) {
				return new Response(JSON.stringify({ error_key: "wrapped_error", status: 502 }), {
					headers: { "content-type": "application/json" },
					status: 502,
				})
			}
			return res
		})

		const app = honey<{}>().use(mw)
		app.get("/fail").handler(() => {
			throw new Error("original")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(502)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("wrapped_error")
	})
})

describe("defineMiddleware with error keys", () => {
	// v0: b2dda0df3a
	it("middleware error keys auto-accumulated by .use()", async () => {
		const { defineMiddleware } = await import("../../src/middleware/middleware.ts")
		const errors = defineErrors({
			auth_required: "unauthorized",
			rate_limited: "too_many_requests",
		})

		const authMw = defineMiddleware({
			errors: [errors, "auth_required"],
			fn: async (ctx, next) => {
				const req = (ctx as { req: Request }).req
				if (!req.headers.get("authorization")) {
					throw errors.auth_required()
				}
				return next()
			},
		})

		const app = honey<{}>().errorFactory(errors)
		app
			.get("/protected")
			.use(authMw)
			.handler((ctx) => ctx.res.json("ok", {}))

		/* without auth → 401 */
		const res1 = await app.fetch(new Request("http://localhost/protected"), {})
		expect(res1.status).toBe(401)
		const data1 = (await res1.json()) as Record<string, unknown>
		expect(data1.error_key).toBe("auth_required")

		/* with auth → 200 */
		const res2 = await app.fetch(
			new Request("http://localhost/protected", {
				headers: { authorization: "Bearer tok" },
			}),
			{},
		)
		expect(res2.status).toBe(200)
	})
})

describe("middleware: error skips subsequent middleware", () => {
	// v0: e96926060d
	it("first middleware throws → second middleware never runs", async () => {
		const order: string[] = []

		const mw1 = createMiddleware(async () => {
			order.push("mw1")
			throw new Error("early fail")
		})
		const mw2 = createMiddleware(async (_ctx, next) => {
			order.push("mw2")
			return next()
		})

		const app = honey<{}>()
		app
			.get("/test")
			.use(mw1)
			.use(mw2)
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.json("ok", {})
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
		expect(order).toEqual(["mw1"])
		expect(order).not.toContain("mw2")
		expect(order).not.toContain("handler")
	})
})

describe("error responses flow through middleware chain", () => {
	// v0: 2856f1a087
	it("middleware headers survive sync handler throw", async () => {
		const app = honey<Record<string, never>>().use(headerMw("x-powered-by", "honey"))
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "bad_request", status: "bad_request" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(400)
		expect(res.headers.get("x-powered-by")).toBe("honey")
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("bad_request")
	})

	// v0: 57cad9f54e
	it("middleware headers survive async handler throw", async () => {
		const app = honey<Record<string, never>>().use(headerMw("x-custom", "test"))
		app.get("/fail").handler(async () => {
			await Promise.resolve()
			throw new HoneyError({ errorKey: "not_found", status: "not_found" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(404)
		expect(res.headers.get("x-custom")).toBe("test")
	})

	// v0: 9dd1cacac5
	it("multiple middleware stacked — all post-next() headers present on error", async () => {
		const app = honey<Record<string, never>>().use(headerMw("x-one", "1")).use(headerMw("x-two", "2"))

		app.get("/fail").handler(() => {
			throw new Error("kaboom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(500)
		expect(res.headers.get("x-one")).toBe("1")
		expect(res.headers.get("x-two")).toBe("2")
	})
})

describe("error responses flow through middleware chain (2)", () => {
	// v0: 17bec54ba7
	it("route-level middleware also gets post-next() on error", async () => {
		const app = honey<Record<string, never>>()
		app
			.get("/fail")
			.use(headerMw("x-route", "yes"))
			.handler(() => {
				throw new HoneyError({ errorKey: "conflict", status: "conflict" })
			})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(409)
		expect(res.headers.get("x-route")).toBe("yes")
	})
})

describe("error response format unchanged", () => {
	// v0: 8a8c5fae41
	it("boundary error wrapping still works through middleware", async () => {
		const errors = defineErrors({
			auth_error: "internal_server_error",
			wrapped: "internal_server_error",
		})
		const app = honey<Record<string, never>>().errorFactory(errors).use(headerMw("x-test", "1"))

		app
			.get("/fail")
			.boundary("wrapped")
			.handler(() => {
				throw new Error("raw crash")
			})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(500)
		expect(res.headers.get("x-test")).toBe("1")
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("wrapped")
	})
})

describe("throws anywhere in the chain become one error response", () => {
	// v0: 481a492388
	it("middleware that reads error response body can rewrite it", async () => {
		const rewriteMw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			if (res.status >= 400) {
				const body = (await res.json()) as Record<string, unknown>
				return new Response(JSON.stringify({ ...body, extra: true }), {
					headers: { "content-type": "application/json" },
					status: res.status,
				})
			}
			return res
		})

		const app = honey<Record<string, never>>().use(rewriteMw)
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "not_found", status: "not_found" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(404)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("not_found")
		expect(body.extra).toBe(true)
	})

	// v0: 61507ec17c
	it("no middleware → error response works as before (regression)", async () => {
		const app = honey<Record<string, never>>()
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "conflict", status: "conflict" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(409)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("conflict")
	})

	// v0: 048cb7f945
	it("middleware itself throws after next() → still produces error response (safety net)", async () => {
		const brokenMw = createMiddleware(async (_ctx, next) => {
			await next()
			throw new Error("middleware post-processing crashed")
		})

		const app = honey<Record<string, never>>().use(brokenMw)
		app.get("/ok").handler((ctx) => ctx.res.json("ok", { success: true }))

		const res = await app.fetch(new Request("http://localhost/ok"), {} as Record<string, never>)
		expect(res.status).toBe(500)
	})
})

describe("throws anywhere in the chain become one error response (2)", () => {
	// v0: 02c8c70858
	it("middleware throws before next() → still produces error response", async () => {
		const brokenMw = createMiddleware(async () => {
			throw new Error("middleware crashed before next")
		})

		const app = honey<Record<string, never>>().use(brokenMw)
		app.get("/ok").handler((ctx) => ctx.res.json("ok", { success: true }))

		const res = await app.fetch(new Request("http://localhost/ok"), {} as Record<string, never>)
		expect(res.status).toBe(500)
	})

	// v0: 1596ac0783
	it("async handler rejection flows through middleware", async () => {
		const app = honey<Record<string, never>>().use(headerMw("x-async", "yes"))
		app.get("/fail").handler(async () => {
			return Promise.reject(new HoneyError({ errorKey: "bad_request", status: "bad_request" }))
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(400)
		expect(res.headers.get("x-async")).toBe("yes")
	})

	// v0: a226a39432
	it("successful responses still work with middleware", async () => {
		const app = honey<Record<string, never>>().use(headerMw("x-test", "works"))
		app.get("/ok").handler((ctx) => ctx.res.json("ok", { data: 1 }))

		const res = await app.fetch(new Request("http://localhost/ok"), {} as Record<string, never>)
		expect(res.status).toBe(200)
		expect(res.headers.get("x-test")).toBe("works")
		const body = (await res.json()) as Record<string, unknown>
		expect(body.data).toBe(1)
	})
})
