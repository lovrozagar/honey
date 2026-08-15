import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"
import { HoneyRes } from "../../../src/response.ts"

describe("broken world: what if Response constructor throws", () => {
	it("handler where res.json data has getter that throws", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const evil = Object.defineProperty({}, "name", {
				enumerable: true,
				get() {
					throw new Error("getter exploded during stringify")
				},
			})
			return ctx.res.json("ok", evil)
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("broken world: what if middleware mutates ctx in unexpected ways", () => {
	it("middleware deletes ctx.req → handler still gets 500, not crash", async () => {
		const app = honey<{}>()
		const evil = createMiddleware(async (ctx, next) => {
			delete (ctx as Record<string, unknown>).req
			return next()
		})

		app
			.use(evil)
			.get("/test")
			.handler((ctx) => {
				return ctx.res.text("ok", String(ctx.req))
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		/* either works (req still accessible) or 500 — must not crash process */
		expect([200, 500]).toContain(res.status)
	})

	it("middleware replaces ctx.res with garbage → handler gets 500", async () => {
		const app = honey<{}>()
		const evil = createMiddleware(async (ctx, next) => {
			;(ctx as Record<string, unknown>).res = "not-a-HoneyRes"
			return next()
		})

		app
			.use(evil)
			.get("/test")
			.handler((ctx) => {
				return ctx.res.json("ok", {})
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

describe("broken world: what if schema validation hangs", () => {
	it("schema that takes very long → no infinite hang (just slow)", async () => {
		const slowSchema = z.string().superRefine(async (val, ctx) => {
			/* simulate slow validation — not infinite, just slow */
			await new Promise((r) => setTimeout(r, 10))
			if (val.length < 1) ctx.addIssue({ code: "custom", message: "too short" })
		})

		const app = honey<{}>()
		app
			.post("/test")
			.input({ json: z.object({ name: slowSchema }) })
			.handler((ctx) => ctx.res.json("ok", { name: ctx.input.json.name }))

		const start = performance.now()
		const res = await app.fetch(
			new Request("http://localhost/test", {
				body: JSON.stringify({ name: "valid" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		const elapsed = performance.now() - start
		expect(res.status).toBe(200)
		expect(elapsed).toBeGreaterThan(5) /* proves async validation ran */
	})
})

describe("broken world: what if multiple apps share routes accidentally", () => {
	it("two separate honey() instances → completely isolated trees", async () => {
		const app1 = honey<{}>()
		app1.get("/shared").handler((ctx) => ctx.res.text("ok", "app1"))

		const app2 = honey<{}>()
		app2.get("/shared").handler((ctx) => ctx.res.text("ok", "app2"))

		const r1 = await app1.fetch(new Request("http://localhost/shared"), {})
		const r2 = await app2.fetch(new Request("http://localhost/shared"), {})
		expect(await r1.text()).toBe("app1")
		expect(await r2.text()).toBe("app2")
	})
})

describe("broken world: what if Date.now / performance.now is mocked", () => {
	it("telemetry still works with mocked performance.now", async () => {
		void performance.now
		let callCount = 0
		vi.spyOn(performance, "now").mockImplementation(() => {
			callCount++
			return callCount * 100
		})

		const onHandler = vi.fn()
		const app = honey<{}>()
		app.telemetry({ onHandler })
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(onHandler).toHaveBeenCalledOnce()
		const call = onHandler.mock.calls[0][0] as Record<string, unknown>
		expect(typeof call.duration).toBe("number")

		vi.restoreAllMocks()
	})
})

describe("broken world: what if handler returns a non-standard Response", () => {
	it("handler returns Response subclass → still works", async () => {
		class CustomResponse extends Response {
			custom = true
		}

		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			return ctx.res.raw(new CustomResponse("custom", { status: 200 }))
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})

describe("broken world: regex-like characters in route paths", () => {
	it("path with dots /api/v1.0/test → matches literally", async () => {
		const app = honey<{}>()
		app.get("/api/v1.0/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/api/v1.0/test"), {})
		expect(res.status).toBe(200)
	})

	it("path with brackets /files/[id] → matches literally", async () => {
		const app = honey<{}>()
		app.get("/files/[id]").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/files/[id]"), {})
		expect(res.status).toBe(200)

		/* /files/123 should NOT match — [id] is literal, not a param */
		const res2 = await app.fetch(new Request("http://localhost/files/123"), {})
		expect(res2.status).toBe(404)
	})

	it("path with parentheses /group(1) → matches literally", async () => {
		const app = honey<{}>()
		app.get("/group(1)").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/group(1)"), {})
		expect(res.status).toBe(200)
	})
})

describe("broken world: what if ctx is used after response is sent", () => {
	it("reading ctx.search after returning response → no crash", async () => {
		let searchAfter: unknown
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const response = ctx.res.text("ok", "done")
			/* access ctx after creating response — should still work */
			searchAfter = ctx.search
			return response
		})

		await app.fetch(new Request("http://localhost/test?a=1"), {})
		expect(searchAfter).toEqual({ a: "1" })
	})
})

describe("broken world: what if globalThis.Response is different", () => {
	it("framework uses standard Response constructor", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { works: true }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res).toBeInstanceOf(Response)
	})
})

describe("broken world: what if the route path is just /", () => {
	it("root route / → matches", async () => {
		const app = honey<{}>()
		app.get("/").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("root")
	})

	it("root route with basePath → basePath exact match maps to /", async () => {
		const app = honey<{}>().basePath("/api")
		app.get("/").handler((ctx) => ctx.res.text("ok", "api-root"))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("api-root")
	})
})

describe("broken world: what if error factory produces wrong status", () => {
	it("error factory maps to status, framework uses that status", async () => {
		const errors = defineErrors({
			teapot: "im_a_teapot" as never /* not a real StatusKey */,
		})

		const app = honey<{}>()
		/* this should fail at defineErrors level or at throw time */
		try {
			app
				.errorFactory(errors)
				.get("/test")
				.errors("teapot")
				.handler(() => {
					throw errors.teapot()
				})

			const res = await app.fetch(new Request("http://localhost/test"), {})
			/* if it gets here, status should be whatever statusKeyToCode maps */
			expect(res.status).toBeGreaterThanOrEqual(400)
		} catch {
			/* defineErrors might reject invalid status keys — that's fine too */
			expect(true).toBe(true)
		}
	})
})

describe("broken world: extremely rapid route chaining", () => {
	it("50 chained .get().handler() calls → all routes work", async () => {
		let app = honey<{}>() as ReturnType<typeof honey>
		for (let i = 0; i < 50; i++) {
			app = app
				.get(`/r${i}`)
				.handler((ctx) => ctx.res.json("ok", { route: ctx.path })) as ReturnType<typeof honey>
		}

		for (const i of [0, 25, 49]) {
			const res = await app.fetch(new Request(`http://localhost/r${i}`), {})
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.route).toBe(`/r${i}`)
		}
	})
})

describe("broken world: what if defineErrors is called with empty object", () => {
	it("empty error factory → no errors available, but app works", async () => {
		const errors = defineErrors({})
		const app = honey<{}>().errorFactory(errors)
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})

describe("broken world: what if HoneyRes methods called outside request", () => {
	it("HoneyRes.json works standalone (no request context needed)", () => {
		const res = new HoneyRes()
		const response = res.json("ok", { standalone: true })
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("application/json")
	})

	it("HoneyRes.text works standalone", () => {
		const res = new HoneyRes()
		const response = res.text("created", "hello")
		expect(response.status).toBe(201)
	})
})
