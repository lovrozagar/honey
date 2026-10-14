import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { poweredBy } from "./powered-by.ts"

function app(name?: string) {
	const a = honey<{}>()
	const routes = a.use(poweredBy(name === undefined ? undefined : { name }))
	routes.get("/t").handler((ctx) => ctx.res.text("ok", "x"))
	routes.post("/t").handler((ctx) => ctx.res.text("ok", "x"))
	routes.get("/own").handler((ctx) => ctx.res.text("ok", "x", { headers: { "x-powered-by": "Their stack" } }))
	routes.get("/custom").handler((ctx) => ctx.res.text("ok", "x", { headers: { "x-custom": "mine" } }))
	return a
}

const poweredOf = async (a: ReturnType<typeof app>, path: string, method = "GET") =>
	(await a.fetch(new Request(`https://app.example.com${path}`, { method }), {})).headers.get("x-powered-by")

describe("poweredBy()", () => {
	// v0: 933b060013
	// v0: 682b9dc522
	// v0: 23cbf963e2
	it("X-Powered-By: Honey by default, or the name given, on every method", async () => {
		expect([
			await poweredOf(app(), "/t"),
			await poweredOf(app(), "/t", "POST"),
			await poweredOf(app("MyFramework"), "/t"),
		]).toEqual(["Honey", "Honey", "MyFramework"])
	})

	// v0: 8d379a4571
	it("the handler's other headers come through beside it", async () => {
		const res = await app().fetch(new Request("https://app.example.com/custom"), {})
		expect([res.headers.get("x-custom"), res.headers.get("x-powered-by")]).toEqual(["mine", "Honey"])
	})

	it("a value the handler set itself is kept", async () => {
		expect(await poweredOf(app(), "/own")).toBe("Their stack")
	})
})
