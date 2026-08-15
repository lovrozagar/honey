import { describe, expect, it, vi } from "vitest"
import { HoneyContext } from "../../../src/context.ts"
import { HoneyError } from "../../../src/error.ts"
import { createMiddleware, honey } from "../../../src/index.ts"
import { createErrorResponse } from "../../../src/response.ts"

function makeCtx(
	url = "http://localhost/test",
	opts?: { headers?: Record<string, string>; method?: string },
): HoneyContext {
	const req = new Request(url, {
		headers: opts?.headers,
		method: opts?.method,
	})
	return new HoneyContext({
		env: {},
		params: {},
		req,
	})
}

describe("HoneyContext — lazy parsing", () => {
	it("search built from URL on first access, cached (first value per key)", () => {
		const ctx = makeCtx("http://localhost/test?a=1&b=2")
		const first = ctx.search
		expect(first).toEqual({ a: "1", b: "2" })
		expect(ctx.search).toBe(first)
	})

	it("headers lowercased on first access, cached", () => {
		const ctx = makeCtx("http://localhost/test", {
			headers: { "X-Custom": "val" },
		})
		const first = ctx.headers
		expect(first["x-custom"]).toBe("val")
		expect(ctx.headers).toBe(first)
	})

	it("cookies parsed on first access, cached", () => {
		const ctx = makeCtx("http://localhost/test", {
			headers: { cookie: "a=1; b=2" },
		})
		const first = ctx.cookies
		expect(first).toEqual({ a: "1", b: "2" })
		expect(ctx.cookies).toBe(first)
	})
})

describe("HoneyContext — background", () => {
	it("delegates to executionCtx.waitUntil", () => {
		const waitUntil = vi.fn<(p: Promise<unknown>) => void>()
		const req = new Request("http://localhost/test")
		const ctx = new HoneyContext({
			env: {},
			executionCtx: { waitUntil },
			params: {},
			req,
		})
		const p = Promise.resolve()
		ctx.background(p)
		expect(waitUntil).toHaveBeenCalledWith(p)
	})

	it("fire-and-forget without waitUntil", () => {
		const ctx = makeCtx()
		expect(() => ctx.background(Promise.reject(new Error("test")))).not.toThrow()
	})
})

describe("HoneyContext — response helpers", () => {
	it("json(ok, data) → 200 application/json", () => {
		const ctx = makeCtx()
		const res = ctx.res.json("ok", { id: 1 })
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json")
	})

	it("json(created, data) → 201", () => {
		const ctx = makeCtx()
		expect(ctx.res.json("created", {}).status).toBe(201)
	})

	it("json with custom headers", async () => {
		const ctx = makeCtx()
		const res = ctx.res.json("ok", {}, { headers: { "x-custom": "val" } })
		expect(res.headers.get("x-custom")).toBe("val")
	})

	it("text(hello) → 200 text/plain", async () => {
		const ctx = makeCtx()
		const res = ctx.res.text("ok", "hello")
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/plain")
		expect(await res.text()).toBe("hello")
	})

	it("noContent → 204", () => {
		const ctx = makeCtx()
		const res = ctx.res.noContent()
		expect(res.status).toBe(204)
	})

	it("redirect(/x) → 302", () => {
		const ctx = makeCtx()
		const res = ctx.res.redirect("/x")
		expect(res.status).toBe(302)
		expect(res.headers.get("location")).toBe("/x")
	})

	it("redirect with status 307", () => {
		const ctx = makeCtx()
		const res = ctx.res.redirect("/x", { status: 307 })
		expect(res.status).toBe(307)
	})

	it("html → 200 text/html", async () => {
		const ctx = makeCtx()
		const res = ctx.res.html("ok", "<h1>hi</h1>")
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/html")
		expect(await res.text()).toBe("<h1>hi</h1>")
	})

	it("cookie serialization", () => {
		const ctx = makeCtx()
		const res = ctx.res.json(
			"ok",
			{},
			{
				cookies: {
					session: {
						domain: ".example.com",
						httpOnly: true,
						maxAge: 86400,
						path: "/",
						sameSite: "strict",
						secure: true,
						value: "abc",
					},
				},
			},
		)
		const cookie = res.headers.get("set-cookie")
		expect(cookie).toContain("session=abc")
		expect(cookie).toContain("HttpOnly")
		expect(cookie).toContain("Secure")
		expect(cookie).toContain("Max-Age=86400")
		expect(cookie).toContain("SameSite=Strict")
		expect(cookie).toContain("Domain=.example.com")
		expect(cookie).toContain("Path=/")
	})

	it("cookie deletion: maxAge 0", () => {
		const ctx = makeCtx()
		const res = ctx.res.json(
			"ok",
			{},
			{
				cookies: { session: { maxAge: 0, value: "" } },
			},
		)
		expect(res.headers.get("set-cookie")).toContain("Max-Age=0")
	})

	it("createErrorResponse", async () => {
		const err = new HoneyError({ errorKey: "not_found", status: "not_found" })
		const res = createErrorResponse(err, (_e, shape) => shape)
		expect(res.status).toBe(404)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.success).toBe(false)
		expect(body.error_key).toBe("not_found")
	})
})

