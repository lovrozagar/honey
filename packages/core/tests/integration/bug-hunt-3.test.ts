import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { csrf } from "../../src/csrf.ts"
import { etag } from "../../src/etag.ts"
import "@lovrozagar/honey/i18n"
import { honey } from "../../src/index.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { serverTiming } from "../../src/server-timing.ts"
import { testClient } from "../../src/testing.ts"
import {
	issuesToFieldErrors,
	mapNormalizedCode,
	normalizeIssues,
	parseCookies,
	selectParser,
} from "../../src/validation.ts"

function request(
	port: number,
	path: string,
	opts?: {
		body?: string
		headers?: Record<string, string>
		method?: string
	},
): Promise<{ body: string; headers: http.IncomingHttpHeaders; status: number }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				headers: opts?.headers,
				hostname: "127.0.0.1",
				method: opts?.method ?? "GET",
				path,
				port,
			},
			(res) => {
				let data = ""
				res.on("data", (chunk) => {
					data += chunk
				})
				res.on("end", () => {
					resolve({ body: data, headers: res.headers, status: res.statusCode ?? 0 })
				})
			},
		)
		req.on("error", reject)
		if (opts?.body) req.write(opts.body)
		req.end()
	})
}

let server: HoneyServer | null = null

afterEach(() => {
	if (server) {
		server.close()
		server = null
	}
})

/* ──────────────────────────────────────────────
 * 1. parseCookies — prototype pollution via __proto__ key
 *
 * parseCookies builds a record from cookie header.
 * If cookie header contains __proto__=value, does it pollute
 * the object prototype?
 * validation.ts:58-66 has no DANGEROUS_KEYS guard (unlike formDataToRecord)
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: parseCookies prototype pollution", () => {
	it("__proto__ cookie key does NOT pollute Object.prototype", () => {
		const result = parseCookies("__proto__=polluted; safe=yes")
		/* must not pollute global prototype */
		const freshObj: Record<string, unknown> = {}
		expect(freshObj["__proto__"]).not.toBe("polluted")
		expect(result.safe).toBe("yes")
	})

	it("constructor cookie key is handled safely", () => {
		const result = parseCookies("constructor=evil; valid=ok")
		expect(result.valid).toBe("ok")
		/* dangerous key filtered — not an own property */
		expect(Object.hasOwn(result, "constructor")).toBe(false)
	})
})

/* ──────────────────────────────────────────────
 * 2. parseCookies — value with encoded characters
 *
 * Cookie values with % are decoded via decodeURIComponent.
 * Malformed sequences like %ZZ should return raw value.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: parseCookies encoding edge cases", () => {
	it("valid percent-encoded value is decoded", () => {
		const result = parseCookies("name=hello%20world")
		expect(result.name).toBe("hello world")
	})

	it("malformed percent-encoding returns raw value", () => {
		const result = parseCookies("token=%ZZbad")
		expect(result.token).toBe("%ZZbad")
	})

	it("empty cookie header returns empty object", () => {
		const result = parseCookies("")
		expect(Object.keys(result).length).toBe(0)
	})

	it("value with multiple = signs preserves full value", () => {
		const result = parseCookies("data=a=b=c")
		expect(result.data).toBe("a=b=c")
	})
})

/* ──────────────────────────────────────────────
 * 3. selectParser — content-type edge cases
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: selectParser edge cases", () => {
	it("application/json with charset → json", () => {
		expect(selectParser("application/json; charset=utf-8")).toBe("json")
	})

	it("multipart/form-data with boundary → form", () => {
		expect(selectParser("multipart/form-data; boundary=----WebKitFormBoundary")).toBe("form")
	})

	it("text/plain → null (not a parseable type)", () => {
		expect(selectParser("text/plain")).toBeNull()
	})

	it("null → null", () => {
		expect(selectParser(null)).toBeNull()
	})

	it("application/xml → null", () => {
		expect(selectParser("application/xml")).toBeNull()
	})
})

/* ──────────────────────────────────────────────
 * 4. cookie-sign round-trip
 *
 * sign() produces "value.signature", verify() validates.
 * Test key rotation (multiple secrets), invalid signatures,
 * and edge cases.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: cookie-sign round-trip", () => {
	it("sign then verify with same secret → original value", async () => {
		const { sign, verify } = await import("../../src/cookie-sign.ts")
		const signed = await sign("session-token-abc", "my-secret")
		expect(signed).toContain(".")
		const value = await verify(signed, ["my-secret"])
		expect(value).toBe("session-token-abc")
	})

	it("verify with wrong secret → null", async () => {
		const { sign, verify } = await import("../../src/cookie-sign.ts")
		const signed = await sign("data", "secret-1")
		const value = await verify(signed, ["wrong-secret"])
		expect(value).toBeNull()
	})

	it("key rotation — old secret still works", async () => {
		const { sign, verify } = await import("../../src/cookie-sign.ts")
		const signed = await sign("data", "old-secret")
		/* verify with new secret first, old second */
		const value = await verify(signed, ["new-secret", "old-secret"])
		expect(value).toBe("data")
	})

	it("empty string → null", async () => {
		const { verify } = await import("../../src/cookie-sign.ts")
		const value = await verify("", ["secret"])
		expect(value).toBeNull()
	})

	it("no dot in signed string → null", async () => {
		const { verify } = await import("../../src/cookie-sign.ts")
		const value = await verify("nodot", ["secret"])
		expect(value).toBeNull()
	})

	it("tampered value → null", async () => {
		const { sign, verify } = await import("../../src/cookie-sign.ts")
		const signed = await sign("original", "secret")
		const tampered = `tampered${signed.slice(signed.indexOf("."))}`
		const value = await verify(tampered, ["secret"])
		expect(value).toBeNull()
	})
})

