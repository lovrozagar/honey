/**
 * Middleware: the order a chain runs in, what next() adds to ctx, answering or rewriting the
 * response, what runs for unknown paths and wrong methods, and how a failure inside the chain
 * becomes an answer that the middleware around it still sees through ctx.error.
 */
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { HoneyError } from "../../src/errors/error.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

type Fetchable = { fetch: (r: Request, env: never) => Response | Promise<Response> }

async function send(app: Fetchable, target: string, init: RequestInit = {}, env: object = {}) {
	const res = await app.fetch(new Request(`http://localhost${target}`, init), env as never)
	const text = await res.text()
	const body: unknown = res.headers.get("content-type") === "application/json" ? JSON.parse(text) : text
	return { body, headers: Object.fromEntries(res.headers), status: res.status }
}

const JSON_TYPE = { "content-type": "application/json" }
const TEXT_TYPE = { "content-type": "text/plain; charset=utf-8" }
/** What `new Response(string)` carries. */
const PLAIN_TYPE = { "content-type": "text/plain;charset=UTF-8" }
/** The answer a JSON body gets. */
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => ({
	body,
	headers: { ...JSON_TYPE, ...extra },
	status,
})
/** The answer an error gets. */
/** An unknown error's 500 carries a random digest; its operator line carries the same (H17). */
const DIGEST = { digest: expect.stringMatching(/^[0-9a-f]{16}$/) }
const failure = (key: string, status: number, extra?: Record<string, string>) =>
	json(
		{
			...(key === "internal_server_error" ? DIGEST : {}),
			error_key: key,
			fields: {},
			message: key,
			status,
			status_key: key,
			success: false,
		},
		status,
		extra,
	)

/** A middleware that records `name` each time it runs, and `/name` after next() when `around`. */
const tracer = (trace: string[], name: string, around = false) =>
	createMiddleware(async (_ctx, next) => {
		trace.push(name)
		const res = await next()
		if (around) trace.push(`/${name}`)
		return res
	})

/** A middleware that adds `values` to ctx. */
const adds = <T extends Record<string, unknown>>(values: T) => createMiddleware((_ctx, next) => next(values))

/** A middleware that answers 401 without calling next(). */
const deny = () => createMiddleware(() => new Response("blocked", { status: 401 }))

/** An app whose outermost middleware records what ctx.error holds once the rest has answered. */
function observedApp() {
	const seen: Array<{ cause: unknown; errorKey: string | undefined; status: number }> = []
	const observer = createMiddleware(async (ctx: { error?: HoneyError }, next) => {
		const res = await next()
		seen.push({ cause: ctx.error?.cause, errorKey: ctx.error?.errorKey, status: res.status })
		return res
	})
	return { app: honey<{}>().use(observer), seen }
}

describe("run order", () => {
	// v0: 218eee8dac
	// v0: 1dbac94283
	// v0: 597d267652
	// v0: 066c4587f9
	// v0: 619e672b14
	// v0: e73c0454ac
	// v0: a27bc83725
	// v0: c3812cb356
	// v0: 719374c20b
	it.each([0, 1, 10, 20])(
		"a chain of %i middlewares runs in registration order, then the handler sees the request",
		async (n) => {
			const trace: string[] = []
			const app = honey<{ DB: string }>()
			let chain = app
			for (let i = 0; i < n; i++) chain = chain.use(tracer(trace, `mw${i}`))
			chain.get("/users/:id").handler((ctx) => {
				trace.push("handler")
				const { method, url } = ctx.req
				return ctx.res.json("ok", { db: ctx.env.DB, id: ctx.params.id, method, pattern: ctx.routePattern, url })
			})
			expect(await send(app, "/users/42", {}, { DB: "postgres" })).toEqual(
				json({ db: "postgres", id: "42", method: "GET", pattern: "/users/:id", url: "http://localhost/users/42" }),
			)
			expect(trace).toEqual([...Array.from({ length: n }, (_, i) => `mw${i}`), "handler"])
		},
	)

	// v0: c30939bc66
	// v0: 810e8e8e6b
	// v0: 36dad156f7
	// v0: 8d9c33c410
	it("chain middleware runs first, then the route's own use() calls, then the handler; after next() it unwinds", async () => {
		const trace: string[] = []
		const app = honey<{}>()
		app
			.use(tracer(trace, "chain1", true))
			.use(tracer(trace, "chain2", true))
			.get("/t")
			.use(tracer(trace, "route1", true))
			.use(tracer(trace, "route2", true))
			.handler((ctx) => {
				trace.push("handler")
				return ctx.res.text("ok", "done")
			})
		expect(await send(app, "/t")).toEqual({ body: "done", headers: TEXT_TYPE, status: 200 })
		expect(trace).toEqual([
			"chain1",
			"chain2",
			"route1",
			"route2",
			"handler",
			"/route2",
			"/route1",
			"/chain2",
			"/chain1",
		])
	})
})

