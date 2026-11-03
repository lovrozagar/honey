import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { defineErrors } from "../errors/errors.ts"
import { createMiddleware } from "../middleware/middleware.ts"
import { GRAPH, honey } from "./app.ts"
import { finalTable } from "./dispatch.ts"

const errors = defineErrors({
	email_taken: "conflict",
	invalid_input: "bad_request",
	org_limit_reached: "forbidden",
	org_slug_taken: "conflict",
})

const fetchJson = async (app: { fetch: (r: Request, env: {}) => Response | Promise<Response> }, path: string) => {
	const res = await app.fetch(new Request(`http://localhost${path}`), {})
	return { body: (await res.json()) as Record<string, unknown>, status: res.status }
}

describe("RouteBuilder runtime", () => {
	it("a one-shot method disappears once used", () => {
		const route = honey<{}>().errorFactory(errors).get("/x").errors("email_taken").meta({ summary: "s" })
		expectTypeOf(route).not.toHaveProperty("errors")
		expectTypeOf(route).not.toHaveProperty("meta")
		expectTypeOf(route).toHaveProperty("use")
	})

	// v0: 7894f62ae9
	it("route meta merges over chain meta and dedupes invalidate", async () => {
		const app = honey<{}>()
		app
			.meta({ summary: "chain", tags: "a" })
			.get("/m")
			.meta({ invalidate: ["GET /a", "GET /a", "GET /b"], summary: "route" })
			.handler((ctx) => ctx.res.json("ok", ctx.meta))
		expect((await fetchJson(app, "/m")).body).toEqual({ invalidate: ["GET /a", "GET /b"], summary: "route", tags: "a" })
		app
			.get("/one")
			.meta({ invalidate: ["GET /a"] })
			.handler((ctx) => ctx.res.json("ok", ctx.meta))
		/* the root handle carries no chain meta: meta() returned a derived handle */
		expect((await fetchJson(app, "/one")).body).toEqual({ invalidate: ["GET /a"] })
	})

	it(".on() registers one record per method, sharing the handler", async () => {
		const app = honey<{}>()
		app.on(["GET", "POST"], "/both").handler((ctx) => ctx.res.text("ok", ctx.req.method))
		expect([...finalTable(app[GRAPH]).plans.keys()]).toEqual(["GET /both", "POST /both"])
		const res = await app.fetch(new Request("http://localhost/both", { method: "POST" }), {})
		expect(await res.text()).toBe("POST")
	})
})

describe("RouteBuilder: every one-shot at once", () => {
	// v0: fa8a4feb7d
	// v0: c1a034e3f0
	// v0: 0798132be9
	it("every one-shot together answers as declared, beside middleware, a declared error and a boundary", async () => {
		const errs = defineErrors({ internal_server_error: "internal_server_error", not_found: "not_found" })
		const app = honey<{}>()
			.errorFactory(errs)
			.use(createMiddleware((_ctx, next) => next({ userId: "u-1" })))
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { created: z.object({ id: z.string(), name: z.string(), user: z.string() }) } })
			.meta({ summary: "Create item" })
			.handler((ctx) => ctx.res.json("created", { id: "i-1", name: ctx.input.json.name, user: ctx.userId }))
		app
			.get("/item")
			.errors("not_found")
			.boundary("internal_server_error")
			.handler((ctx) => {
				throw ctx.errors.not_found()
			})
		const created = await app.fetch(
			new Request("http://localhost/items", {
				body: '{"name":"item1"}',
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect([created.status, await created.json(), (await fetchJson(app, "/item")).status]).toEqual([
			201,
			{ id: "i-1", name: "item1", user: "u-1" },
			404,
		])
	})
})

const fetchOf = (app: { fetch: (r: Request, env: {}) => Response | Promise<Response> }, path: string) =>
	Promise.resolve(app.fetch(new Request(`http://localhost${path}`), {}))

describe("RouteBuilder: the .output() shorthand and a returned body", () => {
	it("{ ok: schema } is stored as the application/json form, headers and redirect beside it", () => {
		const app = honey<{}>()
		app
			.get("/t")
			.output({ created: true, headers: { created: z.object({ location: z.string() }) }, redirect: { found: true } })
			.handler((c) => c.res.noContent())
		expect(finalTable(app[GRAPH]).plans.size).toBe(1)
		expect(app[GRAPH].records.get("GET /t")?.out).toEqual({
			"application/json": { created: true },
			headers: { created: expect.any(Object) },
			redirect: { found: true },
		})
	})

	it("a returned body answers at the sole 2xx status, through its media type's helper, sync or async", async () => {
		const app = honey<{}>().logger(false).outputValidation("always")
		app
			.get("/json")
			.output({ created: z.object({ id: z.string() }), not_found: true })
			.handler(async () => ({ id: "1" }))
		app
			.get("/csv")
			.output({ "text/csv": { ok: true } })
			.handler(() => "id\n1")
		app
			.get("/png")
			.output({ "image/png": { accepted: true } })
			.handler(() => new Uint8Array([1, 2]))
		const json = await fetchOf(app, "/json")
		const csv = await fetchOf(app, "/csv")
		const png = await fetchOf(app, "/png")
		expect([json.status, await json.json(), csv.headers.get("content-type"), await csv.text()]).toEqual([
			201,
			{ id: "1" },
			"text/csv; charset=utf-8",
			"id\n1",
		])
		expect([png.status, png.headers.get("content-type"), [...new Uint8Array(await png.arrayBuffer())]]).toEqual([
			202,
			"image/png",
			[1, 2],
		])
	})

	it("an answer still passes as it is, and nothing returned is still the handler's error", async () => {
		const app = honey<{}>().logger(false)
		app
			.get("/answer")
			.output({ ok: true })
			.handler((c) => c.res.noContent())
		app
			.get("/nothing")
			.output({ ok: true })
			.handler((() => undefined) as never)
		expect([(await fetchOf(app, "/answer")).status, (await fetchOf(app, "/nothing")).status]).toEqual([204, 500])
	})
})
