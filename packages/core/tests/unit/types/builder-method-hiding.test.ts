import { describe, expect, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { createMiddleware, defineErrors, honey } from "../../../src/index.ts"

type Assert<T extends true> = T
type HasKey<T, K extends string> = K extends keyof T ? true : false
type NotHasKey<T, K extends string> = K extends keyof T ? false : true

describe("route builder lifecycle — fresh builder", () => {
	it("has all methods available", () => {
		const b = honey<{}>().get("/test")
		type B = typeof b
		type _1 = Assert<HasKey<B, "input">>
		type _2 = Assert<HasKey<B, "output">>
		type _3 = Assert<HasKey<B, "meta">>
		type _4 = Assert<HasKey<B, "use">>
		type _5 = Assert<HasKey<B, "errors">>
		type _6 = Assert<HasKey<B, "boundary">>
		type _7 = Assert<HasKey<B, "handler">>
		type _8 = Assert<HasKey<B, "proxy">>
	})

	it("has all methods on .post() builder too", () => {
		const b = honey<{}>().post("/test")
		type B = typeof b
		type _1 = Assert<HasKey<B, "input">>
		type _2 = Assert<HasKey<B, "output">>
		type _3 = Assert<HasKey<B, "meta">>
		type _4 = Assert<HasKey<B, "errors">>
		type _5 = Assert<HasKey<B, "handler">>
	})

	it("has all methods on .on() builder", () => {
		const b = honey<{}>().on(["GET", "POST"], "/test")
		type B = typeof b
		type _1 = Assert<HasKey<B, "input">>
		type _2 = Assert<HasKey<B, "output">>
		type _3 = Assert<HasKey<B, "meta">>
		type _4 = Assert<HasKey<B, "handler">>
	})
})

describe("route builder lifecycle — .input() one-shot", () => {
	it("input absent after use", () => {
		const b = honey<{}>()
			.get("/test")
			.input({ json: z.object({ name: z.string() }) })
		type B = typeof b
		type _gone = Assert<NotHasKey<B, "input">>
	})

	it("other one-shots still present after .input()", () => {
		const b = honey<{}>()
			.get("/test")
			.input({ json: z.object({ name: z.string() }) })
		type B = typeof b
		type _1 = Assert<HasKey<B, "output">>
		type _2 = Assert<HasKey<B, "meta">>
		type _3 = Assert<HasKey<B, "errors">>
		type _4 = Assert<HasKey<B, "boundary">>
		type _5 = Assert<HasKey<B, "use">>
		type _6 = Assert<HasKey<B, "handler">>
		type _7 = Assert<HasKey<B, "proxy">>
	})
})

describe("route builder lifecycle — .output() one-shot", () => {
	it("output absent after use", () => {
		const b = honey<{}>()
			.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
		type B = typeof b
		type _gone = Assert<NotHasKey<B, "output">>
	})

	it("other one-shots still present after .output()", () => {
		const b = honey<{}>()
			.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
		type B = typeof b
		type _1 = Assert<HasKey<B, "input">>
		type _2 = Assert<HasKey<B, "meta">>
		type _3 = Assert<HasKey<B, "errors">>
		type _4 = Assert<HasKey<B, "handler">>
	})
})

describe("route builder lifecycle — .meta() one-shot", () => {
	it("meta absent after use", () => {
		const b = honey<{}>().get("/test").meta({ summary: "test" })
		type B = typeof b
		type _gone = Assert<NotHasKey<B, "meta">>
	})

	it("other one-shots still present after .meta()", () => {
		const b = honey<{}>().get("/test").meta({ summary: "test" })
		type B = typeof b
		type _1 = Assert<HasKey<B, "input">>
		type _2 = Assert<HasKey<B, "output">>
		type _3 = Assert<HasKey<B, "errors">>
		type _4 = Assert<HasKey<B, "boundary">>
		type _5 = Assert<HasKey<B, "use">>
		type _6 = Assert<HasKey<B, "handler">>
	})
})

describe("route builder lifecycle — .errors() one-shot", () => {
	it("errors absent after use with app error factory", () => {
		const errs = defineErrors({ not_found: "not_found", forbidden: "forbidden" })
		const b = honey<{}>().errorFactory(errs).get("/test").errors("not_found", "forbidden")
		type B = typeof b
		type _gone = Assert<NotHasKey<B, "errors">>
	})

	it("other one-shots still present after .errors()", () => {
		const errs = defineErrors({ not_found: "not_found" })
		const b = honey<{}>().errorFactory(errs).get("/test").errors("not_found")
		type B = typeof b
		type _1 = Assert<HasKey<B, "input">>
		type _2 = Assert<HasKey<B, "output">>
		type _3 = Assert<HasKey<B, "meta">>
		type _4 = Assert<HasKey<B, "boundary">>
		type _5 = Assert<HasKey<B, "handler">>
	})
})

describe("route builder lifecycle — .boundary() one-shot", () => {
	it("boundary absent after use", () => {
		const errs = defineErrors({ internal_server_error: "internal_server_error" })
		const b = honey<{}>().errorFactory(errs).get("/test").boundary("internal_server_error")
		type B = typeof b
		type _gone = Assert<NotHasKey<B, "boundary">>
	})

	it("other one-shots still present after .boundary()", () => {
		const errs = defineErrors({ internal_server_error: "internal_server_error" })
		const b = honey<{}>().errorFactory(errs).get("/test").boundary("internal_server_error")
		type B = typeof b
		type _1 = Assert<HasKey<B, "input">>
		type _2 = Assert<HasKey<B, "output">>
		type _3 = Assert<HasKey<B, "meta">>
		type _4 = Assert<HasKey<B, "handler">>
	})
})

describe("route builder lifecycle — .use() stays multi-call", () => {
	it("use always available regardless of one-shots consumed", () => {
		const mw = createMiddleware(async (_ctx, next) => next({ x: 1 }))
		const b = honey<{}>()
			.get("/test")
			.input({ json: z.object({ n: z.string() }) })
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.meta({ summary: "test" })
			.use(mw)
		type B = typeof b
		type _1 = Assert<HasKey<B, "use">>
		type _2 = Assert<HasKey<B, "handler">>
		type _3 = Assert<HasKey<B, "proxy">>
	})

	it("use available after use (multi-call)", () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ a: 1 }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ b: 2 }))
		const b = honey<{}>().get("/test").use(mw1).use(mw2)
		type B = typeof b
		type _1 = Assert<HasKey<B, "use">>
		type _2 = Assert<HasKey<B, "handler">>
	})
})

