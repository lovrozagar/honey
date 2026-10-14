/**
 * What the app adds around the request on ctx: route meta (also on internal routes), and
 * background work handed to the execution context.
 */
import { describe, expect, it } from "vitest"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

type Fetchable = { fetch: (r: Request, env: never, executionCtx?: never) => Response | Promise<Response> }
type SendOptions = { env?: object; executionCtx?: object; init?: RequestInit }

async function send(app: Fetchable, target: string, { env = {}, executionCtx, init }: SendOptions = {}) {
	const res = await app.fetch(new Request(`http://localhost${target}`, init), env as never, executionCtx as never)
	return { body: (await res.json()) as unknown, status: res.status }
}

const ok = (body: unknown) => ({ body, status: 200 })

type AppMeta = { auth?: "public" | "required"; rateLimit?: "default" | "strict" }

describe("ctx.meta", () => {
	// v0: 208fab9eae
	// v0: 388012fbac
	// v0: 9dfc3446fd
	it("is the route's meta, frozen, also on a route with an error factory, middleware and declared errors", async () => {
		const app = honey<{}>()
			.meta<AppMeta>()
			.errorFactory(defineErrors({ not_allowed: "forbidden" }))
			.use(createMiddleware((_ctx, next) => next({ userId: "u-1" })))
		app
			.get("/orgs")
			.meta({ auth: "required", rateLimit: "strict" })
			.errors("not_allowed")
			.handler((ctx) => ctx.res.json("ok", { frozen: Object.isFrozen(ctx.meta), meta: ctx.meta, userId: ctx.userId }))
		app.get("/plain").handler((ctx) => ctx.res.json("ok", { frozen: Object.isFrozen(ctx.meta), meta: ctx.meta }))
		expect(await send(app, "/orgs")).toEqual(
			ok({ frozen: true, meta: { auth: "required", rateLimit: "strict" }, userId: "u-1" }),
		)
		expect(await send(app, "/plain")).toEqual(ok({ frozen: true, meta: {} }))
	})

	// v0: fbf7ced595
	// v0: 99359e229d
	// v0: c90a72efd3
	// v0: 5ab1605dec
	it("an internal route, marked on itself or on its chain, still answers and sees internal: true", async () => {
		const app = honey<{}>().meta<AppMeta>()
		app
			.get("/api/users")
			.meta({ auth: "public" })
			.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))
		app
			.get("/health")
			.meta({ internal: true })
			.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))
		const internal = app.meta({ internal: true })
		internal.get("/metrics").handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))
		internal
			.get("/debug")
			.meta({ auth: "required" })
			.handler((ctx) => ctx.res.json("ok", { meta: ctx.meta }))
		expect(await send(app, "/api/users")).toEqual(ok({ meta: { auth: "public" } }))
		expect(await send(app, "/health")).toEqual(ok({ meta: { internal: true } }))
		expect(await send(app, "/metrics")).toEqual(ok({ meta: { internal: true } }))
		expect(await send(app, "/debug")).toEqual(ok({ meta: { auth: "required", internal: true } }))
	})
})

/** An execution context whose waitUntil, like workerd's, throws unless called on its owner. */
function strictExecutionCtx() {
	const handed: Promise<unknown>[] = []
	const executionCtx = {
		waitUntil(this: unknown, promise: Promise<unknown>): void {
			if (this !== executionCtx) throw new TypeError("Illegal invocation")
			handed.push(promise)
		},
	}
	return { executionCtx, handed }
}

describe("ctx.background and ctx.executionCtx", () => {
	// v0: dd41ef2833
	// v0: d41b1bcb2d
	// v0: f5a5019dfa
	// v0: 85830ec8d5
	// v0: c6954e7a8d
	// v0: def1f2bf1b
	it.each([
		["a handler that answers", "/ok", 200],
		["a handler that throws", "/boom", 500],
		["chain middleware on an unknown path", "/nope", 404],
	])("work started by %s goes to waitUntil, called on its owner", async (_label, target, status) => {
		const app = honey<{}>().use(
			createMiddleware((ctx, next) => {
				ctx.background(Promise.resolve(`mw ${target}`))
				return next()
			}),
		)
		app.get("/ok").handler((ctx) => ctx.res.json("ok", {}))
		app.get("/boom").handler(() => {
			throw new Error("boom")
		})
		const { executionCtx, handed } = strictExecutionCtx()
		expect((await send(app, target, { executionCtx })).status).toBe(status)
		expect(await Promise.all(handed)).toEqual([`mw ${target}`])
	})

	// v0: d62bde9180
	// v0: 0f66931f2b
	// v0: 4cdb0f86ab
	// v0: 2b0365b6c3
	it("ctx.executionCtx is the object fetch was given, and undefined without one", async () => {
		const seen: unknown[] = []
		const app = honey<{}>()
		app.get("/t").handler((ctx) => {
			seen.push(ctx.executionCtx)
			return ctx.res.json("ok", {})
		})
		const { executionCtx } = strictExecutionCtx()
		await send(app, "/t", { executionCtx })
		await send(app, "/t")
		expect(seen).toEqual([executionCtx, undefined])
		expect(seen[0]).toBe(executionCtx)
	})

	// v0: ac413420f7
	// v0: d4bf8a717c
	it("without an execution context, background work still runs, and its failure leaves the answer alone", async () => {
		const ran: string[] = []
		const app = honey<{}>()
		app.get("/bg").handler((ctx) => {
			ctx.background(new Promise((resolve) => setTimeout(resolve, 10)).then(() => ran.push("later")))
			ctx.background(Promise.reject(new Error("bg fail")))
			return ctx.res.json("ok", { answered: true })
		})
		expect(await send(app, "/bg")).toEqual(ok({ answered: true }))
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(ran).toEqual(["later"])
	})
})