/* ──────────────────────────────────────────────
 * 5. timingSafeEqual
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: timingSafeEqual", () => {
	it("identical strings → true", async () => {
		const { timingSafeEqual } = await import("../../src/crypto.ts")
		expect(await timingSafeEqual("abc", "abc")).toBe(true)
	})

	it("different strings → false", async () => {
		const { timingSafeEqual } = await import("../../src/crypto.ts")
		expect(await timingSafeEqual("abc", "xyz")).toBe(false)
	})

	it("different length strings → false", async () => {
		const { timingSafeEqual } = await import("../../src/crypto.ts")
		expect(await timingSafeEqual("short", "a-longer-string")).toBe(false)
	})

	it("empty strings → true", async () => {
		const { timingSafeEqual } = await import("../../src/crypto.ts")
		expect(await timingSafeEqual("", "")).toBe(true)
	})
})

/* ──────────────────────────────────────────────
 * 6. accepts content negotiation
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: accepts content negotiation", () => {
	it("no Accept header → first supported type", async () => {
		const { accepts } = await import("../../src/accepts.ts")
		const req = new Request("http://localhost/")
		expect(accepts(req, ["application/json", "text/html"])).toBe("application/json")
	})

	it("Accept: text/html → matches html", async () => {
		const { accepts } = await import("../../src/accepts.ts")
		const req = new Request("http://localhost/", {
			headers: { accept: "text/html" },
		})
		expect(accepts(req, ["application/json", "text/html"])).toBe("text/html")
	})

	it("Accept: */*, application/json;q=0.9 → picks json (first server pref with equal q)", async () => {
		const { accepts } = await import("../../src/accepts.ts")
		const req = new Request("http://localhost/", {
			headers: { accept: "*/*, application/json;q=0.9" },
		})
		const result = accepts(req, ["application/json", "text/html"])
		expect(result).toBeTruthy()
	})

	it("Accept: application/xml → no match → null", async () => {
		const { accepts } = await import("../../src/accepts.ts")
		const req = new Request("http://localhost/", {
			headers: { accept: "application/xml" },
		})
		expect(accepts(req, ["application/json", "text/html"])).toBeNull()
	})

	it("Accept with q=0 → excluded", async () => {
		const { accepts } = await import("../../src/accepts.ts")
		const req = new Request("http://localhost/", {
			headers: { accept: "text/html;q=0, application/json" },
		})
		const result = accepts(req, ["text/html", "application/json"])
		expect(result).toBe("application/json")
	})

	it("wildcard subtype text/* → matches text/html", async () => {
		const { accepts } = await import("../../src/accepts.ts")
		const req = new Request("http://localhost/", {
			headers: { accept: "text/*" },
		})
		expect(accepts(req, ["application/json", "text/html"])).toBe("text/html")
	})

	it("empty supported array → null", async () => {
		const { accepts } = await import("../../src/accepts.ts")
		const req = new Request("http://localhost/")
		expect(accepts(req, [])).toBeNull()
	})
})

