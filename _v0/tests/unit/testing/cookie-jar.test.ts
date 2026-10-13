import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { testClient } from "../../../src/testing.ts"

function makeApp() {
	const app = honey<{}>()

	app.get("/set-cookie").handler((ctx) => {
		return ctx.res.json("ok", undefined, {
			cookies: {
				session: { httpOnly: true, value: "abc123" },
			},
		})
	})

	app.get("/read-cookie").handler((ctx) => {
		const cookie = ctx.req.headers.get("cookie") ?? "none"
		return ctx.res.text("ok", cookie)
	})

	app.get("/set-multi").handler((ctx) => {
		return ctx.res.json("ok", undefined, {
			cookies: {
				lang: { value: "en" },
				theme: { value: "dark" },
			},
		})
	})

	return app
}

describe("testClient cookie jar", () => {
	it("accumulates Set-Cookie from responses and sends on next request", async () => {
		const app = makeApp()
		const client = testClient(app, { cookies: true, env: {} })

		await client.get("/set-cookie")
		const res = await client.get("/read-cookie")
		const body = await res.text()

		expect(body).toContain("session=abc123")
	})

	it("accumulates multiple cookies across requests", async () => {
		const app = makeApp()
		const client = testClient(app, { cookies: true, env: {} })

		await client.get("/set-cookie")
		await client.get("/set-multi")

		const res = await client.get("/read-cookie")
		const body = await res.text()

		expect(body).toContain("session=abc123")
		expect(body).toContain("theme=dark")
		expect(body).toContain("lang=en")
	})

	it("does not send cookies when cookies option is off", async () => {
		const app = makeApp()
		const client = testClient(app, { env: {} })

		await client.get("/set-cookie")
		const res = await client.get("/read-cookie")
		const body = await res.text()

		expect(body).toBe("none")
	})
})
