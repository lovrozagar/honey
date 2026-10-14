import { describe, expect, it } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { defineErrors } from "../errors/errors.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { type Honey, honey } from "./app.ts"

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init)
const pass = createMiddleware((_ctx, next) => next())
const gone = () => new HoneyError({ errorKey: "gone", status: "gone" })

/** An app with `GET /x`, plus `configure`. */
function appWith(configure: (app: Honey<{}>) => void = () => undefined): Honey<{}> {
	const app = honey<{}>()
	app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
	configure(app)
	return app
}

async function body(res: Response | Promise<Response>): Promise<Record<string, unknown>> {
	return (await (await res).json()) as Record<string, unknown>
}

describe("dispatch: request targets and routing", () => {
	it("a path the normalization policy rejects is a 400, through the factory's bad_request when it has one", async () => {
		expect((await appWith().fetch(req("/a%2Fb"), {})).status).toBe(400)
		const errors = defineErrors({ bad_request: "unprocessable_entity" })
		const app = honey<{}>().errorFactory(errors)
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		expect((await app.fetch(req("/a%2Fb"), {})).status).toBe(422)
	})

	it("answers a static route without the tree and a param route through it", async () => {
		const app = appWith((a) => a.get("/u/:id").handler((ctx) => ctx.res.text("ok", ctx.params.id)))
		expect(await (await app.fetch(req("/x"), {})).text()).toBe("x")
		expect(await (await app.fetch(req("/u/7"), {})).text()).toBe("7")
	})

	it("HEAD runs the GET route; a lower-case method is matched upper-case", async () => {
		const app = appWith((a) => a.patch("/p").handler((ctx) => ctx.res.text("ok", "p")))
		expect((await app.fetch(req("/x", { method: "HEAD" }), {})).status).toBe(200)
		expect((await app.fetch(req("/p", { method: "patch" }), {})).status).toBe(200)
	})

	it("an ALL route answers every method, static or not", async () => {
		const app = honey<{}>()
		app.all("/any").handler((ctx) => ctx.res.text("ok", ctx.req.method))
		expect(await (await app.fetch(req("/any", { method: "DELETE" }), {})).text()).toBe("DELETE")
	})

	it("context values are on ctx; env and executionCtx are passed through", async () => {
		const app = honey<{ n: number }>().context({ tag: "t" })
		app
			.get("/c")
			.handler((ctx) => ctx.res.json("ok", { env: ctx.env.n, tag: ctx.tag, wait: typeof ctx.executionCtx?.waitUntil }))
		const res = await app.fetch(req("/c"), { n: 3 }, { waitUntil: () => undefined })
		expect(await body(res)).toEqual({ env: 3, tag: "t", wait: "function" })
	})
})

describe("dispatch: 404", () => {
	it("a miss nothing observes is the fixed 404, fresh each time", async () => {
		const app = appWith()
		const a = await app.fetch(req("/nope"), {})
		const b = await app.fetch(req("/nope"), {})
		expect(a).not.toBe(b)
		expect(await body(a)).toEqual({
			error_key: "not_found",
			fields: {},
			message: "not_found",
			status: 404,
			status_key: "not_found",
			success: false,
		})
		expect(a.headers.get("content-type")).toBe("application/json")
	})

	it("a late onNotFound, a custom formatter or a factory still apply, with no middleware", async () => {
		const app = appWith()
		await app.fetch(req("/nope"), {})
		app.onNotFound(() => new Response("custom", { status: 404 }))
		expect(await (await app.fetch(req("/nope"), {})).text()).toBe("custom")
		const formatted = appWith((a) => a.defaultErrorFormatter((_e, shape) => ({ ...shape, at: 1 })))
		expect((await body(formatted.fetch(req("/nope"), {}))).at).toBe(1)
		const errors = defineErrors({ not_found: "gone" })
		const factory = honey<{}>().errorFactory(errors)
		factory.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		expect((await factory.fetch(req("/nope"), {})).status).toBe(410)
		const custom = appWith((a) => a.customErrorFormatter((_e, data) => data))
		expect((await custom.fetch(req("/nope"), {})).status).toBe(404)
	})

	it("a miss with middleware runs the pipeline", async () => {
		const seen: string[] = []
		const app = honey<{}>().use(
			createMiddleware((ctx, next) => {
				seen.push((ctx as { path: string }).path)
				return next()
			}),
		)
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		expect((await app.fetch(req("/nope"), {})).status).toBe(404)
		expect(seen).toEqual(["/nope"])
	})
})