describe("what next() adds to ctx", () => {
	// v0: cf0b992a69
	// v0: ba5b946902
	// v0: 5b31b6f015
	// v0: fcc562aa1a
	// v0: 48ec040348
	// v0: 31b9b2ca5c
	// v0: 07e91fb5ad
	// v0: 55605e9620
	it("each middleware's additions, chain or route, of any value kind, reach the handler together", async () => {
		const app = honey<{}>()
			.use(adds({ count: 42, tags: ["a", "b"] }))
			.use(adds({ isAdmin: true, nothing: null }))
		app
			.get("/t")
			.use(adds({ db: "postgres" }))
			.use(adds({ userId: "u-1" }))
			.handler((ctx) => {
				const { count, db, isAdmin, nothing, tags, userId } = ctx
				return ctx.res.json("ok", { count, db, isAdmin, nothing, tags, userId })
			})
		expect(await send(app, "/t")).toEqual(
			json({ count: 42, db: "postgres", isAdmin: true, nothing: null, tags: ["a", "b"], userId: "u-1" }),
		)
	})

	// v0: 442fc94589
	it("a later middleware's value for a key replaces an earlier one", async () => {
		const app = honey<{}>()
			.use(adds({ version: "v1" }))
			.use(adds({ version: "v2" }))
		app.get("/t").handler((ctx) => ctx.res.json("ok", { version: ctx.version }))
		expect(await send(app, "/t")).toEqual(json({ version: "v2" }))
	})

	// v0: 3a39e3ef4d
	it("one middleware instance serves two apps, each with its own routes", async () => {
		const shared = adds({ shared: true })
		const [a, b] = [honey<{}>().use(shared), honey<{}>().use(shared)]
		a.get("/t").handler((ctx) => ctx.res.json("ok", { app: "a", shared: ctx.shared }))
		b.get("/t").handler((ctx) => ctx.res.json("ok", { app: "b", shared: ctx.shared }))
		expect((await send(a, "/t")).body).toEqual({ app: "a", shared: true })
		expect((await send(b, "/t")).body).toEqual({ app: "b", shared: true })
	})
})

describe("answering and rewriting the response", () => {
	// v0: 013c02744a
	it("a middleware can answer some requests itself and pass the rest on", async () => {
		const handled: string[] = []
		const cache = createMiddleware((ctx: { path: string }, next) =>
			ctx.path === "/cached" ? Response.json({ cached: true }) : next(),
		)
		const app = honey<{}>()
		const cached = app.use(cache)
		for (const path of ["/cached", "/fresh"])
			cached.get(path).handler((ctx) => {
				handled.push(path)
				return ctx.res.text("ok", "fresh")
			})
		expect(await send(app, "/cached")).toEqual(json({ cached: true }))
		expect(await send(app, "/fresh")).toEqual({ body: "fresh", headers: TEXT_TYPE, status: 200 })
		expect(handled).toEqual(["/fresh"])
	})

	// v0: 8eaf16daf6
	// v0: 205bbd2d9d
	// v0: 1f5d595ad4
	// v0: ae4cef7f27
	it.each([
		["the chain", (app: ReturnType<typeof honey<{}>>, mw: ReturnType<typeof deny>) => app.use(mw).get("/guarded")],
		["the route", (app: ReturnType<typeof honey<{}>>, mw: ReturnType<typeof deny>) => app.get("/guarded").use(mw)],
	])("a middleware on %s that answers without next() is the answer; the handler never runs", async (_where, guard) => {
		const handled: string[] = []
		const app = honey<{}>()
		guard(app, deny()).handler((ctx) => {
			handled.push("guarded")
			return ctx.res.text("ok", "secret")
		})
		app.get("/open").handler((ctx) => ctx.res.text("ok", "open"))
		expect(await send(app, "/guarded")).toEqual({ body: "blocked", headers: PLAIN_TYPE, status: 401 })
		expect(await send(app, "/open")).toEqual({ body: "open", headers: TEXT_TYPE, status: 200 })
		expect(handled).toEqual([])
	})
})

