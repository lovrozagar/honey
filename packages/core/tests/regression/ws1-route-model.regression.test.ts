import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import { describe, expect, it } from "vitest"

type Fetchable = { fetch(r: Request, e?: object): Response | Promise<Response> }

/** status, or "threw" when the app refuses to serve (a loud failure counts as guarded) */
async function status(app: Fetchable, path: string, method = "GET"): Promise<number | "threw"> {
	try {
		return (await app.fetch(new Request(`http://x${path}`, { method }), {})).status
	} catch {
		return "threw"
	}
}

const deny = createMiddleware(async () => new Response("denied", { status: 401 }))

describe("WS1 regressions", () => {
	/* M gateway fallthrough with a root /:slug: guarded through the real generation path in
	 * gw-own-routes.regression.test.ts (the gateway tree must include the gateway's own routes) */

	// regression: M mergeInto shares nodes
	// v0: 727a04589c
	it("M-mergeInto: two parents mounting one sub do not share routes or bypass scoped middleware", async () => {
		const sub = honey()
		sub.get("/api/users").handler((c) => c.res.json("ok", { from: "sub" }))
		const p1 = honey()
		p1.use("/api/admin", deny)
		p1.route(sub)
		const p2 = honey()
		p2.route(sub)
		p1.get("/api/admin").handler((c) => c.res.json("ok", { from: "p1" }))
		expect(await status(p1, "/api/admin")).toBe(401)
		expect(await status(p2, "/api/admin")).toBe(404)
	})

	// regression: M route/basePath normalization vs scopes
	// v0: d950b79ac5
	it("M-normalize: non-normalized route and basePath strings are still covered by their scope", async () => {
		const root = honey()
		root.use("/api/admin", deny)
		const api = root.basePath("/api/")
		api.get("/admin/x").handler((c) => c.res.json("ok", {}))
		root.get("//admin/b").handler((c) => c.res.json("ok", {}))
		root.use("/admin", deny)
		expect(await status(root, "/api/admin/x")).toBe(401)
		expect(await status(root, "/admin/b")).toBe(401)
	})
})