describe("HoneyContext — streaming", () => {
	it("stream callback provides writable", async () => {
		const ctx = makeCtx()
		const res = ctx.res.stream(async (writable) => {
			const writer = writable.getWriter()
			await writer.write(new TextEncoder().encode("chunk1"))
			await writer.close()
		})
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toBe("chunk1")
	})

	it("sse with correct content-type", async () => {
		const ctx = makeCtx()
		const res = ctx.res.sse(async (stream) => {
			stream.send({ data: { msg: "hello" }, event: "test", id: "1", retry: 5000 })
			stream.close()
		})
		expect(res.headers.get("content-type")).toBe("text/event-stream")
		const text = await res.text()
		expect(text).toContain("event: test")
		expect(text).toContain('data: {"msg":"hello"}')
		expect(text).toContain("id: 1")
		expect(text).toContain("retry: 5000")
	})
})

describe("honey() — full request flow", () => {
	it("GET /health → 200", async () => {
		const h = honey<{}>()
		h.get("/health").handler((ctx) => ctx.res.json("ok", { status: "healthy" }))

		const res = await h.fetch(new Request("http://localhost/health"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.status).toBe("healthy")
	})

	it("404 for unknown path", async () => {
		const h = honey<{}>()
		h.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/missing"), {})
		expect(res.status).toBe(404)
	})

	it("405 for wrong method with Allow header", async () => {
		const h = honey<{}>()
		h.get("/items").handler((ctx) => ctx.res.text("ok", "ok"))
		h.post("/items").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/items", { method: "DELETE" }), {})
		expect(res.status).toBe(405)
		expect(res.headers.get("allow")).toContain("GET")
		expect(res.headers.get("allow")).toContain("POST")
	})

	it("error flow: handler throws HoneyError → formatted response", async () => {
		const h = honey<{}>()
		h.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "org_slug_taken", status: "conflict" })
		})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(409)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("org_slug_taken")
	})

	it("error flow: unknown error → 500", async () => {
		const h = honey<{}>()
		h.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("internal_server_error")
	})

	it("error flow: string throw → 500", async () => {
		const h = honey<{}>()
		h.get("/fail").handler(() => {
			throw "string error"
		})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
	})

	it("runtime enforcement: undeclared error key → 500", async () => {
		const h = honey<{}>()
		const errFactory = {
			allowed_error: () => new HoneyError({ errorKey: "allowed_error", status: "conflict" }),
		}
		h.get("/fail")
			.errors(errFactory, "allowed_error")
			.handler(() => {
				throw new HoneyError({ errorKey: "not_declared", status: "conflict" })
			})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("internal_server_error")
	})

	it(".all() route matches multiple methods", async () => {
		const h = honey<{}>()
		h.all("/catch").handler((ctx) => ctx.res.text("ok", "caught"))

		for (const method of ["GET", "POST", "PUT", "DELETE"]) {
			const res = await h.fetch(new Request("http://localhost/catch", { method }), {})
			expect(res.status).toBe(200)
		}
	})

	it("errorFormatter shapes response body", async () => {
		const h = honey<{}>()
		h.defaultErrorFormatter((_error, shape) => ({
			...shape,
			request_id: "test-123",
		}))
		h.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "bad_request", status: "bad_request" })
		})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.request_id).toBe("test-123")
		expect(body.success).toBe(false)
	})

	it("errorFormatter: cause NOT in defaultShape", async () => {
		const h = honey<{}>()
		let receivedShape: Record<string, unknown> = {}
		h.defaultErrorFormatter((_error, shape) => {
			receivedShape = shape
			return shape
		})
		h.get("/fail").handler(() => {
			throw new HoneyError({ cause: new Error("secret"), errorKey: "test", status: "bad_request" })
		})

		await h.fetch(new Request("http://localhost/fail"), {})
		expect(receivedShape).not.toHaveProperty("cause")
	})

	it("trailing slash strip → 308 redirect", async () => {
		const h = honey<{}>()
		h.trailingSlash("strip")
		h.get("/foo").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/foo/"), {})
		expect(res.status).toBe(308)
		expect(res.headers.get("location")).toContain("/foo")
	})

	it("trailing slash enforce → 308 redirect", async () => {
		const h = honey<{}>()
		h.trailingSlash("enforce")
		h.get("/foo/").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/foo"), {})
		expect(res.status).toBe(308)
		expect(res.headers.get("location")).toContain("/foo/")
	})
})