describe("answering and rewriting the response: after next()", () => {
	// v0: a8a71bfe29
	// v0: f08eb180b6
	// v0: 0d2f414a43
	it.each([
		["sets a new status", (res: Response) => new Response(res.body, { headers: res.headers, status: 202 }), 202, {}],
		[
			"copies the answer with an added header",
			(res: Response) => {
				const headers = new Headers(res.headers)
				headers.set("x-wrapped", "true")
				return new Response(res.body, { headers, status: res.status })
			},
			200,
			{ "x-wrapped": "true" },
		],
		[
			"sets a header on the answer in place",
			(res: Response) => {
				res.headers.set("x-timing", "3ms")
				return res
			},
			200,
			{ "x-timing": "3ms" },
		],
	] as const)("a middleware that %s changes what the client gets", async (_label, rewrite, status, extra) => {
		const app = honey<{}>()
		app
			.use(createMiddleware(async (_ctx, next) => rewrite(await next())))
			.get("/t")
			.handler((ctx) => ctx.res.json("ok", { original: true }))
		expect(await send(app, "/t")).toEqual(json({ original: true }, status, extra))
	})

	// v0: a4fb5e2222
	// v0: b0f1262e67
	it("a middleware can replace the handler's answer or the 404, whatever came back", async () => {
		const replace = createMiddleware(async (ctx: { path: string }, next) => {
			const res = await next()
			if (ctx.path === "/t") return Response.json({ replaced: true })
			return res.status === 404 ? Response.json({ custom: true }) : res
		})
		const app = honey<{}>().use(replace)
		app.get("/t").handler((ctx) => ctx.res.json("ok", { original: true }))
		app.get("/kept").handler((ctx) => ctx.res.json("ok", { original: true }))
		expect(await send(app, "/t")).toEqual(json({ replaced: true }))
		expect(await send(app, "/nope")).toEqual(json({ custom: true }))
		expect(await send(app, "/kept")).toEqual(json({ original: true }))
	})
})

describe("unknown paths and wrong methods", () => {
	// v0: b2e28f0085
	// v0: 90604cf322
	// v0: 493c1a37f1
	// v0: b2638db3b2
	it.each([
		{ answer: failure("not_found", 404), label: "an unknown path", method: "GET", target: "/nope" },
		{
			answer: failure("method_not_allowed", 405, { allow: "GET" }),
			label: "a wrong method",
			method: "DELETE",
			target: "/exists",
		},
	])("$label runs the chain's middleware, not a route's", async ({ answer, method, target }) => {
		const trace: string[] = []
		const app = honey<{}>()
		app
			.use(tracer(trace, "chain"))
			.get("/exists")
			.use(tracer(trace, "route"))
			.handler((ctx) => ctx.res.json("ok", {}))
		expect(await send(app, target, { method })).toEqual(answer)
		expect(trace).toEqual(["chain"])
	})

	// v0: 305088dc1e
	it("an app with middleware and no routes answers 404 after running it", async () => {
		const trace: string[] = []
		const app = honey<{}>().use(tracer(trace, "chain"))
		expect(await send(app, "/t")).toEqual(failure("not_found", 404))
		expect(trace).toEqual(["chain"])
	})
})

describe("ctx.error after next()", () => {
	// v0: 4e5af7c920
	it("holds the HoneyError an inner middleware threw", async () => {
		const { app, seen } = observedApp()
		const forbid = createMiddleware(() => {
			throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
		})
		app
			.use(forbid)
			.get("/denied")
			.handler((ctx) => ctx.res.json("ok", {}))
		expect(await send(app, "/denied")).toEqual(failure("forbidden", 403))
		expect(seen).toEqual([{ cause: undefined, errorKey: "forbidden", status: 403 }])
	})

	// v0: 2e79dbef87
	// v0: 847f09f075
	it("holds the 500 a handler throw became, with the original as cause, and nothing when all went well", async () => {
		const { app, seen } = observedApp()
		const boom = new Error("db down")
		app.get("/boom").handler(() => {
			throw boom
		})
		app.get("/fine").handler((ctx) => ctx.res.json("ok", {}))
		expect(await send(app, "/boom")).toEqual(failure("internal_server_error", 500))
		expect(await send(app, "/fine")).toEqual(json({}))
		expect(seen).toEqual([
			{ cause: boom, errorKey: "internal_server_error", status: 500 },
			{ cause: undefined, errorKey: undefined, status: 200 },
		])
	})

	// v0: 0bf423024b
	it("error is a framework key, so context() refuses it", () => {
		expect(() => honey().context({ error: 1 } as never)).toThrow('context() cannot set reserved key "error"')
	})
})

