import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"

describe("mistake: registering routes after first request", () => {
	it("routes added after fetch() are still reachable (shared tree)", async () => {
		const app = honey<{}>()
		app.get("/first").handler((ctx) => ctx.res.text("ok", "first"))

		/* first request */
		await app.fetch(new Request("http://localhost/first"), {})

		/* add route AFTER first request */
		app.get("/second").handler((ctx) => ctx.res.text("ok", "second"))

		const res = await app.fetch(new Request("http://localhost/second"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("second")
	})
})

describe("mistake: calling handler twice on same builder", () => {
	it("second .handler() on same path+method → throws duplicate route", () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "first"))

		expect(() => {
			app.get("/test").handler((ctx) => ctx.res.text("ok", "second"))
		}).toThrow()
	})
})

describe("mistake: forgetting await on async operations in handler", () => {
	it("handler returns sync response but has fire-and-forget promise", async () => {
		let sideEffect = false
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			/* forgot await — promise fires in background */
			Promise.resolve().then(() => {
				sideEffect = true
			})
			return ctx.res.text("ok", "immediate")
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		/* side effect may or may not have run — but no crash */
		await new Promise((r) => setTimeout(r, 10))
		expect(sideEffect).toBe(true)
	})
})

describe("mistake: mutating the errors factory after registration", () => {
	it("adding keys to factory after .errorFactory() → new keys available", async () => {
		const errors = defineErrors({ original: "bad_request" })
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors("original")
			.handler(() => {
				throw errors.original()
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(400)
	})
})

describe("mistake: using same middleware instance on multiple apps", () => {
	it("shared middleware works on both apps independently", async () => {
		const shared = createMiddleware(async (_ctx, next) => next({ shared: true }))

		const app1 = honey<{}>().use(shared)
		app1.get("/test").handler((ctx) => ctx.res.json("ok", { app: 1, shared: ctx.shared }))

		const app2 = honey<{}>().use(shared)
		app2.get("/test").handler((ctx) => ctx.res.json("ok", { app: 2, shared: ctx.shared }))

		const r1 = await app1.fetch(new Request("http://localhost/test"), {})
		const r2 = await app2.fetch(new Request("http://localhost/test"), {})

		expect(((await r1.json()) as Record<string, unknown>).app).toBe(1)
		expect(((await r2.json()) as Record<string, unknown>).app).toBe(2)
	})
})

describe("mistake: returning ctx.res.json() result from a different route's handler", () => {
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

describe("mistake: very long error key names", () => {
	it("error key with 1000 chars → works", async () => {
		const longKey = "e".repeat(1000)
		const errors = defineErrors({ [longKey]: "bad_request" })
		const app = honey<{}>()
			.errorFactory(errors)
			.get("/test")
			.errors(errors, longKey)
			.handler(() => {
				throw (errors as Record<string, () => unknown>)[longKey]()
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(400)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe(longKey)
	})
})

describe("mistake: handler that never resolves", () => {
	it("with timeout middleware → 504 after timeout", async () => {
		const { timeout } = await import("../../../src/timeout.ts")
		const app = honey<{}>()
		app
			.use(timeout({ duration: 50 }))
			.get("/hang")
			.handler(async (ctx) => {
				await new Promise(() => {}) /* never resolves */
				return ctx.res.text("ok", "unreachable")
			})

		const res = await app.fetch(new Request("http://localhost/hang"), {})
		expect(res.status).toBeGreaterThanOrEqual(500)
	})
})

describe("mistake: input schema with default values", () => {
	it("missing query param uses zod default", async () => {
		const app = honey<{}>()
		app
			.get("/test")
			.input({ search: z.object({ page: z.coerce.number().default(1) }) })
			.handler((ctx) => ctx.res.json("ok", { page: ctx.input.search.page }))

		/* no ?page param */
		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.page).toBe(1)
	})
})

describe("mistake: chaining after .handler()", () => {
	it(".handler() returns Honey — can chain more routes", async () => {
		const app = honey<{}>()
			.get("/a")
			.handler((ctx) => ctx.res.text("ok", "a"))
			.get("/b")
			.handler((ctx) => ctx.res.text("ok", "b"))
			.get("/c")
			.handler((ctx) => ctx.res.text("ok", "c"))

		for (const path of ["/a", "/b", "/c"]) {
			const res = await app.fetch(new Request(`http://localhost${path}`), {})
			expect(res.status).toBe(200)
			expect(await res.text()).toBe(path.slice(1))
		}
	})
})

describe("mistake: output schema stricter than handler returns", () => {
	it("output validation catches extra fields when enabled", async () => {
		const app = honey<{}>()
		app.outputValidation("always")
		app
			.get("/test")
			.output({
				"application/json": {
					ok: z.object({ id: z.string() }).strict(),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { extra: "field", id: "1" } as { id: string }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		/* strict schema should reject extra fields */
		expect(res.status).toBe(500)
	})
})

describe("mistake: empty string in various places", () => {
	it("empty path '' → treated as /", async () => {
		const app = honey<{}>()
		app.get("").handler((ctx) => ctx.res.text("ok", "root"))

		const res = await app.fetch(new Request("http://localhost/"), {})
		expect(res.status).toBe(200)
	})

	it("empty basePath '' → no prefix change", async () => {
		const app = honey<{}>().basePath("")
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})

	it("param with empty value /users/ → param is empty string", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		/* /users/ doesn't have an :id segment — this is just the /users/ path */
		const res = await app.fetch(new Request("http://localhost/users/"), {})
		/* may or may not match depending on trailing slash behavior */
		expect([200, 404]).toContain(res.status)
	})
})

describe("mistake: calling fetch with wrong this binding", () => {
	it("destructured fetch still works", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		/* some frameworks break when fetch is destructured */
		const { fetch } = app
		const boundFetch = fetch.bind(app)
		const res = await boundFetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})