describe("middleware chain", () => {
	it("3 middlewares execute in correct order", async () => {
		const order: number[] = []
		const h = honey<{}>()

		const mw1 = createMiddleware(async (_ctx, next) => {
			order.push(1)
			const res = await next()
			order.push(6)
			return res
		})
		const mw2 = createMiddleware(async (_ctx, next) => {
			order.push(2)
			const res = await next()
			order.push(5)
			return res
		})
		const mw3 = createMiddleware(async (_ctx, next) => {
			order.push(3)
			const res = await next()
			order.push(4)
			return res
		})

		const chain = h.use(mw1).use(mw2).use(mw3)
		chain.get("/test").handler((ctx) => {
			order.push(0)
			return ctx.res.text("ok", "ok")
		})

		await h.fetch(new Request("http://localhost/test"), {})
		expect(order).toEqual([1, 2, 3, 0, 4, 5, 6])
	})

	it("middleware short-circuit", async () => {
		const h = honey<{}>()
		let handlerCalled = false

		const mw = createMiddleware(async (_ctx, _next) => {
			return new Response("cached", { status: 200 })
		})

		const chain = h.use(mw)
		chain.get("/test").handler((ctx) => {
			handlerCalled = true
			return ctx.res.text("ok", "fresh")
		})

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(await res.text()).toBe("cached")
		expect(handlerCalled).toBe(false)
	})

	it("middleware next with additions", async () => {
		const h = honey<{}>()

		const withDb = createMiddleware(async (_ctx, next) => next({ db: "connected" }))

		const chain = h.use(withDb)
		chain.get("/test").handler((ctx) => {
			return ctx.res.text("ok", ctx.db)
		})

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(await res.text()).toBe("connected")
	})
})

