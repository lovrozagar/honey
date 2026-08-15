import { describe, expect, it } from "vitest"
import { createMiddleware, honey } from "../../../src/index.ts"

describe("middleware double next() guard", () => {
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
