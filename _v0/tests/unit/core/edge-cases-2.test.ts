import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"
import { createMiddleware } from "../../../src/middleware.ts"
import { parseCookies, validateInput } from "../../../src/validation.ts"

/* ═══════════════════════════════════════════
 * FormData: duplicate keys
 * ═══════════════════════════════════════════ */

describe("FormData duplicate keys", () => {
	const post = (app: { fetch: (r: Request, e: {}) => Promise<Response> }, fd: FormData) =>
		app.fetch(new Request("http://localhost/form", { body: fd, method: "POST" }), {})

	it("a scalar field takes the first value, like ctx.search and cookies", async () => {
		const app = honey<{}>()
		app
			.post("/form")
			.input({ form: z.object({ role: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const fd = new FormData()
		fd.append("role", "user")
		fd.append("role", "admin")

		const res = await post(app, fd)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, Record<string, string>>
		expect(data.form.role).toBe("user")
	})

	it("an array field always gets an array, so one or many files validate", async () => {
		const app = honey<{}>()
		app
			.post("/form")
			.input({ form: z.object({ files: z.array(z.instanceof(File)) }) })
			.handler((ctx) => ctx.res.json("created", { n: ctx.input.form.files.length }))

		const one = new FormData()
		one.append("files", new File(["a"], "a.txt"))
		const r1 = await post(app, one)
		expect(r1.status).toBe(201)
		expect(await r1.json()).toEqual({ n: 1 })

		const two = new FormData()
		two.append("files", new File(["a"], "a.txt"))
		two.append("files", new File(["b"], "b.txt"))
		const r2 = await post(app, two)
		expect(r2.status).toBe(201)
		expect(await r2.json()).toEqual({ n: 2 })
	})

	it("an untyped key repeats into an array (schema without Standard JSON Schema)", async () => {
		const passthrough = { "~standard": { validate: (v: unknown) => ({ value: v }), vendor: "test", version: 1 } }
		const fd = new FormData()
		fd.append("tag", "a")
		fd.append("tag", "b")
		fd.append("one", "x")
		const result = await validateInput(
			{ form: passthrough },
			new Request("http://localhost/form", { body: fd, method: "POST" }),
			{},
		)
		expect(result.form).toEqual({ one: "x", tag: ["a", "b"] })
	})
})

/* ═══════════════════════════════════════════
 * Cookie parsing: malformed percent encoding
 * ═══════════════════════════════════════════ */

describe("parseCookies: malformed values", () => {
	it("trailing percent sign → returns raw value", () => {
		const result = parseCookies("tok=abc%")
		expect(result.tok).toBe("abc%")
	})

	it("invalid percent sequence → returns raw value", () => {
		const result = parseCookies("tok=abc%ZZdef")
		expect(result.tok).toBe("abc%ZZdef")
	})

	it("mixed valid and invalid encoding → decodes valid, keeps rest raw", () => {
		/* %20 is valid, %ZZ is not — but tryDecode is all-or-nothing per value */
		const result = parseCookies("tok=hello%ZZworld")
		expect(result.tok).toBe("hello%ZZworld")
	})

	it("empty cookie value", () => {
		const result = parseCookies("sid=")
		expect(result.sid).toBe("")
	})

	it("cookie with no equals sign → skipped", () => {
		const result = parseCookies("noequals; valid=yes")
		expect(result.valid).toBe("yes")
		expect(result.noequals).toBeUndefined()
	})

	it("cookie with multiple equals → value includes extra equals", () => {
		const result = parseCookies("data=a=b=c")
		expect(result.data).toBe("a=b=c")
	})
})

/* ═══════════════════════════════════════════
 * URL-encoded body: empty key, special chars
 * ═══════════════════════════════════════════ */

describe("validation: URL-encoded edge cases", () => {
	it("empty key in URL-encoded body is parsed", async () => {
		const schema = {
			"~standard": {
				validate: (data: unknown) => ({ value: data }),
				vendor: "test",
				version: 1,
			},
		}
		const req = new Request("http://localhost/test", {
			body: "=emptykey&name=Alice",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
		})
		const result = await validateInput({ form: schema }, req, {})
		const form = result.form as Record<string, string>
		expect(form.name).toBe("Alice")
		/* URLSearchParams includes empty string key */
		expect(form[""]).toBe("emptykey")
	})

	it("plus sign decoded as space in URL-encoded body", async () => {
		const schema = {
			"~standard": {
				validate: (data: unknown) => ({ value: data }),
				vendor: "test",
				version: 1,
			},
		}
		const req = new Request("http://localhost/test", {
			body: "greeting=hello+world",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
		})
		const result = await validateInput({ form: schema }, req, {})
		const form = result.form as Record<string, string>
		expect(form.greeting).toBe("hello world")
	})
})

/* ═══════════════════════════════════════════
 * Middleware: throws non-Error value
 * ═══════════════════════════════════════════ */

describe("middleware: throws non-Error values", () => {
	it("middleware throws string → 500", async () => {
		const mw = createMiddleware(async () => {
			throw "string error"
		})

		const app = honey<{}>()
		app
			.get("/test")
			.use(mw)
			.handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})

	it("middleware throws number → 500", async () => {
		const mw = createMiddleware(async () => {
			throw 42
		})

		const app = honey<{}>()
		app
			.get("/test")
			.use(mw)
			.handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})

	it("middleware throws null → 500", async () => {
		const mw = createMiddleware(async () => {
			throw null
		})

		const app = honey<{}>()
		app
			.get("/test")
			.use(mw)
			.handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
	})
})

/* ═══════════════════════════════════════════
 * HEAD with output validation
 * ═══════════════════════════════════════════ */

describe("HEAD + output validation", () => {
	it("HEAD request runs output validation then strips body", async () => {
		const app = honey<{}>().outputValidation("always")
		app
			.get("/data")
			.output({ "application/json": { ok: z.object({ id: z.number() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: 1 }))

		const res = await app.fetch(new Request("http://localhost/data", { method: "HEAD" }), {})
		/* should succeed — output is valid, then body stripped for HEAD */
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toBe("")
		expect(res.headers.get("content-type")).toContain("application/json")
	})
})

/* ═══════════════════════════════════════════
 * 404 handler sees chain middleware context
 * ═══════════════════════════════════════════ */

describe("404 handler", () => {
	it("custom onNotFound returns custom response", async () => {
		const app = honey<{}>().onNotFound(() => {
			return new Response(JSON.stringify({ custom: true }), {
				headers: { "content-type": "application/json" },
				status: 404,
			})
		})
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.custom).toBe(true)
	})

	it("default 404 returns JSON with error_key", async () => {
		const app = honey<{}>()
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("not_found")
	})
})