describe("telemetry", () => {
	it("onRequest called before routing", async () => {
		const h = honey<{}>()
		let called = false
		h.telemetry({
			onRequest: () => {
				called = true
			},
		})
		h.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		await h.fetch(new Request("http://localhost/test"), {})
		expect(called).toBe(true)
	})

	it("onNotFound called for 404", async () => {
		const h = honey<{}>()
		let called = false
		h.telemetry({
			onNotFound: () => {
				called = true
			},
		})

		await h.fetch(new Request("http://localhost/missing"), {})
		expect(called).toBe(true)
	})

	it("onResponse called for every request", async () => {
		const h = honey<{}>()
		let count = 0
		h.telemetry({
			onResponse: () => {
				count++
			},
		})
		h.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		await h.fetch(new Request("http://localhost/test"), {})
		await h.fetch(new Request("http://localhost/missing"), {})
		expect(count).toBe(2)
	})

	it("adapter that throws doesn't crash request", async () => {
		const h = honey<{}>()
		h.telemetry({
			onRequest: () => {
				throw new Error("telemetry boom")
			},
		})
		h.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})

	it("onMiddleware fires per middleware with name + duration", async () => {
		const h = honey<{}>()
		const calls: Array<{ duration: number; name: string }> = []
		h.telemetry({
			onMiddleware: (ctx) => {
				calls.push({ duration: ctx.duration, name: ctx.name })
			},
		})

		const namedMw = createMiddleware(async function logger(_ctx, next) {
			return next()
		})
		const chain = h.use(namedMw)
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		await h.fetch(new Request("http://localhost/test"), {})
		expect(calls).toHaveLength(1)
		expect(calls[0].name).toBe("logger")
		expect(calls[0].duration).toBeGreaterThanOrEqual(0)
	})

	it("onMiddleware receives error on middleware failure", async () => {
		const h = honey<{}>()
		const calls: Array<{ error?: unknown; name: string }> = []
		h.telemetry({
			onMiddleware: (ctx) => {
				calls.push({ error: ctx.error, name: ctx.name })
			},
		})

		const failMw = createMiddleware(async function failingMw(_ctx, _next) {
			throw new Error("mw boom")
		})
		const chain = h.use(failMw)
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		await h.fetch(new Request("http://localhost/test"), {})
		expect(calls).toHaveLength(1)
		expect(calls[0].name).toBe("failingMw")
		expect(calls[0].error).toBeInstanceOf(Error)
	})

	it("onError receives HoneyError for unknown errors", async () => {
		const h = honey<{}>()
		let receivedError = null as HoneyError | null
		h.telemetry({
			onError: (ctx) => {
				receivedError = ctx.error
			},
		})
		h.get("/fail").handler(() => {
			throw new Error("raw")
		})

		await h.fetch(new Request("http://localhost/fail"), {})
		expect(receivedError).toBeInstanceOf(HoneyError)
		expect(receivedError?.errorKey).toBe("internal_server_error")
	})
})

describe("errorI18n", () => {
	it("translates HoneyError message via i18n", async () => {
		const h = honey<{}>()
		h.errorI18n({
			errors: {
				en: { org_slug_taken: "Slug {slug} is taken" },
			},
			resolveLocale: () => "en",
		})
		h.get("/fail").handler(() => {
			throw new HoneyError({
				errorKey: "org_slug_taken",
				status: "conflict",
				vars: { slug: "my-org" },
			})
		})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.message).toBe("Slug my-org is taken")
	})

	it("field names translated when fieldNames configured", async () => {
		const h = honey<{}>()
		h.errorI18n({
			fieldNames: {
				en: { "json.email": "Email Address" },
			},
			resolveLocale: () => "en",
		})
		h.get("/fail").handler(() => {
			throw new HoneyError({
				errorKey: "validation_failed",
				fields: {
					email: [{ error_key: "field_required", message: "Required", path: "json.email" }],
				},
				status: "bad_request",
			})
		})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		const body = (await res.json()) as Record<string, unknown>
		const fields = body.fields as Record<string, Array<Record<string, unknown>>>
		expect(fields.email[0].path).toBe("Email Address")
	})

	it("field names untranslated when no matching locale", async () => {
		const h = honey<{}>()
		h.errorI18n({
			fieldNames: {
				de: { "json.email": "E-Mail-Adresse" },
			},
			resolveLocale: () => "en",
		})
		h.get("/fail").handler(() => {
			throw new HoneyError({
				errorKey: "validation_failed",
				fields: {
					email: [{ error_key: "field_required", message: "Required", path: "json.email" }],
				},
				status: "bad_request",
			})
		})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		const body = (await res.json()) as Record<string, unknown>
		const fields = body.fields as Record<string, Array<Record<string, unknown>>>
		expect(fields.email[0].path).toBe("json.email")
	})

	it("falls back to errorKey when no translation", async () => {
		const h = honey<{}>()
		h.errorI18n({
			errors: { en: {} },
			resolveLocale: () => "en",
		})
		h.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "unknown_key", status: "bad_request" })
		})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		const body = (await res.json()) as Record<string, unknown>
		expect(body.message).toBe("unknown_key")
	})
})