describe("dispatch: 405 and preflight", () => {
	it("a 405 carries Allow; onMethodNotAllowed answers sync or async, with Allow added", async () => {
		const res = await appWith().fetch(req("/x", { method: "POST" }), {})
		expect([res.status, res.headers.get("allow")]).toEqual([405, "GET"])
		const sync = appWith((a) => a.onMethodNotAllowed(({ allowed }) => new Response(allowed.join("|"), { status: 405 })))
		const mapped = await sync.fetch(req("/x", { method: "POST" }), {})
		expect([await mapped.text(), mapped.headers.get("allow")]).toEqual(["GET", "GET"])
		const asyncApp = appWith((a) => a.onMethodNotAllowed(async () => new Response("later", { status: 405 })))
		expect((await asyncApp.fetch(req("/x", { method: "POST" }), {})).headers.get("allow")).toBe("GET")
	})

	it("an onMethodNotAllowed response with immutable headers is rebuilt to carry Allow", async () => {
		const app = appWith((a) => a.onMethodNotAllowed(() => Response.redirect("https://example.com/", 302)))
		const res = await app.fetch(req("/x", { method: "POST" }), {})
		expect([res.status, res.headers.get("allow"), res.headers.get("location")]).toEqual([
			302,
			"GET",
			"https://example.com/",
		])
	})

	it("a preflight runs the asked-about route's chain; middleware can answer it", async () => {
		const app = honey<{}>()
		app
			.use(
				createMiddleware((ctx, next) =>
					(ctx as { req: Request }).req.method === "OPTIONS" ? new Response(null, { status: 204 }) : next(),
				),
			)
			.post("/p")
			.handler((ctx) => ctx.res.text("ok", "p"))
		const preflight = req("/p", { headers: { "access-control-request-method": "post" }, method: "OPTIONS" })
		expect((await app.fetch(preflight, {})).status).toBe(204)
		expect((await app.fetch(preflight, {})).status).toBe(204)
	})

	it("a preflight for a method nothing serves, or without the header, is the 405", async () => {
		const app = appWith((a) =>
			a
				.use(pass)
				.post("/x")
				.handler((ctx) => ctx.res.text("ok", "p")),
		)
		const asked = await app.fetch(
			req("/x", { headers: { "access-control-request-method": "PUT" }, method: "OPTIONS" }),
			{},
		)
		expect([asked.status, asked.headers.get("allow")]).toEqual([405, "GET, POST"])
		expect((await app.fetch(req("/x", { method: "OPTIONS" }), {})).status).toBe(405)
	})
})

function throwing(configure: (app: Honey<{}>) => void, thrown: () => unknown = gone): Honey<{}> {
	const app = honey<{}>()
	configure(app)
	app.get("/t").handler(() => {
		throw thrown()
	})
	return app
}

const unserializable = () => new HoneyError({ data: { n: 1n }, errorKey: "x", status: "conflict" })

describe("dispatch: the error boundary", () => {
	it("onError mapping to a HoneyError replaces the error; a Response answers as is", async () => {
		const mapped = throwing((a) => a.onError(() => new HoneyError({ errorKey: "teapot", status: "im_a_teapot" })))
		expect((await mapped.fetch(req("/t"), {})).status).toBe(418)
		const answered = throwing((a) => a.onError(() => new Response("mine", { status: 503 })))
		expect(await (await answered.fetch(req("/t"), {})).text()).toBe("mine")
	})

	it("onError returning nothing, throwing, or rejecting falls back to the projection", async () => {
		for (const handler of [
			() => undefined,
			() => {
				throw new Error("broken hook")
			},
			async () => Promise.reject(new Error("broken hook")),
			async () => undefined,
		]) {
			expect((await throwing((a) => a.onError(handler)).fetch(req("/t"), {})).status).toBe(410)
		}
	})

	it("onError receives the thrown value and jsonFromError, env and req", async () => {
		const seen: unknown[] = []
		const app = throwing((a) =>
			a.onError((error, ctx) => {
				seen.push(error instanceof HoneyError, ctx.req.url, ctx.env)
				return ctx.jsonFromError(new HoneyError({ errorKey: "x", status: "conflict" }))
			}),
		)
		expect((await app.fetch(req("/t"), { e: 1 } as never)).status).toBe(409)
		expect(seen).toEqual([true, "http://localhost/t", { e: 1 }])
	})

	it("an error response that cannot be built falls back to the fixed 500, sync or async", async () => {
		const sync = await throwing(() => undefined, unserializable).fetch(req("/t"), {})
		expect([sync.status, await sync.json()]).toEqual([500, { error: { errorKey: "internal_server_error" } }])
		const viaHook = throwing((a) => a.onError(async () => unserializable()), unserializable)
		expect((await viaHook.fetch(req("/t"), {})).status).toBe(500)
	})
})
