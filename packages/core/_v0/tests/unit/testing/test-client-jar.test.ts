import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { testClient } from "../../../src/testing.ts"

function cookieApp() {
	const app = honey<{}>()
	app.get("/login").handler(() => {
		const res = new Response("in")
		res.headers.append("set-cookie", "sid=abc; Path=/")
		res.headers.append("set-cookie", "theme=dark; Path=/")
		return res
	})
	app.get("/logout").handler(() => {
		const res = new Response("out")
		res.headers.append("set-cookie", "sid=; Max-Age=0; Path=/")
		res.headers.append("set-cookie", "theme=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/")
		return res
	})
	app.get("/stale-max-age").handler(() => {
		const res = new Response("x")
		/* Max-Age wins over a future Expires */
		res.headers.append("set-cookie", "sid=gone; Max-Age=-1; Expires=Fri, 01 Jan 2100 00:00:00 GMT")
		return res
	})
	app.get("/echo").handler((ctx) => ctx.res.text("ok", ctx.req.headers.get("cookie") ?? ""))
	return app
}

describe("testClient cookie jar", () => {
	it("drops cookies a response expires with Max-Age=0 or a past Expires", async () => {
		const client = testClient(cookieApp(), { cookies: true, env: {} })
		await client.get("/login")
		expect(await (await client.get("/echo")).text()).toBe("sid=abc; theme=dark")
		await client.get("/logout")
		expect(await (await client.get("/echo")).text()).toBe("")
	})

	it("lets Max-Age win over Expires", async () => {
		const client = testClient(cookieApp(), { cookies: true, env: {} })
		await client.get("/login")
		await client.get("/stale-max-age")
		expect(await (await client.get("/echo")).text()).toBe("theme=dark")
	})
})

describe('testClient transport: "node"', () => {
	it("sends real HTTP through the Node adapter, cookies included", async () => {
		const app = cookieApp()
		app.post("/body").handler(async (ctx) =>
			ctx.res.json("ok", {
				body: await ctx.req.json(),
				/* honey's Node Request view, not a Fetch Request */
				fetchRequest: ctx.req instanceof Request,
			}),
		)
		const client = testClient(app, { cookies: true, env: {}, transport: "node" })
		try {
			await client.get("/login")
			expect(await (await client.get("/echo")).text()).toBe("sid=abc; theme=dark")
			const res = await client.post("/body", { json: { n: 1 } })
			expect(await res.json()).toEqual({ body: { n: 1 }, fetchRequest: false })
		} finally {
			await client.close()
		}
	})
})
