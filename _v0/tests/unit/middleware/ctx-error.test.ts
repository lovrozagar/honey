import * as z from "zod"
import { describe, expect, it } from "vitest"
import { createMiddleware, honey, HoneyError } from "../../../src/index.ts"

type Seen = { cause: unknown; errorKey: string | undefined; status: number }

function appWithMetrics() {
	const seen: Seen[] = []
	const metrics = createMiddleware(async (c, next) => {
		const res = await next()
		seen.push({ cause: c.error?.cause, errorKey: c.error?.errorKey, status: res.status })
		return res
	})
	return { app: honey().use(metrics), seen }
}

const call = (app: { fetch: (r: Request) => Response | Promise<Response> }, path: string) =>
	app.fetch(new Request(`http://h${path}`))

describe("ctx.error after next()", () => {
	it("holds the HoneyError an inner middleware threw", async () => {
		const { app, seen } = appWithMetrics()
		app
			.use(
				createMiddleware(async () => {
					throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
				}),
			)
			.get("/denied")
			.handler((c) => c.res.json("ok", {}))
		expect((await call(app, "/denied")).status).toBe(403)
		expect(seen).toEqual([{ cause: undefined, errorKey: "forbidden", status: 403 }])
	})

	it("holds a validation error", async () => {
		const { app, seen } = appWithMetrics()
		app
			.get("/v")
			.input({ search: z.object({ n: z.coerce.number() }) })
			.handler((c) => c.res.json("ok", {}))
		await call(app, "/v?n=x")
		expect(seen[0]).toMatchObject({ errorKey: "validation_failed", status: 400 })
	})

	it("holds the 500 a handler throw became, with the original as cause", async () => {
		const { app, seen } = appWithMetrics()
		const boom = new Error("db down")
		app.get("/boom").handler(() => {
			throw boom
		})
		expect((await call(app, "/boom")).status).toBe(500)
		expect(seen).toEqual([{ cause: boom, errorKey: "internal_server_error", status: 500 }])
	})

	it("is undefined when nothing failed", async () => {
		const { app, seen } = appWithMetrics()
		app.get("/fine").handler((c) => c.res.json("ok", {}))
		await call(app, "/fine")
		expect(seen).toEqual([{ cause: undefined, errorKey: undefined, status: 200 }])
	})

	it("is a reserved context key", () => {
		expect(() => honey().context({ error: 1 } as never)).toThrow()
	})
})
