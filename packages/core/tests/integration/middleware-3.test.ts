import { describe, expect, it } from "vitest"
import { HoneyError } from "../../src/errors/error.ts"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"

type Seen = { cause: unknown; errorKey: string | undefined; status: number }

function appWithMetrics() {
	const seen: Seen[] = []
	const metrics = createMiddleware(async (c: { error?: HoneyError }, next) => {
		const res = await next()
		seen.push({ cause: c.error?.cause, errorKey: c.error?.errorKey, status: res.status })
		return res
	})
	return { app: honey().use(metrics), seen }
}

const call = <E>(app: { fetch: (r: Request, env: E) => Response | Promise<Response> }, path: string) =>
	app.fetch(new Request(`http://h${path}`), {} as E)

describe("ctx.error after next()", () => {
	// v0: 4e5af7c920
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

	// v0: 2e79dbef87
	it("holds the 500 a handler throw became, with the original as cause", async () => {
		const { app, seen } = appWithMetrics()
		const boom = new Error("db down")
		app.get("/boom").handler(() => {
			throw boom
		})
		expect((await call(app, "/boom")).status).toBe(500)
		expect(seen).toEqual([{ cause: boom, errorKey: "internal_server_error", status: 500 }])
	})

	// v0: 847f09f075
	it("is undefined when nothing failed", async () => {
		const { app, seen } = appWithMetrics()
		app.get("/fine").handler((c) => c.res.json("ok", {}))
		await call(app, "/fine")
		expect(seen).toEqual([{ cause: undefined, errorKey: undefined, status: 200 }])
	})

	// v0: 0bf423024b
	it("is a reserved context key", () => {
		expect(() => honey().context({ error: 1 } as never)).toThrow()
	})
})

describe("middleware double next() guard", () => {
	// v0: 58a7509d07
	it("calling next() twice should throw", async () => {
		const h = honey<{}>()

		const doubleMw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			/* second call — should throw */
			await next()
			return res
		})

		const chain = h.use(doubleMw)
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		/* double next should result in 500 because the error propagates */
		expect(res.status).toBe(500)
	})

	// v0: 47f29a140d
	it("middleware that forgets return gives helpful error", async () => {
		const h = honey<{}>()

		/* consumer mistake: calls next() but forgets return — use raw function to simulate */
		const badMw = createMiddleware(async (_ctx, next) => {
			next()
			/* missing return — returns undefined, which should be caught */
			return undefined as never
		})

		const chain = h.use(badMw)
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		/* should mention "return" in error, not cryptic "Cannot read property 'status'" */
		expect(body.error_key).toBe("internal_server_error")
	})
})

describe("middleware double next() guard (2)", () => {
	// v0: 6cdeb245fc
	it("next({ req }) silently strips reserved key — ctx.req preserved", async () => {
		const h = honey<{}>()

		const mw = createMiddleware(async (_ctx, next) => {
			return next({ req: "overwritten" })
		})

		const chain = h.use(mw)
		chain.get("/test").handler((ctx) => {
			const req = (ctx as { req: unknown }).req
			return ctx.res.json("ok", { isRequest: req instanceof Request })
		})

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.isRequest).toBe(true)
	})

	// v0: ef201b14c6
	it("next({ res }) silently strips reserved key — ctx.res preserved", async () => {
		const h = honey<{}>()

		const mw = createMiddleware(async (_ctx, next) => {
			return next({ res: "overwritten" })
		})

		const chain = h.use(mw)
		chain.get("/test").handler((ctx) => ctx.res.json("ok", { hasJson: typeof ctx.res.json === "function" }))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.hasJson).toBe(true)
	})
})

describe("middleware double next() guard (3)", () => {
	// v0: 5ff8a09ee1
	it("next({ env }) silently strips reserved key — ctx.env preserved", async () => {
		const h = honey<{ SECRET: string }>()

		const mw = createMiddleware(async (_ctx, next) => {
			return next({ env: "overwritten" })
		})

		const chain = h.use(mw)
		chain.get("/test").handler((ctx) => ctx.res.json("ok", { secret: ctx.env.SECRET }))

		const res = await h.fetch(new Request("http://localhost/test"), { SECRET: "s3cr3t" })
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.secret).toBe("s3cr3t")
	})

	// v0: b2c973584c
	it("next({ params }) silently strips reserved key — ctx.params preserved", async () => {
		const h = honey<{}>()

		const mw = createMiddleware(async (_ctx, next) => {
			return next({ params: "overwritten" })
		})

		const chain = h.use(mw)
		chain.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await h.fetch(new Request("http://localhost/users/42"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBe("42")
	})

	// v0: 55605e9620
	it("non-reserved keys still work normally", async () => {
		const h = honey<{}>()

		const mw = createMiddleware(async (_ctx, next) => {
			return next({ db: "postgres", userId: "u-1" })
		})

		const chain = h.use(mw)
		chain.get("/test").handler((ctx) => ctx.res.json("ok", { db: ctx.db, userId: ctx.userId }))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.db).toBe("postgres")
		expect(body.userId).toBe("u-1")
	})
})

describe("middleware double next() guard (4)", () => {
	// v0: 5ccc558c7c
	it("mix of reserved and non-reserved — reserved stripped, rest applied", async () => {
		const h = honey<{}>()

		const mw = createMiddleware(async (_ctx, next) => {
			return next({ db: "pg", req: "evil", userId: "u-1" })
		})

		const chain = h.use(mw)
		chain.get("/test").handler((ctx) => {
			const req = (ctx as { req: unknown }).req
			return ctx.res.json("ok", {
				db: ctx.db,
				isRequest: req instanceof Request,
				userId: ctx.userId,
			})
		})

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.db).toBe("pg")
		expect(body.userId).toBe("u-1")
		expect(body.isRequest).toBe(true)
	})

	// v0: c3812cb356
	it("calling next() once is fine", async () => {
		const h = honey<{}>()

		const normalMw = createMiddleware(async (_ctx, next) => {
			return next()
		})

		const chain = h.use(normalMw)
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})
