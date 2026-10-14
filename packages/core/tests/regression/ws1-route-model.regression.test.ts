/**
 * WS1 (route model) findings, frozen as regressions: mounted routes are copies with their own
 * scopes, and scopes cover routes and basePaths however their strings are spelled.
 */
import { describe, expect, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

type Fetchable = { fetch: (r: Request, env: never) => Response | Promise<Response> }

async function send(app: Fetchable, target: string) {
	const res = await app.fetch(new Request(`http://x${target}`), {} as never)
	return { body: await res.text(), status: res.status }
}

const denied = { body: "denied", status: 401 }
const deny = createMiddleware(() => new Response("denied", { status: 401 }))

describe("the route model under mounts and scopes", () => {
	/* M gateway fallthrough with a root /:slug: guarded through the real generation path in
	 * gw-own-routes.regression.test.ts (the gateway tree must include the gateway's own routes) */

	// regression: M mergeInto shares nodes
	// v0: 727a04589c
	it("M-mergeInto: two parents mounting one sub do not share routes or bypass scoped middleware", async () => {
		const sub = honey<{}>()
		sub.get("/api/users").handler((ctx) => ctx.res.text("ok", "sub"))
		const p1 = honey<{}>()
		p1.use("/api/admin", deny)
		p1.route(sub)
		const p2 = honey<{}>()
		p2.route(sub)
		p1.get("/api/admin").handler((ctx) => ctx.res.text("ok", "p1"))
		expect(await send(p1, "/api/admin")).toEqual(denied)
		expect((await send(p2, "/api/admin")).status).toBe(404)
		for (const app of [p1, p2]) expect(await send(app, "/api/users")).toEqual({ body: "sub", status: 200 })
	})

	// regression: M route/basePath normalization vs scopes
	// v0: d950b79ac5
	it("M-normalize: non-normalized route and basePath strings are still covered by their scope", async () => {
		const root = honey<{}>()
		root.use("/api/admin", deny)
		root
			.basePath("/api/")
			.get("/admin/x")
			.handler((ctx) => ctx.res.text("ok", "x"))
		root.get("//admin/b").handler((ctx) => ctx.res.text("ok", "b"))
		root.use("/admin", deny)
		expect(await send(root, "/api/admin/x")).toEqual(denied)
		expect(await send(root, "/admin/b")).toEqual(denied)
	})
})
