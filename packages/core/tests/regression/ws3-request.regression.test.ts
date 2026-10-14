import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import { describe, expect, it } from "vitest"

type Fetchable = { fetch(r: Request, e?: object): Response | Promise<Response> }

async function send(app: Fetchable, url: string, init: RequestInit = {}): Promise<Response | "threw"> {
	try {
		return await app.fetch(new Request(url, init), {})
	} catch {
		return "threw"
	}
}

describe("WS3 regressions", () => {
	// regression: M ctx.path raw
	// v0: 991c53b9f5
	it("M-ctx-path: ctx.path is the normalized path the router matched", async () => {
		const app = honey()
		const seen: string[] = []
		const guard = createMiddleware(async (c: { path: string }, next) => {
			seen.push(c.path)
			return c.path.startsWith("/admin") ? new Response("no", { status: 401 }) : next()
		})
		app
			.use(guard)
			.get("/admin/secret")
			.handler((c) => c.res.json("ok", { secret: true }))
		const res = await send(app, "http://x//admin/secret")
		expect(res).not.toBe("threw")
		expect((res as Response).status).toBe(401)
		expect(seen).toEqual(["/admin/secret"])
	})
})