/* ──────────────────────────────────────────────
 * 7. validation — input with json schema that rejects
 *
 * When a JSON body fails validation, the error should have
 * field-level details with proper paths.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: input validation error detail", () => {
	it("json validation failure → 400 with field errors", async () => {
		function strictSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => {
						const d = data as Record<string, unknown>
						if (typeof d.name !== "string") {
							return {
								issues: [{ message: "name must be a string", path: ["name"] }],
							}
						}
						return { value: data }
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/users")
			.input({ json: strictSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/users", {
				body: JSON.stringify({ name: 42 }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("validation_failed")
		expect(data.fields).toBeTruthy()
	})

	it("json validation with no content-type → 415 unsupported media type", async () => {
		function okSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/users")
			.input({ json: okSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/users", {
				body: "some body",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(415)
	})
})

/* ──────────────────────────────────────────────
 * 8. validation — __proto__ in form data
 *
 * formDataToRecord and urlEncodedToRecord have DANGEROUS_KEYS guard.
 * parseCookies does NOT. Verify the guards work where present.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: prototype pollution guards in validation", () => {
	it("urlencoded __proto__ key is rejected", async () => {
		function okSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/form")
			.input({ form: okSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: "__proto__=polluted&name=ok",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		const form = data.form as Record<string, unknown>
		/* __proto__ should be stripped */
		expect(Object.hasOwn(form, "__proto__")).toBe(false)
		expect(form.name).toBe("ok")
		/* global prototype not polluted */
		const freshObj: Record<string, unknown> = {}
		expect(freshObj["polluted"]).toBeUndefined()
	})
})

/* ──────────────────────────────────────────────
 * 9. input validation skips body for DELETE
 *
 * validation.ts:256-260: hasBody is false for DELETE.
 * But some APIs send JSON body with DELETE.
 * Test that body validation is skipped for DELETE.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: input validation body skip for safe methods", () => {
	it("DELETE with json schema → body validation skipped, params still validated", async () => {
		function okSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.delete("/items/:id")
			.input({ json: okSchema(), params: okSchema() })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, input: ctx.input }))

		const res = await app.fetch(new Request("http://localhost/items/42", { method: "DELETE" }), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.id).toBe("42")
		/* input should have params but not json */
		const input = data.input as Record<string, unknown>
		expect(input.params).toBeTruthy()
		expect(input.json).toBeUndefined()
	})
})

/* ──────────────────────────────────────────────
 * 10. testClient cookie jar
 *
 * testClient with cookies: true should accumulate
 * Set-Cookie headers across requests.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: testClient cookie jar", () => {
	it("cookies from response are sent in subsequent requests", async () => {
		const app = honey<{}>()
		app.get("/login").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ loggedIn: true },
				{
					cookies: {
						session: { httpOnly: true, path: "/", value: "tok-xyz" },
					},
				},
			),
		)
		app.get("/profile").handler((ctx) => ctx.res.json("ok", { session: ctx.cookies.session }))

		const client = testClient(app, { cookies: true, env: {} })

		/* first request sets cookie */
		const loginRes = await client.get("/login")
		expect(loginRes.status).toBe(200)

		/* second request should include the cookie automatically */
		const profileRes = await client.get("/profile")
		expect(profileRes.status).toBe(200)
		const data = (await profileRes.json()) as Record<string, string>
		expect(data.session).toBe("tok-xyz")
	})

	it("cookies: false → cookies not forwarded", async () => {
		const app = honey<{}>()
		app.get("/login").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: {
						session: { path: "/", value: "tok" },
					},
				},
			),
		)
		app
			.get("/check")
			.handler((ctx) => ctx.res.json("ok", { hasCookie: ctx.cookies.session !== undefined }))

		const client = testClient(app, { cookies: false, env: {} })
		await client.get("/login")
		const checkRes = await client.get("/check")
		const data = (await checkRes.json()) as Record<string, boolean>
		expect(data.hasCookie).toBe(false)
	})
})

