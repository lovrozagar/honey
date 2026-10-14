/**
 * Code-review findings, frozen as regressions: a scope over a non-ASCII literal covers every
 * percent-escape spelling of it, in requests and in route literals.
 */
import { describe, expect, it } from "vitest"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

async function send(app: { fetch: (r: Request, env: never) => Response | Promise<Response> }, target: string) {
	const res = await app.fetch(new Request(`http://x${target}`), {} as never)
	return { body: await res.text(), status: res.status }
}

const denied = { body: "denied", status: 401 }
const deny = createMiddleware(() => new Response("denied", { status: 401 }))

describe("scopes over non-ASCII literals", () => {
	// regression: R1
	// v0: 52889f76ac
	it.each(["/%C3%A9", "/%c3%a9", "/%c3%A9"])(
		"R1: a scope over /é guards %s, whatever the escape case",
		async (target) => {
			const app = honey<{}>()
			app.use("/é", deny)
			app.get("/:slug").handler((ctx) => ctx.res.text("ok", ctx.params.slug))
			expect(await send(app, target)).toEqual(denied)
			expect(await send(app, "/other")).toEqual({ body: "other", status: 200 })
		},
	)

	// regression: R1
	// v0: b748dd1251
	it("R1: a route literal written with lowercase escapes is covered by the scope", async () => {
		const app = honey<{}>()
		app.use("/é", deny)
		app.get("/%c3%a9/x").handler((ctx) => ctx.res.text("ok", "x"))
		for (const target of ["/%C3%A9/x", "/%c3%a9/x"]) expect(await send(app, target)).toEqual(denied)
	})
})
