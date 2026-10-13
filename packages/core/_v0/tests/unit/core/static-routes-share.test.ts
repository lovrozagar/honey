import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"

type Statics = Record<string, { rp?: string } | undefined>

/** The static O(1) map finalize builds for the app graph every handle shares. */
function statics(app: object): Statics {
	return (app as { _finalize(): { statics: Statics } })._finalize().statics
}

describe("use() shares the static route map", () => {
	it("child registrations are on the parent's map", async () => {
		const app = honey()
		app.get("/a").handler((ctx) => ctx.res.text("ok", "a"))
		const child = app.use(async (_ctx, next) => next())
		child.get("/b").handler((ctx) => ctx.res.text("ok", "b"))

		expect(statics(app)).toBe(statics(child))
		expect(statics(app)["GET /b"]).toBeDefined()
		expect(statics(app)["GET /a"]).toBeDefined()

		const res = await app.fetch(new Request("http://x/b"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("b")
	})

	it("parent registrations after use() land on the child's map", () => {
		const app = honey()
		const child = app.use(async (_ctx, next) => next())
		child.get("/child").handler((ctx) => ctx.res.text("ok", "child"))
		app.get("/late").handler((ctx) => ctx.res.text("ok", "late"))
		expect(statics(child)["GET /late"]).toBeDefined()
	})

	it("route() of a separate app copies static keys onto the parent map", async () => {
		const sub = honey()
		sub.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const app = honey().route(sub)
		expect(statics(app)["GET /x"]).toBeDefined()
		const res = await app.fetch(new Request("http://x/x"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("x")
	})

	it("holds only patterns without params or wildcards", () => {
		const app = honey()
		app.get("/users/:id").handler((ctx) => ctx.res.text("ok", "u"))
		app.get("/files/*rest").handler((ctx) => ctx.res.text("ok", "f"))
		app.get("/opt/:id?").handler((ctx) => ctx.res.text("ok", "o"))
		expect(Object.keys(statics(app))).toEqual(["GET /opt"])
	})
})