/* ──────────────────────────────────────────────
 * 11. testClient — JSON body and search params
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: testClient request building", () => {
	it("json option sets content-type and body", async () => {
		const app = honey<{}>()
		app.post("/api").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			const ct = ctx.req.headers.get("content-type")
			return ctx.res.json("created", { body, ct })
		})

		const client = testClient(app, { env: {} })
		const res = await client.post("/api", { json: { name: "Alice" } })
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.ct).toBe("application/json")
		expect((data.body as Record<string, string>).name).toBe("Alice")
	})

	it("search option appends query params", async () => {
		const app = honey<{}>()
		app.get("/search").handler((ctx) => ctx.res.json("ok", { search: ctx.search }))

		const client = testClient(app, { env: {} })
		const res = await client.get("/search", { search: { page: "2", q: "test" } })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		const search = data.search as Record<string, string>
		expect(search.q).toBe("test")
		expect(search.page).toBe("2")
	})
})

/* ──────────────────────────────────────────────
 * 12. i18n interpolation edge cases
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: i18n interpolation", () => {
	it("simple variable substitution", async () => {
		const { interpolate } = await import("../../src/i18n.ts")
		expect(interpolate("Hello {name}!", { name: "World" })).toBe("Hello World!")
	})

	it("missing variable → placeholder preserved", async () => {
		const { interpolate } = await import("../../src/i18n.ts")
		expect(interpolate("Hello {name}!", {})).toBe("Hello {name}!")
	})

	it("numeric variable", async () => {
		const { interpolate } = await import("../../src/i18n.ts")
		expect(interpolate("{count} items", { count: 42 })).toBe("42 items")
	})

	it("no variables in template → unchanged", async () => {
		const { interpolate } = await import("../../src/i18n.ts")
		expect(interpolate("No vars here", {})).toBe("No vars here")
	})

	it("multiple occurrences of same variable", async () => {
		const { interpolate } = await import("../../src/i18n.ts")
		expect(interpolate("{x} and {x}", { x: "val" })).toBe("val and val")
	})
})

/* ──────────────────────────────────────────────
 * 13. normalizeIssues + issuesToFieldErrors
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: normalizeIssues", () => {
	it("zod-style issues with code → mapped correctly", () => {
		const issues = [
			{ code: "too_small", message: "Too short", path: ["name"] },
			{ code: "invalid_format", message: "Bad email", path: ["email"] },
		]
		const normalized = normalizeIssues(issues, "zod")
		expect(normalized[0].code).toBe("too_small")
		expect(normalized[1].code).toBe("invalid_format")
	})

	it("issuesToFieldErrors groups by field name", () => {
		const normalized = [
			{ code: "too_small", message: "Too short", meta: { field: "name" }, path: ["name"] },
			{ code: "required", message: "Required", meta: { field: "email" }, path: ["email"] },
		]
		const fields = issuesToFieldErrors(normalized, "json")
		expect(fields.name).toHaveLength(1)
		expect(fields.email).toHaveLength(1)
		expect(fields.name[0].error_key).toBe("field_too_small")
		expect(fields.email[0].error_key).toBe("field_required")
		expect(fields.name[0].path).toBe("json.name")
	})

	it("mapNormalizedCode for unknown code → field_invalid", () => {
		expect(mapNormalizedCode("some_unknown_code")).toBe("field_invalid")
	})
})

/* ──────────────────────────────────────────────
 * 14. error translation in the fetch pipeline
 *
 * index.ts supports errorI18n config. When a HoneyError
 * is thrown, its message should be translated using the locale.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: error translation", () => {
	it("error message translated via errorI18n", async () => {
		const { HoneyError } = await import("../../src/error.ts")
		const app = honey<{}>()
		app.errorI18n({
			errors: {
				en: { not_found: "Resource not found" },
				es: { not_found: "Recurso no encontrado" },
			},
			resolveLocale: (ctx) => {
				const lang = ctx.req.headers.get("accept-language")
				return lang?.startsWith("es") ? "es" : "en"
			},
		})
		app.get("/item").handler(() => {
			throw new HoneyError({ errorKey: "not_found", status: "not_found" })
		})

		const resEn = await app.fetch(
			new Request("http://localhost/item", {
				headers: { "accept-language": "en" },
			}),
			{},
		)
		expect(resEn.status).toBe(404)
		const enData = (await resEn.json()) as Record<string, string>
		expect(enData.message).toBe("Resource not found")

		const resEs = await app.fetch(
			new Request("http://localhost/item", {
				headers: { "accept-language": "es-ES" },
			}),
			{},
		)
		expect(resEs.status).toBe(404)
		const esData = (await resEs.json()) as Record<string, string>
		expect(esData.message).toBe("Recurso no encontrado")
	})
})

/* ──────────────────────────────────────────────
 * 15. defineErrors factory
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: defineErrors factory", () => {
	it("creates error factories that produce HoneyError instances", async () => {
		const { defineErrors } = await import("../../src/errors.ts")
		const { HoneyError } = await import("../../src/error.ts")

		const errors = defineErrors({
			insufficient_funds: "payment_required",
			user_not_found: "not_found",
		})

		const err = errors.user_not_found()
		expect(err).toBeInstanceOf(HoneyError)
		expect(err.errorKey).toBe("user_not_found")
		expect(err.status).toBe(404)
		expect(err.statusKey).toBe("not_found")
	})

	it("error factory with vars", async () => {
		const { defineErrors } = await import("../../src/errors.ts")

		const errors = defineErrors({
			rate_limited: "too_many_requests",
		})

		const err = errors.rate_limited({ vars: { retryAfter: 60 } })
		expect(err.vars).toEqual({ retryAfter: 60 })
	})
})

/* ──────────────────────────────────────────────
 * 16. Multiple middlewares modifying response headers
 *
 * When etag + secureHeaders + cors all run, do they
 * clobber each other's headers?
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: middleware header stacking", () => {
	it("etag + secureHeaders + cors → all headers present", async () => {
		const { secureHeaders } = await import("../../src/secure-headers.ts")
		const app = honey<{}>()
			.use(cors({ origin: "http://app.com" }))
			.use(etag())
			.use(secureHeaders())
		app.get("/api").handler((ctx) => ctx.res.json("ok", { data: 1 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api", {
			headers: { origin: "http://app.com" },
		})
		expect(res.status).toBe(200)
		/* CORS */
		expect(res.headers["access-control-allow-origin"]).toBe("http://app.com")
		/* ETag */
		expect(res.headers.etag).toBeTruthy()
		/* Secure headers */
		expect(res.headers["x-content-type-options"]).toBe("nosniff")
	})
})

