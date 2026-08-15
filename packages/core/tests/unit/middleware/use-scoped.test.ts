import { describe, expect, it, vi } from "vitest"
import { createMiddleware, defineErrors, defineMiddleware, honey } from "../../../src/index.ts"
import type { WSAdapter, WSHandler } from "../../../src/ws/cloudflare.ts"
import { WSContextImpl } from "../../../src/ws/cloudflare.ts"

/* ──── test helpers ──── */

const adminMw = createMiddleware(async (_c, next) => next({ adminOnly: "yes" }))

function makeSpy() {
	const calls: number[] = []
	const mw = createMiddleware(async (_ctx, next) => {
		calls.push(Date.now())
		return next()
	})
	return { calls, mw }
}

/**
 * Node.js Response constructor rejects status 101; CF Workers extends Response.
 * For tests, synthesize a 101 response the same way ws.test.ts does.
 */
function make101Response(): Response {
	const response = new Response(null, { status: 200 })
	Object.defineProperty(response, "status", { value: 101 })
	return response
}

function createTestWsAdapter(): WSAdapter {
	const mockRaw = {
		close: vi.fn<() => void>(),
		readyState: 1,
		send: vi.fn<() => void>(),
	}
	return {
		upgrade(_req, _env, handler: WSHandler<unknown>) {
			const socket = new WSContextImpl(mockRaw)
			handler.onOpen?.(undefined, socket)
			return { response: make101Response(), socket }
		},
	}
}

/* ──── runtime tests — 1–30 ──── */

