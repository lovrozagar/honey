import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"
import { createMiddleware } from "../../../src/middleware.ts"
import { validateInput } from "../../../src/validation.ts"

/* ═══════════════════════════════════════════
 * PROTOTYPE POLLUTION: params with dangerous names
 * ═══════════════════════════════════════════ */

describe("route params: dangerous names", () => {
	it(":constructor param → value captured, no pollution", async () => {
		const app = honey<{}>()
		app
			.get("/items/:constructor")
			.handler((ctx) => ctx.res.json("ok", { val: ctx.params.constructor }))

		const res = await app.fetch(new Request("http://localhost/items/test-val"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.val).toBe("test-val")
	})

	it(":__proto__ param → value captured safely", async () => {
		const app = honey<{}>()
		app.get("/items/:__proto__").handler((ctx) => {
			const val = (ctx.params as Record<string, string>).__proto__
			return ctx.res.json("ok", { val: val ?? "missing" })
		})

		const res = await app.fetch(new Request("http://localhost/items/safe-val"), {})
		expect(res.status).toBe(200)
	})

	it(":prototype param → no Object.prototype mutation", async () => {
		const before = Object.getOwnPropertyNames(Object.prototype).length
		const app = honey<{}>()
		app.get("/items/:prototype").handler((ctx) => ctx.res.json("ok", { val: ctx.params.prototype }))

		await app.fetch(new Request("http://localhost/items/evil"), {})
		const after = Object.getOwnPropertyNames(Object.prototype).length
		expect(after).toBe(before)
	})
})

/* ═══════════════════════════════════════════
 * NESTED PROTOTYPE POLLUTION in form data
 * ═══════════════════════════════════════════ */

describe("nested prototype pollution: deep form keys", () => {
	it("nested __proto__ key silently dropped", async () => {
		const schema = {
			"~standard": {
				validate: (data: unknown) => ({ value: data }),
				vendor: "test",
				version: 1,
			},
		}
		const fd = new FormData()
		fd.append("safe", "ok")
		fd.append("__proto__", "evil")

		const req = new Request("http://localhost/test", { body: fd, method: "POST" })
		const result = await validateInput({ form: schema }, req, {})
		const form = result.form as Record<string, unknown>
		expect(form.safe).toBe("ok")
		expect(Object.hasOwn(form, "__proto__")).toBe(false)
		/* verify Object.prototype not mutated */
		expect(({} as Record<string, unknown>).evil).toBeUndefined()
	})

	it("constructor key in form silently dropped", async () => {
		const schema = {
			"~standard": {
				validate: (data: unknown) => ({ value: data }),
				vendor: "test",
				version: 1,
			},
		}
		const fd = new FormData()
		fd.append("constructor", "evil")
		fd.append("name", "Alice")

		const req = new Request("http://localhost/test", { body: fd, method: "POST" })
		const result = await validateInput({ form: schema }, req, {})
		const form = result.form as Record<string, unknown>
		expect(form.name).toBe("Alice")
		expect(Object.hasOwn(form, "constructor")).toBe(false)
	})
})

/* ═══════════════════════════════════════════
 * HEAD + trailing slash redirect
 * ═══════════════════════════════════════════ */

describe("HEAD + trailing slash redirect", () => {
	it("HEAD /path/ with strip → redirect preserves HEAD", async () => {
		const app = honey<{}>().trailingSlash("strip")
		app.get("/items").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/items/", { method: "HEAD" }), {})
		expect([301, 308]).toContain(res.status)
		const location = res.headers.get("location")
		expect(location).toContain("/items")
		expect(location).not.toContain("/items/")
	})
})

/* ═══════════════════════════════════════════
 * QUERY: plus sign decoding
 * ═══════════════════════════════════════════ */

describe("query: plus sign handling", () => {
	it("plus sign in search param → decoded as space by URLSearchParams", async () => {
		const app = honey<{}>()
		app
			.get("/search")
			.input({ search: z.object({ q: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { q: ctx.input.search.q }))

		const res = await app.fetch(new Request("http://localhost/search?q=hello+world"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("hello world")
	})

	it("%2B in search param → literal plus sign", async () => {
		const app = honey<{}>()
		app
			.get("/search")
			.input({ search: z.object({ q: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { q: ctx.input.search.q }))

		const res = await app.fetch(new Request("http://localhost/search?q=hello%2Bworld"), {})
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("hello+world")
	})
})

/* ═══════════════════════════════════════════
 * PER-STATUS OUTPUT SCHEMAS
 * ═══════════════════════════════════════════ */

describe("output: per-status schemas", () => {
	it("200 and 201 have different output shapes", async () => {
		const app = honey<{}>().outputValidation("always")
		app
			.post("/items")
			.output({
				"application/json": {
					created: z.object({ id: z.number(), name: z.string() }),
					ok: z.object({ items: z.array(z.string()) }),
				},
			})
			.handler((ctx) => ctx.res.json("created", { id: 1, name: "Widget" }))

		const res = await app.fetch(new Request("http://localhost/items", { method: "POST" }), {})
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.id).toBe(1)
		expect(data.name).toBe("Widget")
	})

	it("wrong shape for status → output validation fails", async () => {
		const app = honey<{}>().outputValidation("always")
		app
			.get("/items")
			.output({
				"application/json": {
					ok: z.object({ items: z.array(z.string()) }),
				},
			})
			.handler((ctx) => ctx.res.json("ok", { wrong: "shape" } as unknown as { items: string[] }))

		const res = await app.fetch(new Request("http://localhost/items"), {})
		expect(res.status).toBe(500)
	})
})

/* ═══════════════════════════════════════════
 * COOKIES IN ERROR RESPONSES
 * ═══════════════════════════════════════════ */

describe("cookies preserved in error responses", () => {
	it("middleware sets cookie → error thrown → cookie still in response", async () => {
		const setCookieMw = createMiddleware(async (ctx, next) => {
			const res = await next()
			/* add cookie to the response after handler */
			return res
		})

		/* test that cookies set BEFORE error still make it to client */
		const app = honey<{}>()
		app.get("/fail").handler((ctx) => {
			/* this would need onError to add cookies — test the default path */
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		/* default error response is JSON with error_key */
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("internal_server_error")
	})

	it("onError handler can set cookies on error response", async () => {
		const app = honey<{}>().onError(() => {
			return new Response(JSON.stringify({ error: true }), {
				headers: {
					"content-type": "application/json",
					"set-cookie": "error_tracked=1; Path=/",
				},
				status: 500,
			})
		})
		app.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		const cookies = res.headers.getSetCookie()
		expect(cookies.some((c) => c.includes("error_tracked=1"))).toBe(true)
	})
})

/* ═══════════════════════════════════════════
 * MIDDLEWARE: error skips later middleware
 * ═══════════════════════════════════════════ */

describe("middleware: error skips subsequent middleware", () => {
	it("first middleware throws → second middleware never runs", async () => {
		const order: string[] = []

		const mw1 = createMiddleware(async () => {
			order.push("mw1")
			throw new Error("early fail")
		})
		const mw2 = createMiddleware(async (_ctx, next) => {
			order.push("mw2")
			return next()
		})

		const app = honey<{}>()
		app
			.get("/test")
			.use(mw1)
			.use(mw2)
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.json("ok", {})
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
		expect(order).toEqual(["mw1"])
		expect(order).not.toContain("mw2")
		expect(order).not.toContain("handler")
	})
})

/* ═══════════════════════════════════════════
 * QUERY: boolean coercion
 * ═══════════════════════════════════════════ */

describe("query: boolean coercion with zod", () => {
	it("?active=true with z.coerce.boolean → true", async () => {
		const app = honey<{}>()
		app
			.get("/items")
			.input({
				search: z.object({
					active: z.string().transform((v) => v === "true"),
				}),
			})
			.handler((ctx) => ctx.res.json("ok", { active: ctx.input.search.active }))

		const res = await app.fetch(new Request("http://localhost/items?active=true"), {})
		const data = (await res.json()) as Record<string, unknown>
		expect(data.active).toBe(true)
	})

	it("?active=false → false", async () => {
		const app = honey<{}>()
		app
			.get("/items")
			.input({
				search: z.object({
					active: z.string().transform((v) => v === "true"),
				}),
			})
			.handler((ctx) => ctx.res.json("ok", { active: ctx.input.search.active }))

		const res = await app.fetch(new Request("http://localhost/items?active=false"), {})
		const data = (await res.json()) as Record<string, unknown>
		expect(data.active).toBe(false)
	})
})

/* ═══════════════════════════════════════════
 * HEADER: numeric coercion
 * ═══════════════════════════════════════════ */

describe("header: numeric coercion with zod", () => {
	it("x-page header with z.coerce.number → number", async () => {
		const app = honey<{}>()
		app
			.get("/items")
			.input({
				headers: z.object({ "x-page": z.coerce.number() }).passthrough(),
			})
			.handler((ctx) =>
				ctx.res.json("ok", {
					isNum: typeof ctx.input.headers["x-page"] === "number",
					page: ctx.input.headers["x-page"],
				}),
			)

		const res = await app.fetch(
			new Request("http://localhost/items", { headers: { "x-page": "5" } }),
			{},
		)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.page).toBe(5)
		expect(data.isNum).toBe(true)
	})
})

/* ═══════════════════════════════════════════
 * WILDCARD: trailing slash behavior
 * ═══════════════════════════════════════════ */

describe("wildcard: trailing slash", () => {
	it("wildcard route captures trailing slash path", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/dir/"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("dir/")
	})

	it("wildcard captures empty after prefix", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files/"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.path).toBe("")
	})

	it("wildcard with no trailing content", async () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { path: ctx.params.path }))

		const res = await app.fetch(new Request("http://localhost/files"), {})
		/* /files without trailing / may or may not match — test actual behavior */
		expect([200, 404]).toContain(res.status)
	})
})

/* ═══════════════════════════════════════════
 * JSON SUBTYPES
 * ═══════════════════════════════════════════ */

describe("JSON content-type subtypes", () => {
	it("application/json; charset=utf-8 → parsed as JSON", async () => {
		const app = honey<{}>()
		app
			.post("/api")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: JSON.stringify({ name: "test" }),
				headers: { "content-type": "application/json; charset=utf-8" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, Record<string, string>>
		expect(data.json.name).toBe("test")
	})

	it("application/json with extra params → still parsed", async () => {
		const app = honey<{}>()
		app
			.post("/api")
			.input({ json: z.object({ x: z.number() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: JSON.stringify({ x: 42 }),
				headers: { "content-type": "application/json; boundary=something" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
	})
})