/** A middleware mistake, and the message of the error it causes. */
const MISTAKES = [
	[
		"calls next() twice",
		createMiddleware(async (_ctx, next) => {
			await next()
			return next()
		}),
		"next() called multiple times",
	],
	[
		"forgets to return next()",
		createMiddleware((_ctx, next) => {
			void next()
			return undefined as never
		}),
		"middleware must return a Response — did you forget 'return next(...)'?",
	],
	[
		"deletes ctx.req",
		createMiddleware((ctx, next) => {
			delete (ctx as Record<string, unknown>).req
			return next()
		}),
		"Cannot read properties of undefined (reading 'url')",
	],
	[
		"replaces ctx.res",
		createMiddleware((ctx, next) => {
			;(ctx as Record<string, unknown>).res = "not a responder"
			return next()
		}),
		"ctx.res.text is not a function",
	],
] as const

describe("ctx.error after next(): input validation", () => {
	// v0: ea83f7a469
	it("holds the 400 a refused .input() became", async () => {
		const { app, seen } = observedApp()
		app
			.get("/v")
			.input({ search: z.object({ n: z.coerce.number() }) })
			.handler((ctx) => ctx.res.json("ok", {}))
		expect((await send(app, "/v?n=x")).status).toBe(400)
		expect(seen).toEqual([{ cause: undefined, errorKey: "validation_failed", status: 400 }])
	})
})

describe("ctx.error after next(): mistakes inside the chain", () => {
	// v0: 58a7509d07
	// v0: 47f29a140d
	// v0: b50f04581b
	// v0: 2d82b9571f
	it.each(MISTAKES)(
		"a middleware that %s answers 500, and the cause names the mistake",
		async (_label, mistake, message) => {
			const { app, seen } = observedApp()
			app
				.use(mistake)
				.get("/t")
				.handler((ctx) => ctx.res.text("ok", ctx.req.url))
			expect(await send(app, "/t")).toEqual(failure("internal_server_error", 500))
			expect(seen).toEqual([
				{ cause: expect.objectContaining({ message }), errorKey: "internal_server_error", status: 500 },
			])
		},
	)

	// v0: 5769e0c401
	it("a second next() throws where it is called, and the first answer stands", async () => {
		const thrown: unknown[] = []
		const app = honey<{}>().use(
			createMiddleware(async (_ctx, next) => {
				const res = await next()
				try {
					await next()
				} catch (error) {
					thrown.push(error)
				}
				return res
			}),
		)
		app.get("/t").handler((ctx) => ctx.res.text("ok", "first"))
		expect(await send(app, "/t")).toEqual({ body: "first", headers: TEXT_TYPE, status: 200 })
		expect(thrown).toEqual([new Error("next() called multiple times")])
	})
})

describe("concurrent requests", () => {
	// v0: b04e106a45
	it("each request runs the chain once, with its own ctx", async () => {
		let runs = 0
		const app = honey<{}>().use(
			createMiddleware((ctx, next) => {
				runs++
				return next({ requestId: ctx.req.headers.get("x-id") })
			}),
		)
		app.get("/t").handler(async (ctx) => {
			await new Promise((resolve) => setTimeout(resolve, Math.random() * 10))
			return ctx.res.json("ok", { requestId: ctx.requestId })
		})
		const ids = Array.from({ length: 20 }, (_, i) => `r${i}`)
		const answers = await Promise.all(ids.map((id) => send(app, "/t", { headers: { "x-id": id } })))
		expect(answers.map((a) => a.body)).toEqual(ids.map((requestId) => ({ requestId })))
		expect(runs).toBe(20)
	})

	// v0: 13c20aab5e
	// v0: eeedfe98fd
	it("a slow middleware holds only its own request, which still gets its additions", async () => {
		const app = honey<{}>()
		const slow = createMiddleware(async (_ctx, next) => {
			await new Promise((resolve) => setTimeout(resolve, 50))
			return next({ delayed: true })
		})
		app
			.use(slow)
			.get("/slow")
			.handler((ctx) => ctx.res.json("ok", { delayed: ctx.delayed }))
		app.get("/fast").handler((ctx) => ctx.res.json("ok", { delayed: false }))
		const order: string[] = []
		const slowAnswer = send(app, "/slow").then((answer) => {
			order.push("slow")
			return answer
		})
		expect((await send(app, "/fast")).body).toEqual({ delayed: false })
		order.push("fast")
		expect((await slowAnswer).body).toEqual({ delayed: true })
		expect(order).toEqual(["fast", "slow"])
	})
})