describe("global vs chain .use()", () => {
	it("chain .use() with context additions returns new instance", () => {
		const h = honey<{}>()
		const chainMw = createMiddleware(async (_ctx, next) => {
			return next({ db: "pg" })
		})
		const chain = h.use(chainMw)
		expect(chain).not.toBe(h)
	})

	it("chain .use() middleware runs on routes registered on the chain", async () => {
		const h = honey<{}>()
		let mwCalled = false
		const chainMw = createMiddleware(async (_ctx, next) => {
			mwCalled = true
			return next({ db: "pg" })
		})
		const chain = h.use(chainMw)
		chain.get("/test").handler((ctx) => ctx.res.text("ok", ctx.db))

		await h.fetch(new Request("http://localhost/test"), {})
		expect(mwCalled).toBe(true)
	})

	it("no-context middleware still works via chain", async () => {
		const h = honey<{}>()
		let mwCalled = false
		const globalMw = createMiddleware(async (_ctx, next) => {
			mwCalled = true
			return next()
		})
		const chain = h.use(globalMw)
		chain.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		await h.fetch(new Request("http://localhost/test"), {})
		expect(mwCalled).toBe(true)
	})
})

describe("meta shallow merge", () => {
	it("two .meta() calls merge keys from both", async () => {
		const h = honey<{}>().meta<{ deprecated?: boolean; tags?: string[] }>()
		h.get("/test")
			.meta({ tags: ["user"] })
			.meta({ deprecated: true })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const tree = (h as unknown as { _tree: import("../../../src/tree.ts").TreeNode })._tree
		const handler = tree.s["test"]?.m?.GET
		expect(handler?.mt).toEqual({ deprecated: true, tags: ["user"] })
	})
})

describe("ctx.search multi-value support", () => {
	it("search returns first value, searchAll returns all", () => {
		const ctx = makeCtx("http://localhost/test?tag=a&tag=b&page=1")
		expect(ctx.search.tag).toBe("a")
		expect(ctx.search.page).toBe("1")
		expect(ctx.searchAll.tag).toEqual(["a", "b"])
		expect(ctx.searchAll.page).toEqual(["1"])
	})
})

describe("logger integration", () => {
	it("logger.warn called when telemetry adapter throws", async () => {
		const warn = vi.fn<(msg: string, err: unknown) => void>()
		const h = honey<{}>()
		h.logger({ warn })
		h.telemetry({
			onRequest() {
				throw new Error("telemetry boom")
			},
		})
		h.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(warn).toHaveBeenCalledWith("telemetry callback failed", expect.any(Error))
	})

	it("logger.warn called when i18n resolution throws", async () => {
		const warn = vi.fn<(msg: string, err: unknown) => void>()
		const h = honey<{}>()
		h.logger({ warn })
		h.errorI18n({
			resolveLocale() {
				throw new Error("locale boom")
			},
		})
		h.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "test_err", status: "bad_request" })
		})

		const res = await h.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(400)
		expect(warn).toHaveBeenCalledWith("i18n resolution failed", expect.any(Error))
	})

	it("no logger configured → errors still swallowed silently", async () => {
		const h = honey<{}>()
		h.telemetry({
			onRequest() {
				throw new Error("telemetry boom")
			},
		})
		h.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})
})
