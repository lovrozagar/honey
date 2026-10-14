/**
 * Errors through the app: a throw anywhere in the chain becomes one answer that the middleware
 * around it still shapes, which thrown errors reach the client under an errorFactory (declared,
 * default and boundary keys), ctx.errors, and the app's onError, onNotFound and onMethodNotAllowed.
 */
import { describe, expect, it } from "vitest"
import { HoneyError } from "../../src/errors/error.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { createMiddleware, defineMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"

type Fetchable = { fetch: (r: Request, env: never) => Response | Promise<Response> }

async function send(app: Fetchable, target: string, init: RequestInit = {}) {
	const res = await app.fetch(new Request(`http://localhost${target}`, init), {} as never)
	const text = await res.text()
	const body: unknown = res.headers.get("content-type") === "application/json" ? JSON.parse(text) : text
	return { body, headers: Object.fromEntries(res.headers), status: res.status }
}

const JSON_TYPE = { "content-type": "application/json" }
const envelope = (key: string, status: number, statusKey = key) => ({
	error_key: key,
	fields: {},
	message: key,
	status,
	status_key: statusKey,
	success: false,
})
/** The answer an error gets, with any headers beyond the content type. */
const failure = (key: string, status: number, statusKey = key, extra: Record<string, string> = {}) => ({
	body: envelope(key, status, statusKey),
	headers: { ...JSON_TYPE, ...extra },
	status,
})
const INTERNAL = failure("internal_server_error", 500)

/** A middleware that sets a header on whatever answer comes back from next(). */
const stamp = (name: string, value: string) =>
	createMiddleware(async (_ctx, next) => {
		const res = await next()
		res.headers.set(name, value)
		return res
	})

const STAMPS = { "x-one": "1", "x-two": "2" }

/** An app whose outermost middleware records ctx.error's cause once the rest has answered. */
function observedApp() {
	const causes: unknown[] = []
	const observer = createMiddleware(async (ctx: { error?: HoneyError }, next) => {
		const res = await next()
		causes.push(ctx.error?.cause)
		return res
	})
	return { app: honey<{}>().use(observer), causes }
}

type App = ReturnType<typeof honey<{}>>

/** Where a throw happens, and the answer it becomes. */
const THROWS: Array<{ answer: ReturnType<typeof failure> | object; label: string; route: (app: App) => void }> = [
	{
		answer: failure("bad_request", 400, "bad_request", STAMPS),
		label: "a handler throws a HoneyError",
		route: (app) =>
			app.get("/t").handler(() => {
				throw new HoneyError({ errorKey: "bad_request", status: "bad_request" })
			}),
	},
	{
		answer: failure("not_found", 404, "not_found", STAMPS),
		label: "an async handler throws after an await",
		route: (app) =>
			app.get("/t").handler(async () => {
				await Promise.resolve()
				throw new HoneyError({ errorKey: "not_found", status: "not_found" })
			}),
	},
	{
		answer: failure("bad_request", 400, "bad_request", STAMPS),
		label: "a handler returns a rejected promise",
		route: (app) =>
			app.get("/t").handler(() => Promise.reject(new HoneyError({ errorKey: "bad_request", status: "bad_request" }))),
	},
	{
		answer: failure("internal_server_error", 500, "internal_server_error", STAMPS),
		label: "a handler throws a plain Error",
		route: (app) =>
			app.get("/t").handler(() => {
				throw new Error("kaboom")
			}),
	},
	{
		answer: failure("internal_server_error", 500, "internal_server_error", STAMPS),
		label: "a middleware throws before next()",
		route: (app) =>
			app
				.use(
					createMiddleware(() => {
						throw new RangeError("out of range")
					}),
				)
				.get("/t")
				.handler((ctx) => ctx.res.json("ok", {})),
	},
	{
		answer: failure("internal_server_error", 500, "internal_server_error", STAMPS),
		label: "a middleware throws after next() answered",
		route: (app) =>
			app
				.use(
					createMiddleware(async (_ctx, next) => {
						await next()
						throw new Error("post-processing crashed")
					}),
				)
				.get("/t")
				.handler((ctx) => ctx.res.json("ok", {})),
	},
	{
		answer: failure("conflict", 409, "conflict", { ...STAMPS, "x-route": "yes" }),
		label: "a handler behind route middleware throws",
		route: (app) =>
			app
				.get("/t")
				.use(stamp("x-route", "yes"))
				.handler(() => {
					throw new HoneyError({ errorKey: "conflict", status: "conflict" })
				}),
	},
	{
		answer: { body: { data: 1 }, headers: { ...JSON_TYPE, ...STAMPS }, status: 200 },
		label: "nothing throws",
		route: (app) => app.get("/t").handler((ctx) => ctx.res.json("ok", { data: 1 })),
	},
]