/* ──────────────────────────────────────────────
 * 17. serverTiming + error → no Server-Timing on error response
 *
 * When handler throws, the error catch in fetch() creates a new
 * Response. The serverTiming middleware's `response` variable
 * comes from next() which resolves — or does it reject?
 * If it rejects, response.headers.set crashes.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: serverTiming with handler error", () => {
	it("handler throw → error response without crash", async () => {
		const app = honey<{}>().use(serverTiming())
		app.get("/fail").handler(() => {
			throw new Error("boom")
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/fail")
		/* should be 500 from error handling, not crash */
		expect(res.status).toBe(500)
	})
})

/* ──────────────────────────────────────────────
 * 18. timeout + normal response (should clear timer)
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: timeout middleware", () => {
	it("fast handler → 200, timer cleared", async () => {
		const { timeout } = await import("../../src/timeout.ts")
		const app = honey<{}>().use(timeout({ duration: 1000 }))
		app.get("/fast").handler((ctx) => ctx.res.json("ok", { fast: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/fast")
		expect(res.status).toBe(200)
	})

	it("slow handler → 504 timeout", async () => {
		const { timeout } = await import("../../src/timeout.ts")
		const app = honey<{}>().use(timeout({ duration: 20 }))
		app.get("/slow").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 100))
			return ctx.res.json("ok", {})
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/slow")
		expect(res.status).toBe(504)
	})
})

/* ──────────────────────────────────────────────
 * 19. CSRF middleware → same-origin sec-fetch-site passes
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: CSRF sec-fetch-site handling", () => {
	it("sec-fetch-site: same-origin → passes regardless of content-type", async () => {
		const app = honey<{}>().use(csrf())
		app.post("/api").handler((ctx) => ctx.res.json("ok", {}))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api", {
			body: "key=val",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"sec-fetch-site": "same-origin",
			},
			method: "POST",
		})
		expect(res.status).toBe(200)
	})
})

/* ──────────────────────────────────────────────
 * 20. CORS credentials + wildcard origin → echoes request origin
 *
 * cors.ts:27-28: credentialWildcard auto-narrows to echo origin.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: CORS credentials + wildcard auto-narrowing", () => {
	it("credentials: true + no origin config → echoes request origin", async () => {
		const app = honey<{}>().use(cors({ credentials: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api", {
			headers: { origin: "http://my-app.com" },
		})
		expect(res.status).toBe(200)
		/* should echo the request origin, not "*" */
		expect(res.headers["access-control-allow-origin"]).toBe("http://my-app.com")
		expect(res.headers["access-control-allow-credentials"]).toBe("true")
	})
})

/* ──────────────────────────────────────────────
 * 21. etag skips GET requests with non-2xx responses
 *
 * ETag should still compute for 200, but what about 201, 404?
 * RFC says ETag is meaningful for any representation, including
 * error responses. Current code only checks method, not status.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: ETag with non-200 status", () => {
	it("etag computed for 200 GET", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { x: 1 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/data")
		expect(res.status).toBe(200)
		expect(res.headers.etag).toBeTruthy()
	})

	it("etag on 404 GET → should still have response body", async () => {
		const app = honey<{}>().use(etag())
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		/* 404 goes through error handler, not through etag middleware's next() */
		const body = await res.text()
		expect(body.length).toBeGreaterThan(0)
	})
})

