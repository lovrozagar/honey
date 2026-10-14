import { describe, expect, it } from "vitest"
import { honey } from "../../src/routing/app.ts"

describe("multiple Set-Cookie headers", () => {
	// v0: 3a72e25a94
	it("two cookies set in same response → both present", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: {
						a: { value: "1" },
						b: { httpOnly: true, value: "2" },
					},
				},
			),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const cookies = res.headers.getSetCookie()
		expect(cookies.length).toBe(2)
		expect(cookies.some((c) => c.startsWith("a="))).toBe(true)
		expect(cookies.some((c) => c.startsWith("b="))).toBe(true)
	})
})

describe("cookie round-trip", () => {
	// v0: b45c14884d
	it("set cookie → read cookie on next request (percent-encoded values)", async () => {
		const app = honey<{}>()
		app.get("/set").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: { token: { httpOnly: true, value: "hello world@123" } },
				},
			),
		)
		app.get("/read").handler((ctx) => ctx.res.json("ok", { token: ctx.cookies.token }))

		/* set the cookie */
		const setRes = await app.fetch(new Request("http://localhost/set"), {})
		const setCookie = setRes.headers.get("set-cookie") ?? ""
		expect(setCookie).toContain("token=")

		/* extract cookie value from Set-Cookie header */
		const cookieValue = setCookie.split(";")[0]

		/* read it back */
		const readRes = await app.fetch(
			new Request("http://localhost/read", {
				headers: { cookie: cookieValue },
			}),
			{},
		)
		const body = (await readRes.json()) as Record<string, unknown>
		expect(body.token).toBe("hello world@123")
	})
})