describe("scoped middleware — runtime tests", () => {
	it("1. matching route runs scoped middleware", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.use("/admin", spy)
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "done"))

		const res = await app.fetch(new Request("http://localhost/admin/x"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("done")
		expect(calls.length).toBe(1)
	})

	it("2. non-matching route does not run scoped middleware", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.use("/admin", spy)
			.get("/public")
			.handler((ctx) => ctx.res.text("ok", "public"))

		const res = await app.fetch(new Request("http://localhost/public"), {})
		expect(res.status).toBe(200)
		expect(calls.length).toBe(0)
	})

	it("3. scope matches the exact prefix path itself", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.use("/admin", spy)
			.get("/admin")
			.handler((ctx) => ctx.res.text("ok", "admin"))

		const res = await app.fetch(new Request("http://localhost/admin"), {})
		expect(res.status).toBe(200)
		expect(calls.length).toBe(1)
	})

	it("4. scope with boundary — /admin does NOT match /administration", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.use("/admin", spy)
			.get("/admin")
			.handler((ctx) => ctx.res.text("ok", "admin"))
			.get("/administration")
			.handler((ctx) => ctx.res.text("ok", "admin2"))

		const res = await app.fetch(
			new Request("http://localhost/administration"),
			{}
		)
		expect(res.status).toBe(200)
		expect(calls.length).toBe(0)
	})

	it("5. scope / matches every route", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.use("/", spy)
			.get("/x")
			.handler((ctx) => ctx.res.text("ok", "x"))
			.get("/y/z")
			.handler((ctx) => ctx.res.text("ok", "yz"))

		await app.fetch(new Request("http://localhost/x"), {})
		expect(calls.length).toBe(1)
		await app.fetch(new Request("http://localhost/y/z"), {})
		expect(calls.length).toBe(2)
	})

	it("6. multiple overlapping scopes compose in declaration order", async () => {
		const order: string[] = []
		const a = createMiddleware(async (_c, next) => {
			order.push("a")
			return next()
		})
		const b = createMiddleware(async (_c, next) => {
			order.push("b")
			return next()
		})
		const app = honey<{}>()
			.use("/admin", a)
			.use("/admin/billing", b)
			.get("/admin/billing/invoices")
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.text("ok", "inv")
			})

		await app.fetch(new Request("http://localhost/admin/billing/invoices"), {})
		expect(order).toEqual(["a", "b", "handler"])
	})

	it("7. scoped middleware additions appear on ctx for matching route", async () => {
		const app = honey<{}>()
			.use("/admin", adminMw)
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", ctx.adminOnly))

		const res = await app.fetch(new Request("http://localhost/admin/x"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("yes")
	})

	it("8. scoped errors land on matching route's errorKeys", async () => {
		const errors = defineErrors({
			forbidden: "forbidden",
			internal_server_error: "internal_server_error",
		})
		const errorMw = defineMiddleware({
			errors: [errors, "forbidden"],
			fn: async (_c, next) => next(),
		})

		const app = honey<{}>()
			.errorFactory(errors)
			.defaultBoundary("internal_server_error")
			.use("/admin", errorMw)
			.get("/admin/x")
			.handler((_ctx) => {
				throw errors.forbidden()
			})
			.get("/public")
			.handler((_ctx) => {
				throw errors.forbidden()
			})

		const adminRes = await app.fetch(
			new Request("http://localhost/admin/x"),
			{}
		)
		expect(adminRes.status).toBe(403)

		const publicRes = await app.fetch(
			new Request("http://localhost/public"),
			{}
		)
		expect(publicRes.status).toBe(500)
	})

	it("9. scoped middleware not invoked on 404", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.use("/admin", spy)
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))

		const res = await app.fetch(
			new Request("http://localhost/admin/missing"),
			{}
		)
		expect(res.status).toBe(404)
		expect(calls.length).toBe(0)
	})

	it("10. scoped middleware not invoked on 405", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.use("/admin", spy)
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))

		const res = await app.fetch(
			new Request("http://localhost/admin/x", { method: "POST" }),
			{}
		)
		expect(res.status).toBe(405)
		expect(calls.length).toBe(0)
	})

	it("11. .route(sub) — parent scoped mw applies to sub's routes at runtime", async () => {
		const { mw: parentSpy, calls: parentCalls } = makeSpy()
		const sub = honey<{}>()
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))

		const app = honey<{}>()
			.use("/admin", parentSpy)
			.route(sub)

		await app.fetch(new Request("http://localhost/admin/x"), {})
		expect(parentCalls.length).toBe(1)
	})

	it("12. .route(sub) — sub's own scoped mw preserved after merge", async () => {
		const { mw: subSpy, calls: subCalls } = makeSpy()
		const sub = honey<{}>()
			.use("/admin", subSpy)
			.get("/admin/y")
			.handler((ctx) => ctx.res.text("ok", "y"))

		const app = honey<{}>().route(sub)

		await app.fetch(new Request("http://localhost/admin/y"), {})
		expect(subCalls.length).toBe(1)
	})

	it("13. .route(sub) — both parent and sub scoped mw run on sub route", async () => {
		const order: string[] = []
		const parentMw = createMiddleware(async (_c, next) => {
			order.push("parent")
			return next()
		})
		const subMw = createMiddleware(async (_c, next) => {
			order.push("sub")
			return next()
		})

		const sub = honey<{}>()
			.use("/admin", subMw)
			.get("/admin/y")
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.text("ok", "y")
			})

		const app = honey<{}>()
			.use("/admin", parentMw)
			.route(sub)

		await app.fetch(new Request("http://localhost/admin/y"), {})
		expect(order).toEqual(["parent", "sub", "handler"])
	})

	it("14. .route(sub) — parent's scoped mw does NOT touch parent routes outside scope", async () => {
		const { mw: parentSpy, calls: parentCalls } = makeSpy()
		const sub = honey<{}>()
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))

		const app = honey<{}>()
			.use("/admin", parentSpy)
			.route(sub)
			.get("/public")
			.handler((ctx) => ctx.res.text("ok", "public"))

		await app.fetch(new Request("http://localhost/public"), {})
		expect(parentCalls.length).toBe(0)
	})

	it("15. .use(path, mw) added AFTER .route(sub) still applies to merged routes", async () => {
		const { mw: lateSpy, calls: lateCalls } = makeSpy()
		const sub = honey<{}>()
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))

		const app = honey<{}>()
			.route(sub)
			.use("/admin", lateSpy)

		await app.fetch(new Request("http://localhost/admin/x"), {})
		expect(lateCalls.length).toBe(1)
	})

	it("16. ws route — scoped mw runs when prefix matches", async () => {
		const { mw: spy, calls } = makeSpy()
		let wsOpened = false

		const app = honey<{}>()
			.wsAdapter(createTestWsAdapter())
			.use("/rooms", spy)
			.ws("/rooms/:id")
			.handler({
				onOpen: (_c, _ws) => {
					wsOpened = true
				},
			})

		const res = await app.fetch(
			new Request("http://localhost/rooms/abc", {
				headers: { upgrade: "websocket" },
			}),
			{}
		)
		expect(res.status).toBe(101)
		expect(calls.length).toBe(1)
		expect(wsOpened).toBe(true)
	})

	it("17. ws route — scoped mw skipped when prefix does not match", async () => {
		const { mw: spy, calls } = makeSpy()
		let wsOpened = false

		const app = honey<{}>()
			.wsAdapter(createTestWsAdapter())
			.use("/rooms", spy)
			.ws("/other")
			.handler({
				onOpen: (_c, _ws) => {
					wsOpened = true
				},
			})

		const res = await app.fetch(
			new Request("http://localhost/other", {
				headers: { upgrade: "websocket" },
			}),
			{}
		)
		expect(res.status).toBe(101)
		expect(calls.length).toBe(0)
		expect(wsOpened).toBe(true)
	})

	it("18. trailing slash on scope is normalized", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.use("/admin/", spy)
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))

		await app.fetch(new Request("http://localhost/admin/x"), {})
		expect(calls.length).toBe(1)
	})

	it("19. trailing slash on route path is matched", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.use("/admin", spy)
			.get("/admin/")
			.handler((ctx) => ctx.res.text("ok", "admin"))

		await app.fetch(new Request("http://localhost/admin/"), {})
		expect(calls.length).toBe(1)
	})

	it("20. basePath interaction — scope path is relative to the chain, internally stored as merged", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.basePath("/api")
			.use("/admin", spy)
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))
			.get("/public")
			.handler((ctx) => ctx.res.text("ok", "public"))

		await app.fetch(new Request("http://localhost/api/admin/x"), {})
		expect(calls.length).toBe(1)

		await app.fetch(new Request("http://localhost/api/public"), {})
		expect(calls.length).toBe(1)
	})

	it("21. scoped mw receives next()'s previous chain additions", async () => {
		let sawDb = false
		const dbMw = createMiddleware(async (_c, next) => next({ db: "connected" }))
		const useDbMw = createMiddleware(
			async (c: { db: string }, next) => {
				sawDb = c.db === "connected"
				return next()
			}
		)

		const app = honey<{}>()
			.use(dbMw)
			.use("/admin", useDbMw)
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))

		await app.fetch(new Request("http://localhost/admin/x"), {})
		expect(sawDb).toBe(true)
	})

	it("22. scoped mw short-circuit (returns Response without next()) stops handler for matching route", async () => {
		const blockMw = createMiddleware(async (_c, _next) => {
			return new Response("blocked", { status: 403 })
		})
		const app = honey<{}>()
			.use("/admin", blockMw)
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "should not run"))

		const res = await app.fetch(new Request("http://localhost/admin/x"), {})
		expect(res.status).toBe(403)
		expect(await res.text()).toBe("blocked")
	})

	it("23. scoped mw short-circuit does NOT affect non-matching route", async () => {
		const blockMw = createMiddleware(async (_c, _next) => {
			return new Response("blocked", { status: 403 })
		})
		const app = honey<{}>()
			.use("/admin", blockMw)
			.get("/public")
			.handler((ctx) => ctx.res.text("ok", "public"))

		const res = await app.fetch(new Request("http://localhost/public"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("public")
	})

	it("24. stripPrefix runs before scope matching", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
			.stripPrefix("/app")
			.use("/admin", spy)
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))

		await app.fetch(new Request("http://localhost/app/admin/x"), {})
		expect(calls.length).toBe(1)
	})

	it("25. order: unscoped .use() after .use(path, mw) — unscoped still runs globally", async () => {
		const order: string[] = []
		const a = createMiddleware(async (_c, next) => {
			order.push("a")
			return next()
		})
		const b = createMiddleware(async (_c, next) => {
			order.push("b")
			return next()
		})

		const app = honey<{}>()
			.use("/admin", a)
			.use(b)
			.get("/public")
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.text("ok", "public")
			})

		await app.fetch(new Request("http://localhost/public"), {})
		expect(order).toEqual(["b", "handler"])
	})

	it("26. .use(path, mw) multiple times with same prefix all compose", async () => {
		const order: string[] = []
		const a = createMiddleware(async (_c, next) => {
			order.push("a")
			return next()
		})
		const b = createMiddleware(async (_c, next) => {
			order.push("b")
			return next()
		})

		const app = honey<{}>()
			.use("/x", a)
			.use("/x", b)
			.get("/x/y")
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.text("ok", "xy")
			})

		await app.fetch(new Request("http://localhost/x/y"), {})
		expect(order).toEqual(["a", "b", "handler"])
	})

	it("27. empty _scopedMiddlewares keeps fast path intact", async () => {
		const app = honey<{}>().get("/test").handler((ctx) => ctx.res.text("ok", "test"))

		const res1 = await app.fetch(new Request("http://localhost/test"), {})
		const res2 = await app.fetch(new Request("http://localhost/test"), {})

		expect(res1.status).toBe(200)
		expect(res2.status).toBe(200)
		expect(await res1.text()).toBe("test")
		expect(await res2.text()).toBe("test")
	})

	it("28. .basePath() preserves _scopedMiddlewares across clone, prefixes unchanged", async () => {
		const { mw: spy1, calls: calls1 } = makeSpy()
		const { mw: spy2, calls: calls2 } = makeSpy()

		const a = honey<{}>().use("/admin", spy1)
		const b = a.basePath("/api").get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))

		await b.fetch(new Request("http://localhost/api/admin/x"), {})
		expect(calls1.length).toBe(0)

		const c = honey<{}>().basePath("/api").use("/admin", spy2)
		const d = c.get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))

		await d.fetch(new Request("http://localhost/api/admin/x"), {})
		expect(calls2.length).toBe(1)
	})

	it("29. .context() preserves _scopedMiddlewares", async () => {
		const { mw: spy, calls } = makeSpy()
		const a = honey<{}>().use("/admin", spy)
		const b = a.context({ foo: 1 }).get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))

		await b.fetch(new Request("http://localhost/admin/x"), {})
		expect(calls.length).toBe(1)
	})

	it("30. .meta() (chain-level) preserves _scopedMiddlewares", async () => {
		const { mw: spy, calls } = makeSpy()
		const a = honey<{}>().use("/admin", spy)
		const b = a.meta({ x: 1 }).get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))

		await b.fetch(new Request("http://localhost/admin/x"), {})
		expect(calls.length).toBe(1)
	})
})
