import { describe, expect, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
function makeSpy() {
	const calls: number[] = []
	const mw = createMiddleware(async (_ctx, next) => {
		calls.push(Date.now())
		return next()
	})
	return { calls, mw }
}

describe("scoped middleware — runtime tests (11)", () => {
	// v0: 7a37077351
	it("28. .basePath() preserves _scopedMiddlewares across clone, prefixes unchanged", async () => {
		const { mw: spy1, calls: calls1 } = makeSpy()
		const { mw: spy2, calls: calls2 } = makeSpy()

		const a = honey<{}>().use("/admin", spy1)
		const b = a
			.basePath("/api")
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))

		await b.fetch(new Request("http://localhost/api/admin/x"), {})
		expect(calls1.length).toBe(0)

		const c = honey<{}>().basePath("/api").use("/admin", spy2)
		const d = c.get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))

		await d.fetch(new Request("http://localhost/api/admin/x"), {})
		expect(calls2.length).toBe(1)
	})

	// v0: eac6e1e6e9
	it("29. .context() preserves _scopedMiddlewares", async () => {
		const { mw: spy, calls } = makeSpy()
		const a = honey<{}>().use("/admin", spy)
		const b = a
			.context({ foo: 1 })
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))

		await b.fetch(new Request("http://localhost/admin/x"), {})
		expect(calls.length).toBe(1)
	})
})

describe("scoped middleware — parent fetch after child use(path)", () => {
	// v0: 3169940e2c
	it("parent fetch runs scoped mw registered on the child (e2e return-h pattern)", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
		const admin = app.use("/admin", spy)
		admin.get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))

		const res = await app.fetch(new Request("http://localhost/admin/x"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("x")
		expect(calls.length).toBe(1)
	})

	// v0: 45fd793813
	it("parent fetch still skips scoped mw on paths outside the prefix", async () => {
		const { mw: spy, calls } = makeSpy()
		const app = honey<{}>()
		const admin = app.use("/admin", spy)
		admin.get("/admin/x").handler((ctx) => ctx.res.text("ok", "x"))
		app.get("/public").handler((ctx) => ctx.res.text("ok", "public"))

		await app.fetch(new Request("http://localhost/public"), {})
		expect(calls.length).toBe(0)
	})
})
