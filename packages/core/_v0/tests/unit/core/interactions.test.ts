import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"
import "@lovrozagar/honey/i18n"

describe("feature interactions", () => {
	describe("input validation + output validation + error handling", () => {
		it("invalid input → 400, output validation never runs", async () => {
			const app = honey<{}>()
			app.outputValidation("always")
			app
				.post("/test")
				.input({ json: z.object({ name: z.string() }) })
				.output({ "application/json": { ok: z.object({ id: z.string() }) } })
				.handler((ctx) => ctx.res.json("ok", { id: "1" }))

			const res = await app.fetch(
				new Request("http://localhost/test", {
					body: JSON.stringify({ name: 123 }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
				{},
			)
			expect(res.status).toBe(400)
		})

		it("valid input + invalid output → 500 (output validation catches)", async () => {
			const app = honey<{}>()
			app.outputValidation("always")
			app
				.post("/test")
				.input({ json: z.object({ name: z.string() }) })
				.output({ "application/json": { ok: z.object({ id: z.string() }) } })
				.handler((ctx) =>
					ctx.res.raw(
						new Response(JSON.stringify({ wrong: true }), {
							headers: { "content-type": "application/json" },
							status: 200,
						}),
					),
				)

			const res = await app.fetch(
				new Request("http://localhost/test", {
					body: JSON.stringify({ name: "valid" }),
					headers: { "content-type": "application/json" },
					method: "POST",
				}),
				{},
			)
			expect(res.status).toBe(500)
		})
	})

	describe("middleware + errors + i18n", () => {
		it("middleware error → translated via i18n", async () => {
			const errors = defineErrors({ forbidden: "forbidden" })
			const app = honey<{}>()
				.errorFactory(errors)
				.errorI18n({
					errors: {
						en: { forbidden: "Access denied for {resource}" },
					},
					resolveLocale: () => "en",
				})

			const guard = createMiddleware(async () => {
				throw errors.forbidden({ vars: { resource: "admin panel" } })
			})

			app
				.use(guard)
				.get("/admin")
				.errors("forbidden")
				.handler((ctx) => ctx.res.text("ok", "admin"))

			const res = await app.fetch(new Request("http://localhost/admin"), {})
			expect(res.status).toBe(403)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.message).toBe("Access denied for admin panel")
		})
	})

	describe("basePath + cors + HEAD", () => {
		it("HEAD to basePath-prefixed route with CORS → 200, empty body, CORS headers", async () => {
			const { cors } = await import("../../../src/cors.ts")
			const app = honey<{}>().basePath("/api")
			app
				.use(cors({ origin: "*" }))
				.get("/health")
				.handler((ctx) => ctx.res.json("ok", { status: "up" }))

			const res = await app.fetch(
				new Request("http://localhost/api/health", {
					headers: { origin: "http://example.com" },
					method: "HEAD",
				}),
				{},
			)
			expect(res.status).toBe(200)
			expect(await res.text()).toBe("")
			expect(res.headers.get("access-control-allow-origin")).toBe("*")
		})
	})

	describe("route merge + middleware propagation", () => {
		it("parent chain middleware DOES run on merged sub-router routes", async () => {
			let parentMwCalled = false
			const parentMw = createMiddleware(async (_ctx, next) => {
				parentMwCalled = true
				return next()
			})

			const sub = honey<{}>()
				.get("/sub")
				.handler((ctx) => ctx.res.text("ok", "from-sub"))

			const app = honey<{}>()
				.use(parentMw)
				.get("/parent")
				.handler((ctx) => ctx.res.text("ok", "from-parent"))
				.route(sub)

			/* sub route — parent chain middleware runs (auth applies to all routes) */
			parentMwCalled = false
			const subRes = await app.fetch(new Request("http://localhost/sub"), {})
			expect(subRes.status).toBe(200)
			expect(parentMwCalled).toBe(true)

			/* parent route — parent chain middleware also runs */
			parentMwCalled = false
			await app.fetch(new Request("http://localhost/parent"), {})
			expect(parentMwCalled).toBe(true)
		})
	})

	describe("telemetry + error + output validation", () => {
		it("telemetry receives error event when output validation fails", async () => {
			const onError = vi.fn()
			const app = honey<{}>()
			app.outputValidation("always")
			app.telemetry({ onError })
			app
				.get("/test")
				.output({ "application/json": { ok: z.object({ id: z.string() }) } })
				.handler((ctx) =>
					ctx.res.raw(
						new Response(JSON.stringify({ wrong: true }), {
							headers: { "content-type": "application/json" },
							status: 200,
						}),
					),
				)

			await app.fetch(new Request("http://localhost/test"), {})
			expect(onError).toHaveBeenCalledOnce()
		})
	})

	describe("path + routePattern + params together", () => {
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

	describe("executionCtx + background + telemetry", () => {
		it("background fires waitUntil AND telemetry receives response", async () => {
			const waitUntil = vi.fn()
			const onResponse = vi.fn()
			const app = honey<{}>()
			app.telemetry({ onResponse })
			app.get("/test").handler((ctx) => {
				ctx.background(Promise.resolve("bg-work"))
				return ctx.res.text("ok", "done")
			})

			await app.fetch(new Request("http://localhost/test"), {}, { waitUntil })
			expect(waitUntil).toHaveBeenCalledOnce()
			expect(onResponse).toHaveBeenCalledOnce()
		})
	})

	describe("multi-value search + input validation", () => {
		it("ctx.search has arrays, input validation coerces correctly", async () => {
			const app = honey<{}>()
			app
				.get("/test")
				.input({ search: z.object({ tags: z.string().array() }) })
				.handler((ctx) => ctx.res.json("ok", { tags: ctx.input.search.tags }))

			const res = await app.fetch(new Request("http://localhost/test?tags=a&tags=b&tags=c"), {})
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.tags).toEqual(["a", "b", "c"])
		})
	})

	describe("error factory + onError + custom formatter all interact", () => {
		it("thrown error → onError sees it → formatter shapes response", async () => {
			const errors = defineErrors({ not_found: "not_found" })
			const onErrorSpy = vi.fn(() => undefined)

			const app = honey<{}>()
				.errorFactory(errors)
				.onError(onErrorSpy)
				.defaultErrorFormatter((_error, shape) => ({ ...shape, custom: true }))
				.get("/test")
				.errors("not_found")
				.handler(() => {
					throw errors.not_found()
				})

			const res = await app.fetch(new Request("http://localhost/test"), {})
			expect(onErrorSpy).toHaveBeenCalledOnce()
			expect(res.status).toBe(404)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.custom).toBe(true)
			expect(body.error_key).toBe("not_found")
		})
	})
})