describe("a throw anywhere in the chain becomes one error answer", () => {
	// v0: 2856f1a087
	// v0: 61507ec17c
	// v0: 57cad9f54e
	// v0: 1596ac0783
	// v0: 9dd1cacac5
	// v0: 02c8c70858
	// v0: a361ade160
	// v0: 3bffd4af3d
	// v0: 048cb7f945
	// v0: 17bec54ba7
	// v0: a226a39432
	it.each(THROWS)("when $label, every middleware around it still stamps the answer", async ({ answer, route }) => {
		const app = honey<{}>()
		route(app.use(stamp("x-one", "1")).use(stamp("x-two", "2")))
		expect(await send(app, "/t")).toEqual(answer)
	})
})

/** A layer that answers nothing, and the hint its 500 carries. */
const EMPTY_ANSWERS: Array<[string, (app: App) => void, string]> = [
	["a handler returns null", (app) => app.get("/t").handler((() => null) as never), "handler must return"],
	["a handler returns nothing", (app) => app.get("/t").handler((() => undefined) as never), "handler must return"],
	[
		"a middleware awaits next() and returns nothing",
		(app) =>
			app
				.use(
					createMiddleware((async (_ctx: object, next: () => Promise<Response>) => {
						await next()
					}) as never),
				)
				.get("/t")
				.handler((ctx) => ctx.res.json("ok", {})),
		"middleware must return",
	],
]

describe("a layer that answers nothing, or throws mid-chain", () => {
	// v0: 35d8feadcd
	// v0: 866c9b8ca8
	// v0: 7512c45a97
	it.each(EMPTY_ANSWERS)(
		"when %s, the answer is a 500 whose cause says what to return",
		async (_label, route, hint) => {
			const { app, causes } = observedApp()
			route(app)
			expect(await send(app, "/t")).toEqual(INTERNAL)
			expect(causes).toEqual([expect.objectContaining({ message: expect.stringContaining(hint) })])
		},
	)

	// v0: e96926060d
	it("a throw stops the chain: later middleware and the handler never run", async () => {
		const trace: string[] = []
		const app = honey<{}>()
		const fail = createMiddleware(() => {
			trace.push("mw1")
			throw new Error("early fail")
		})
		const later = createMiddleware((_ctx, next) => {
			trace.push("mw2")
			return next()
		})
		app
			.get("/t")
			.use(fail)
			.use(later)
			.handler((ctx) => {
				trace.push("handler")
				return ctx.res.json("ok", {})
			})
		expect(await send(app, "/t")).toEqual(INTERNAL)
		expect(trace).toEqual(["mw1"])
	})
})

describe("a middleware rewriting the error answer", () => {
	// v0: fb311f828e
	// v0: 481a492388
	it.each<[string, (res: Response) => Promise<Response>, object]>([
		[
			"replaces it",
			async () => Response.json({ error_key: "wrapped_error", status: 502 }, { status: 502 }),
			{ body: { error_key: "wrapped_error", status: 502 }, headers: JSON_TYPE, status: 502 },
		],
		[
			"reads and extends it",
			async (res) => Response.json({ ...((await res.json()) as object), extra: true }, { status: res.status }),
			{ body: { ...envelope("internal_server_error", 500), extra: true }, headers: JSON_TYPE, status: 500 },
		],
	])("a middleware that %s changes the error answer the client gets", async (_label, rewrite, answer) => {
		const app = honey<{}>()
		app
			.use(createMiddleware(async (_ctx, next) => rewrite(await next())))
			.get("/t")
			.handler(() => {
				throw new Error("original")
			})
		expect(await send(app, "/t")).toEqual(answer)
	})
})

const errors = defineErrors({
	auth_failed: "unauthorized",
	not_found: "not_found",
	rate_limited: "too_many_requests",
	wrapped: "bad_gateway",
})

