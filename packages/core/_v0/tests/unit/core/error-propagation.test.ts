import { describe, expect, it } from "vitest"
import { HoneyError } from "../../../src/error.ts"
import { defineErrors } from "../../../src/errors.ts"
import { createMiddleware, honey } from "../../../src/index.ts"
import "@lovrozagar/honey/i18n"

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

describe("error responses flow through middleware chain", () => {
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

	it("custom onError response flows through middleware (gets headers)", async () => {
		const app = honey<Record<string, never>>()
			.use(headerMw("x-powered-by", "honey"))
			.onError((_err, ctx) => ctx.jsonFromError(new HoneyError({ errorKey: "custom_error", status: "bad_request" })))
		app.get("/fail").handler(() => {
			throw new Error("oops")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(400)
		expect(res.headers.get("x-powered-by")).toBe("honey")
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("custom_error")
	})

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

describe("logger/timing middleware see error responses", () => {
	it("logger middleware receives error status code", async () => {
		const logged: { status: number }[] = []
		const loggerMw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			logged.push({ status: res.status })
			return res
		})

		const app = honey<Record<string, never>>().use(loggerMw)
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "not_found", status: "not_found" })
		})

		await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(logged).toHaveLength(1)
		expect(logged[0].status).toBe(404)
	})

	it("timing middleware measures duration for error responses", async () => {
		let duration = -1
		const timingMw = createMiddleware(async (_ctx, next) => {
			const start = performance.now()
			const res = await next()
			duration = performance.now() - start
			return res
		})

		const app = honey<Record<string, never>>().use(timingMw)
		app.get("/slow-fail").handler(async () => {
			await new Promise((r) => setTimeout(r, 10))
			throw new Error("slow failure")
		})

		await app.fetch(new Request("http://localhost/slow-fail"), {} as Record<string, never>)
		expect(duration).toBeGreaterThan(0)
	})
})

describe("error response format unchanged", () => {
	it("HoneyError → same JSON shape, same status code", async () => {
		const app = honey<Record<string, never>>().use(headerMw("x-test", "1"))
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(403)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("forbidden")
		expect(body.status).toBe(403)
	})

	it("non-HoneyError → 500 internal_server_error", async () => {
		const app = honey<Record<string, never>>().use(headerMw("x-test", "1"))
		app.get("/fail").handler(() => {
			throw new TypeError("null reference")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("internal_server_error")
	})

	it("string throw → 500 internal_server_error", async () => {
		const app = honey<Record<string, never>>().use(headerMw("x-test", "1"))
		app.get("/fail").handler(() => {
			throw "oops"
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("internal_server_error")
	})

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

	it("i18n translation still applies on error responses through middleware", async () => {
		const app = honey<Record<string, never>>()
			.use(headerMw("x-test", "1"))
			.errorI18n({
				errors: { en: { bad_request: "Bad request happened" } },
				resolveLocale: () => "en",
			})

		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "bad_request", status: "bad_request" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(400)
		expect(res.headers.get("x-test")).toBe("1")
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("bad_request")
		expect(body.message).toBe("Bad request happened")
	})
})

describe("edge cases", () => {
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

	it("middleware throws before next() → still produces error response", async () => {
		const brokenMw = createMiddleware(async () => {
			throw new Error("middleware crashed before next")
		})

		const app = honey<Record<string, never>>().use(brokenMw)
		app.get("/ok").handler((ctx) => ctx.res.json("ok", { success: true }))

		const res = await app.fetch(new Request("http://localhost/ok"), {} as Record<string, never>)
		expect(res.status).toBe(500)
	})

	it("async handler rejection flows through middleware", async () => {
		const app = honey<Record<string, never>>().use(headerMw("x-async", "yes"))
		app.get("/fail").handler(async () => {
			return Promise.reject(new HoneyError({ errorKey: "bad_request", status: "bad_request" }))
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {} as Record<string, never>)
		expect(res.status).toBe(400)
		expect(res.headers.get("x-async")).toBe("yes")
	})

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
