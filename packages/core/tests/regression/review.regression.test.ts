import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import { describe, expect, it } from "vitest"

const deny = createMiddleware(async () => new Response("denied", { status: 401 }))

describe("code review regressions", () => {
	// regression: R1
	// v0: 52889f76ac
	it("R1: a scope over a non-ASCII literal guards lowercase percent-escapes too", async () => {
		const app = honey()
		app.use("/é", deny)
		app.get("/:slug").handler((c) => c.res.json("ok", { slug: c.params.slug }))
		for (const path of ["/%C3%A9", "/%c3%a9", "/%c3%A9"]) {
			expect((await app.fetch(new Request(`http://x${path}`), {})).status, path).toBe(401)
		}
		expect((await app.fetch(new Request("http://x/other"), {})).status).toBe(200)
	})

	// regression: R1
	// v0: b748dd1251
	it("R1: a route literal written with lowercase escapes is covered by the scope", async () => {
		const app = honey()
		app.use("/é", deny)
		app.get("/%c3%a9/x").handler((c) => c.res.json("ok", {}))
		expect((await app.fetch(new Request("http://x/%C3%A9/x"), {})).status).toBe(401)
		expect((await app.fetch(new Request("http://x/%c3%a9/x"), {})).status).toBe(401)
	})
})