/**
 * A /t route on `errors`, with auth_failed a default error, that declares not_found and throws
 * `thrown`; `boundary` sets the app's defaultBoundary (auth_failed under "both"), the route's, or both.
 */
function factoryApp(thrown: () => unknown, boundary: "app" | "both" | "none" | "route" = "none") {
	const app = honey<{}>().errorFactory(errors).defaultErrors("auth_failed")
	if (boundary === "app") app.defaultBoundary("wrapped")
	if (boundary === "both") app.defaultBoundary("auth_failed")
	const route = app.get("/t").errors("not_found")
	const handler = () => {
		throw thrown()
	}
	if (boundary === "route" || boundary === "both") route.boundary("wrapped").handler(handler)
	else route.handler(handler)
	return app
}

/** A thrown error, and the answer it becomes under the factory. */
const REACHES: Array<[string, () => unknown, object]> = [
	["a declared key", () => errors.not_found(), failure("not_found", 404)],
	["a default key the route did not declare", () => errors.auth_failed(), failure("auth_failed", 401, "unauthorized")],
	["an undeclared key", () => errors.rate_limited(), INTERNAL],
	[
		"a HoneyError from outside the factory",
		() => new HoneyError({ errorKey: "teapot", status: "bad_request" }),
		INTERNAL,
	],
	["a plain Error", () => new Error("raw"), INTERNAL],
	[
		"a HoneyError with an unknown status key",
		() => new HoneyError({ errorKey: "not_found", status: "nope" as never }),
		INTERNAL,
	],
]

/** What a boundary turns into its key. */
const WRAPPED: Array<() => unknown> = [
	() => new Error("raw"),
	() => errors.rate_limited(),
	() => new HoneyError({ errorKey: "teapot", status: "conflict" }),
	() => "oops",
]

describe("which errors reach the client under an errorFactory", () => {
	// v0: 57575ddf02
	// v0: ce007f0a3e
	// v0: 02a96b4dbf
	// v0: 0c6e33b336
	it.each(REACHES)("%s gives %o", async (_label, thrown, answer) => {
		expect(await send(factoryApp(thrown), "/t")).toEqual(answer)
	})

	// v0: 8a8c5fae41
	// v0: 98bf3d6a4b
	// v0: a85cd7425e
	// v0: b4486ba413
	// v0: a116eca180
	// v0: 1d0d61b024
	// v0: e4980f2aea
	it.each([
		["the app's defaultBoundary", "app"],
		["the route's .boundary()", "route"],
		["the route's .boundary() over the app's defaultBoundary", "both"],
	] as const)("%s turns any undeclared throw into its key, and lets declared ones through", async (_l, at) => {
		for (const thrown of WRAPPED)
			expect(await send(factoryApp(thrown, at), "/t")).toEqual(failure("wrapped", 502, "bad_gateway"))
		expect(
			await send(
				factoryApp(() => errors.not_found(), at),
				"/t",
			),
		).toEqual(failure("not_found", 404))
	})

	// v0: b2dda0df3a
	// v0: cc8702d138
	it("a middleware's declared errors reach the client on the routes that use it", async () => {
		const own = defineErrors({ auth_required: "unauthorized", rate_limited: "too_many_requests" })
		const auth = defineMiddleware({
			errors: [own, "auth_required"],
			fn: (ctx: { req: Request }, next) => {
				if (!ctx.req.headers.get("authorization")) throw own.auth_required()
				return next()
			},
		})
		const app = honey<{}>().errorFactory(own)
		app
			.get("/p")
			.use(auth)
			.handler((ctx) => ctx.res.json("ok", { in: true }))
		expect(await send(app, "/p")).toEqual(failure("auth_required", 401, "unauthorized"))
		const authed = await send(app, "/p", { headers: { authorization: "Bearer tok" } })
		expect(authed).toEqual({ body: { in: true }, headers: JSON_TYPE, status: 200 })
	})
})

/** What a handler sees of ctx.errors. */
const errorsOf = (errs: object) => ({ frozen: Object.isFrozen(errs), keys: Object.keys(errs).sort() })