describe("route builder lifecycle — chaining propagation", () => {
	it("input stays hidden through .meta() chain", () => {
		const b = honey<{}>()
			.get("/test")
			.input({ json: z.object({ n: z.string() }) })
			.meta({ summary: "x" })
		type B = typeof b
		type _1 = Assert<NotHasKey<B, "input">>
		type _2 = Assert<NotHasKey<B, "meta">>
		type _3 = Assert<HasKey<B, "output">>
		type _4 = Assert<HasKey<B, "handler">>
	})

	it("input stays hidden through .use() chain", () => {
		const mw = createMiddleware(async (_ctx, next) => next())
		const b = honey<{}>()
			.get("/test")
			.input({ json: z.object({ n: z.string() }) })
			.use(mw)
		type B = typeof b
		type _1 = Assert<NotHasKey<B, "input">>
		type _2 = Assert<HasKey<B, "use">>
		type _3 = Assert<HasKey<B, "handler">>
	})

	it("input stays hidden through .errors() chain", () => {
		const errs = defineErrors({ bad_request: "bad_request" })
		const b = honey<{}>()
			.errorFactory(errs)
			.get("/test")
			.input({ json: z.object({ n: z.string() }) })
			.errors("bad_request")
		type B = typeof b
		type _1 = Assert<NotHasKey<B, "input">>
		type _2 = Assert<NotHasKey<B, "errors">>
		type _3 = Assert<HasKey<B, "handler">>
	})

	it("meta stays hidden through .output() chain", () => {
		const b = honey<{}>()
			.get("/test")
			.meta({ summary: "x" })
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
		type B = typeof b
		type _1 = Assert<NotHasKey<B, "meta">>
		type _2 = Assert<NotHasKey<B, "output">>
		type _3 = Assert<HasKey<B, "input">>
		type _4 = Assert<HasKey<B, "handler">>
	})

	it("all one-shots consumed — only use, handler, proxy remain", () => {
		const errs = defineErrors({
			internal_server_error: "internal_server_error",
			not_found: "not_found",
		})
		const b = honey<{}>()
			.errorFactory(errs)
			.get("/test")
			.input({ json: z.object({ n: z.string() }) })
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.meta({ summary: "x" })
			.errors("not_found")
			.boundary("internal_server_error")
		type B = typeof b

		/* all one-shots gone */
		type _1 = Assert<NotHasKey<B, "input">>
		type _2 = Assert<NotHasKey<B, "output">>
		type _3 = Assert<NotHasKey<B, "meta">>
		type _4 = Assert<NotHasKey<B, "errors">>
		type _5 = Assert<NotHasKey<B, "boundary">>

		/* multi-call + terminals remain */
		type _6 = Assert<HasKey<B, "use">>
		type _7 = Assert<HasKey<B, "handler">>
		type _8 = Assert<HasKey<B, "proxy">>
	})
})

