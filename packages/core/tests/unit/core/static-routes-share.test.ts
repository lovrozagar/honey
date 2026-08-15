import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

type StaticHolder = { map: Record<string, { rp: string } | undefined> | null }

function holder(app: object): StaticHolder {
	return (app as { _staticRoutes: StaticHolder })._staticRoutes
}

describe("use() shares the static route map", () => {
	it("child registrations are on the parent's map", async () => {
		const app = honey()
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		const child = app.use(async (_ctx, next) => next())
		child.get("/b").handler((ctx) => ctx.res.text("ok", "b"))

		expect(holder(app)).toBe(holder(child))
		expect(holder(app).map?.["GET /b"]).toBeDefined()
		expect(holder(app).map?.["GET /a"]).toBeDefined()

		const res = await app.fetch(new Request("http://x/b"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("b")
	})

	it("parent registrations after use() land on the child's map", () => {
		const app = honey()
		const child = app.use(async (_ctx, next) => next())
		app.get("/late").handler((ctx) => ctx.res.text("ok", "late"))
		expect(holder(child).map?.["GET /late"]).toBeDefined()
	})

	it("route() of a separate app copies static keys onto the parent map", async () => {
		const sub = honey()
		sub.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const app = honey().route(sub)
		expect(holder(app).map?.["GET /x"]).toBeDefined()
		const res = await app.fetch(new Request("http://x/x"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("x")
	})
})