describe("ctx.errors", () => {
	// v0: 7241a672c9
	// v0: e536dc6e3f
	// v0: ce588ead87
	// v0: e7cd539ce9
	// v0: d8b2121635
	// v0: 14c568d896
	it("holds, frozen, the route's declared and boundary keys (named alone or with the factory) and the app's defaults", async () => {
		const app = honey<{}>().errorFactory(errors).defaultErrors("auth_failed")
		app
			.get("/declared")
			.errors("not_found")
			.handler((ctx) => ctx.res.json("ok", errorsOf(ctx.errors)))
		app
			.get("/bounded")
			.boundary("wrapped")
			.handler((ctx) => ctx.res.json("ok", errorsOf(ctx.errors)))
		app
			.get("/named")
			.errors(errors, "rate_limited")
			.handler((ctx) => ctx.res.json("ok", errorsOf(ctx.errors)))
		app.get("/none").handler((ctx) => ctx.res.json("ok", errorsOf(ctx.errors)))
		app
			.get("/throw")
			.errors("not_found")
			.handler((ctx) => {
				throw ctx.errors.not_found()
			})
		app.get("/default").handler((ctx) => {
			throw ctx.errors.auth_failed()
		})
		const keys = (list: string[]) => ({ body: { frozen: true, keys: list }, headers: JSON_TYPE, status: 200 })
		expect(await send(app, "/declared")).toEqual(keys(["auth_failed", "not_found"]))
		expect(await send(app, "/bounded")).toEqual(keys(["auth_failed", "wrapped"]))
		expect(await send(app, "/named")).toEqual(keys(["auth_failed", "rate_limited"]))
		expect(await send(app, "/none")).toEqual(keys(["auth_failed"]))
		expect(await send(app, "/throw")).toEqual(failure("not_found", 404))
		expect(await send(app, "/default")).toEqual(failure("auth_failed", 401, "unauthorized"))
	})
})

/** What onError returns, and the answer the client gets. */
const ON_ERROR: Array<[string, () => unknown, object]> = [
	[
		"returns a Response",
		() => new Response("handled", { status: 418 }),
		{
			body: "handled",
			headers: { "content-type": "text/plain;charset=UTF-8" },
			status: 418,
		},
	],
	[
		"returns a HoneyError",
		() => new HoneyError({ errorKey: "typed", status: "conflict" }),
		failure("typed", 409, "conflict"),
	],
	[
		"resolves to a HoneyError",
		async () => new HoneyError({ errorKey: "typed", status: "conflict" }),
		failure("typed", 409, "conflict"),
	],
	["returns nothing", () => undefined, INTERNAL],
	[
		"returns a HoneyError with an unknown status key",
		() => new HoneyError({ errorKey: "typed", status: "nope" as never }),
		INTERNAL,
	],
	[
		"throws",
		() => {
			throw new Error("onError broke")
		},
		INTERNAL,
	],
	["rejects", () => Promise.reject(new Error("onError broke")), INTERNAL],
]

describe("the app's error handlers", () => {
	it.each(ON_ERROR)("an onError that %s, given what was thrown, gives %o", async (_label, onError, answer) => {
		const seen: unknown[] = []
		const boom = new Error("boom")
		const app = honey<{}>().onError((thrown) => {
			seen.push(thrown)
			return onError() as never
		})
		app.get("/t").handler(() => {
			throw boom
		})
		expect(await send(app, "/t")).toEqual(answer)
		expect(seen).toEqual([boom])
	})

	it("onNotFound answers unknown paths; onMethodNotAllowed answers wrong methods, keeping Allow", async () => {
		const app = honey<{}>()
			.onNotFound((ctx) => Response.json({ missing: new URL(ctx.req.url).pathname }, { status: 404 }))
			.onMethodNotAllowed((ctx) => Response.json({ allowed: ctx.allowed }, { status: 405 }))
		app.get("/t").handler((ctx) => ctx.res.json("ok", {}))
		app.post("/t").handler((ctx) => ctx.res.json("ok", {}))
		expect(await send(app, "/nope")).toEqual({ body: { missing: "/nope" }, headers: JSON_TYPE, status: 404 })
		expect(await send(app, "/t", { method: "DELETE" })).toEqual({
			body: { allowed: ["GET", "POST"] },
			headers: { ...JSON_TYPE, allow: "GET, POST" },
			status: 405,
		})
	})
})