describe("route builder lifecycle — handler ctx types still correct", () => {
	it("input types flow through to handler after one-shot", () => {
		honey<{}>()
			.post("/test")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("meta types flow through after one-shot", () => {
		honey<{}>()
			.get("/test")
			.meta({ summary: "hello", tags: "Test" })
			.handler((ctx) => {
				expectTypeOf(ctx.meta).toMatchTypeOf<Readonly<{}>>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("middleware types accumulate after .use()", () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ a: 1 }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ b: "two" }))

		honey<{}>()
			.get("/test")
			.use(mw1)
			.use(mw2)
			.handler((ctx) => {
				expectTypeOf(ctx.a).toEqualTypeOf<number>()
				expectTypeOf(ctx.b).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("params typed from path after all one-shots", () => {
		honey<{}>()
			.get("/users/:id")
			.input({ json: z.object({ name: z.string() }) })
			.meta({ summary: "x" })
			.handler((ctx) => {
				expectTypeOf(ctx.params.id).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("route builder lifecycle — runtime", () => {
	it("full chain with all one-shots produces correct response", async () => {
		const app = honey<{}>()
		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { created: z.object({ id: z.string() }) } })
			.meta({ summary: "Create item" })
			.handler((ctx) => ctx.res.json("created", { id: "i-1" }))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ name: "test" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBe("i-1")
	})

	it("chain with middleware + one-shots works end-to-end", async () => {
		const mw = createMiddleware(async (_ctx, next) => next({ userId: "u-1" }))
		const app = honey<{}>().use(mw)

		app
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.meta({ summary: "Create" })
			.handler((ctx) => ctx.res.json("ok", { name: ctx.input.json.name, user: ctx.userId }))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ name: "item1" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.name).toBe("item1")
		expect(body.user).toBe("u-1")
	})

	it("errors + boundary + handler work together", async () => {
		const errs = defineErrors({
			internal_server_error: "internal_server_error",
			not_found: "not_found",
		})
		const app = honey<{}>().errorFactory(errs)

		app
			.get("/item")
			.errors("not_found")
			.boundary("internal_server_error")
			.handler((ctx) => {
				throw ctx.errors.not_found()
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		expect(res.status).toBe(404)
	})
})