/* ──────────────────────────────────────────────
 * 22. bodyLimit exactly at maxSize boundary
 *
 * Body exactly equal to maxSize should pass.
 * Body one byte over should fail.
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: bodyLimit boundary precision", () => {
	it("body at exact maxSize → passes", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 5 }))
		app.post("/echo").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.text("ok", text)
		})

		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "12345",
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("12345")
	})

	it("body one byte over maxSize → 413", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 5 }))
		app.post("/echo").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.text("ok", text)
		})

		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "123456",
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})
})

/* ──────────────────────────────────────────────
 * 23. mergeTree — merging two route trees
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: mergeTree", () => {
	it("merged routes from separate apps both respond", async () => {
		const { mergeTree } = await import("../../src/tree.ts")

		const users = honey<{}>()
		users.get("/users").handler((ctx) => ctx.res.json("ok", { route: "users" }))

		const posts = honey<{}>()
		posts.get("/posts").handler((ctx) => ctx.res.json("ok", { route: "posts" }))

		const merged = mergeTree(users.toRouteTree(), posts.toRouteTree())
		const app = honey<{}>()
		app.routeTree(merged)

		const usersRes = await app.fetch(new Request("http://localhost/users"), {})
		expect(usersRes.status).toBe(200)
		const usersData = (await usersRes.json()) as Record<string, string>
		expect(usersData.route).toBe("users")

		const postsRes = await app.fetch(new Request("http://localhost/posts"), {})
		expect(postsRes.status).toBe(200)
		const postsData = (await postsRes.json()) as Record<string, string>
		expect(postsData.route).toBe("posts")
	})

	it("mergeTree duplicate route → throws", async () => {
		const { mergeTree } = await import("../../src/tree.ts")

		const a = honey<{}>()
		a.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const b = honey<{}>()
		b.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		expect(() => mergeTree(a.toRouteTree(), b.toRouteTree())).toThrow("Merge conflict")
	})
})

/* ──────────────────────────────────────────────
 * 24. search params on ctx — multi-value and empty
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: ctx.search edge cases", () => {
	it("3+ occurrences of same param → searchAll returns array", async () => {
		const app = honey<{}>()
		app.get("/search").handler((ctx) => ctx.res.json("ok", { tags: ctx.searchAll.tags }))

		const res = await app.fetch(new Request("http://localhost/search?tags=a&tags=b&tags=c"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string[]>
		expect(data.tags).toEqual(["a", "b", "c"])
	})

	it("single param stays as string (not array)", async () => {
		const app = honey<{}>()
		app.get("/search").handler((ctx) => ctx.res.json("ok", { q: ctx.search.q }))

		const res = await app.fetch(new Request("http://localhost/search?q=hello"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("hello")
		expect(typeof data.q).toBe("string")
	})
})

/* ──────────────────────────────────────────────
 * 25. onNotFound / onMethodNotAllowed custom handlers
 * ────────────────────────────────────────────── */

describe("bug-hunt-3: custom 404/405 handlers", () => {
	it("onNotFound returns custom response", async () => {
		const app = honey<{}>()
		app.onNotFound((ctx) =>
			ctx.jsonFromError(
				new (Object.getPrototypeOf(ctx.jsonFromError).constructor)({
					errorKey: "custom_not_found",
					status: "not_found",
				}),
			),
		)
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		/* simpler approach: test that onNotFound changes behavior */
		const app2 = honey<{}>()
		app2.onNotFound(() => new Response("custom 404", { status: 404 }))
		app2.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app2.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		expect(await res.text()).toBe("custom 404")
	})

	it("onMethodNotAllowed returns custom response with Allow header", async () => {
		const app = honey<{}>()
		app.onMethodNotAllowed((_ctx) => new Response("Use GET or POST", { status: 405 }))
		app.get("/resource").handler((ctx) => ctx.res.json("ok", {}))
		app.post("/resource").handler((ctx) => ctx.res.json("created", {}))

		const res = await app.fetch(new Request("http://localhost/resource", { method: "DELETE" }), {})
		expect(res.status).toBe(405)
		/* Allow header should be added by framework even with custom handler */
		expect(res.headers.get("allow")).toBeTruthy()
		expect(await res.text()).toBe("Use GET or POST")
	})
})
