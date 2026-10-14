/**
 * WS3 (request) findings, frozen as regressions: middleware sees the normalized path the router
 * matched.
 */
import { describe, expect, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

describe("the request path middleware sees", () => {
	// regression: M ctx.path raw
	// v0: 991c53b9f5
	it("M-ctx-path: ctx.path is the normalized path the router matched", async () => {
		const seen: string[] = []
		const guard = createMiddleware((ctx: { path: string }, next) => {
			seen.push(ctx.path)
			return ctx.path.startsWith("/admin") ? new Response("no", { status: 401 }) : next()
		})
		const app = honey<{}>()
		app
			.use(guard)
			.get("/admin/secret")
			.handler((ctx) => ctx.res.json("ok", { secret: true }))
		const res = await app.fetch(new Request("http://x//admin/secret"), {})
		expect([res.status, await res.text()]).toEqual([401, "no"])
		expect(seen).toEqual(["/admin/secret"])
	})
})
