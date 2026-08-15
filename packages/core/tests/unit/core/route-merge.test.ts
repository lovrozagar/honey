import { describe, expect, it } from "vitest"
import { createMiddleware, honey } from "../../../src/index.ts"

describe(".route() merges sub-router tree into parent", () => {
	it("sub-router routes accessible on parent after .route()", async () => {
		const sub = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "from-sub"))

		const app = honey<{}>()
			.get("/main")
			.handler((ctx) => ctx.res.text("ok", "from-main"))
			.route(sub)

		const mainRes = await app.fetch(new Request("http://localhost/main"), {})
		expect(mainRes.status).toBe(200)
		expect(await mainRes.text()).toBe("from-main")

		const subRes = await app.fetch(new Request("http://localhost/health"), {})
		expect(subRes.status).toBe(200)
		expect(await subRes.text()).toBe("from-sub")
	})

	it("multiple .route() calls merge all sub-routers", async () => {
		const auth = honey<{}>()
			.get("/login")
			.handler((ctx) => ctx.res.text("ok", "login"))

		const users = honey<{}>()
			.get("/users")
			.handler((ctx) => ctx.res.text("ok", "users"))

		const app = honey<{}>()
			.get("/")
			.handler((ctx) => ctx.res.text("ok", "root"))
			.route(auth)
			.route(users)

		expect((await app.fetch(new Request("http://localhost/"), {})).status).toBe(200)
		expect(await (await app.fetch(new Request("http://localhost/login"), {})).text()).toBe("login")
		expect(await (await app.fetch(new Request("http://localhost/users"), {})).text()).toBe("users")
	})

	it("sub-router with params merges correctly", async () => {
		const sub = honey<{}>()
			.get("/orgs/:orgId")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.orgId }))

		const app = honey<{}>().route(sub)

		const res = await app.fetch(new Request("http://localhost/orgs/o-1"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBe("o-1")
	})

	it("duplicate route across parent and sub → throws on merge", async () => {
		const sub = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "sub"))

		const app = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "parent"))

		expect(() => app.route(sub)).toThrow(/conflict|duplicate/i)
	})

	it("sub-router middleware runs for sub routes", async () => {
		let mwCalled = false
		const mw = createMiddleware(async (_ctx, next) => {
			mwCalled = true
			return next()
		})

		const sub = honey<{}>()
			.use(mw)
			.get("/guarded")
			.handler((ctx) => ctx.res.text("ok", "guarded"))

		const app = honey<{}>()
			.get("/public")
			.handler((ctx) => ctx.res.text("ok", "public"))
			.route(sub)

		/* public route — middleware should NOT run */
		mwCalled = false
		await app.fetch(new Request("http://localhost/public"), {})
		expect(mwCalled).toBe(false)

		/* guarded route — middleware should run (stored on handler.mw) */
		mwCalled = false
		await app.fetch(new Request("http://localhost/guarded"), {})
		expect(mwCalled).toBe(true)
	})
})
