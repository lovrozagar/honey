import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { HoneyError } from "../../src/error.ts"
import { defineErrors } from "../../src/errors.ts"
import { honey } from "../../src/index.ts"
import { readableStream } from "../../src/input.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { serializeCookie } from "../../src/response.ts"
import "@lovrozagar/honey/i18n"

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

/* ══════════════════════════════════════════════
 * 1. URL-ENCODED FORM VALIDATION
 *
 * validation.ts:280 — urlEncodedToRecord processes form body.
 * URLSearchParams.forEach overwrites duplicate keys (last wins).
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: url-encoded form validation", () => {
	function okSchema() {
		return {
			"~standard": {
				validate: (data: unknown) => ({ value: data }),
				vendor: "test",
				version: 1,
			},
		}
	}

	it("url-encoded form body → validated and available in ctx.input", async () => {
		const app = honey<{}>()
		app
			.post("/form")
			.input({ form: okSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: "name=Alice&age=30",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		const form = data.form as Record<string, string>
		expect(form.name).toBe("Alice")
		expect(form.age).toBe("30")
	})

	it("url-encoded duplicate keys → last value wins", async () => {
		const app = honey<{}>()
		app
			.post("/form")
			.input({ form: okSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: "tag=first&tag=second",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		const form = data.form as Record<string, string>
		/* URLSearchParams.forEach overwrites — last value wins */
		expect(form.tag).toBe("second")
	})

	it("url-encoded __proto__ key → stripped by DANGEROUS_KEYS guard", async () => {
		const app = honey<{}>()
		app
			.post("/form")
			.input({ form: okSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: "__proto__=evil&safe=yes",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		const form = data.form as Record<string, unknown>
		expect(Object.hasOwn(form, "__proto__")).toBe(false)
		expect(form.safe).toBe("yes")
	})
})

/* ══════════════════════════════════════════════
 * 2. readableStream — body untouched, non-body sources pass raw
 *
 * readableStream(schema) tells the framework:
 * - schema exists for codegen/OpenAPI/SDK types
 * - body sources (json/form): do NOT consume req.body
 * - non-body sources (search/params/headers/cookies): pass raw parsed data
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: readableStream skips body consumption", () => {
	it("readableStream for json → body not consumed, handler reads req.body", async () => {
		function schema() {
			return {
				"~standard": {
					validate: () => {
						throw new Error("should never be called")
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/api")
			.input({ json: readableStream(schema()) })
			.handler(async (ctx) => {
				/* body was NOT consumed by framework — read it manually */
				const body = (await ctx.req.json()) as Record<string, unknown>
				return ctx.res.json("created", { fromBody: body.any })
			})

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: JSON.stringify({ any: "data" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.fromBody).toBe("data")
	})

	it("readableStream for search → passes raw parsed params without validation", async () => {
		function schema() {
			return {
				"~standard": {
					validate: () => {
						throw new Error("should never be called")
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.get("/search")
			.input({ search: readableStream(schema()) })
			.handler((ctx) => ctx.res.json("ok", ctx.input))

		const res = await app.fetch(new Request("http://localhost/search?q=test&page=1"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		const search = data.search as Record<string, string>
		expect(search.q).toBe("test")
		expect(search.page).toBe("1")
	})
})

/* ══════════════════════════════════════════════
 * 3. WS ROUTE WITHOUT UPGRADE HEADER → 426
 *
 * index.ts:557-559 — WS route matched but no upgrade header.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: WebSocket route without upgrade header", () => {
	it("WS route hit with normal GET → 426 Upgrade Required", async () => {
		const app = honey<{}>()
		app.ws("/chat").handler({
			onMessage: () => {},
		})
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/chat"), {})
		expect(res.status).toBe(426)
		expect(res.headers.get("upgrade")).toBe("websocket")
	})
})

/* ══════════════════════════════════════════════
 * 4. WS ROUTE WITHOUT WS ADAPTER → 500
 *
 * index.ts:562-568 — WS adapter not configured.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: WebSocket route without adapter", () => {
	it("WS route with upgrade header but no adapter → 500", async () => {
		const app = honey<{}>()
		app.ws("/chat").handler({
			onMessage: () => {},
		})

		const res = await app.fetch(
			new Request("http://localhost/chat", {
				headers: { upgrade: "websocket" },
			}),
			{},
		)
		expect(res.status).toBe(500)
	})
})

/* ══════════════════════════════════════════════
 * 5. TELEMETRY onMiddleware WITH ERROR
 *
 * index.ts:767-770 — middleware telemetry timing on error path.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: telemetry onMiddleware error path", () => {
	it("middleware that throws → telemetry still fires with error", async () => {
		const mwEvents: Array<{ error?: unknown; name: string }> = []
		const app = honey<{}>()
		app.telemetry({
			onMiddleware: (ctx) => {
				mwEvents.push({ error: ctx.error, name: ctx.name })
			},
		})

		const errorMw = createMiddleware(async () => {
			throw new HoneyError({ errorKey: "mw_fail", status: "bad_request" })
		})
		Object.defineProperty(errorMw, "name", { value: "errorMw" })

		app
			.get("/fail")
			.use(errorMw)
			.handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(400)

		/* telemetry should have fired with error */
		const errorEvent = mwEvents.find((e) => e.error !== undefined)
		expect(errorEvent).toBeTruthy()
	})
})

/* ══════════════════════════════════════════════
 * 6. TELEMETRY onHandler + onResponse TIMING
 *
 * index.ts:821-838 — handler and response telemetry fire on success.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: telemetry onHandler fires", () => {
	it("successful request → onHandler receives status and duration", async () => {
		let handlerStatus = 0
		let handlerDuration = 0
		const app = honey<{}>()
		app.telemetry({
			onHandler: (ctx) => {
				handlerStatus = ctx.status
				handlerDuration = ctx.duration
			},
		})
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/api"), {})
		expect(handlerStatus).toBe(200)
		expect(handlerDuration).toBeGreaterThan(0)
	})
})

/* ══════════════════════════════════════════════
 * 7. TELEMETRY onMethodNotAllowed
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: telemetry onMethodNotAllowed", () => {
	it("405 → onMethodNotAllowed receives allowed methods", async () => {
		let allowedMethods: string[] = []
		const app = honey<{}>()
		app.telemetry({
			onMethodNotAllowed: (ctx) => {
				allowedMethods = ctx.allowed
			},
		})
		app.get("/resource").handler((ctx) => ctx.res.json("ok", {}))
		app.post("/resource").handler((ctx) => ctx.res.json("created", {}))

		await app.fetch(new Request("http://localhost/resource", { method: "DELETE" }), {})
		expect(allowedMethods).toContain("GET")
		expect(allowedMethods).toContain("POST")
	})
})

/* ══════════════════════════════════════════════
 * 8. ERROR ENFORCEMENT — global errors + route errors combined
 *
 * index.ts:740-751 — error factory subsetting based on handler.ek.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: ctx.errors factory subsetting", () => {
	it("route with specific error keys → ctx.errors only has those keys", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		const app = honey<{}>().errorFactory(errors)
		app
			.get("/item")
			.errors("not_found")
			.handler((ctx) => {
				const keys = Object.keys(ctx.errors as Record<string, unknown>)
				return ctx.res.json("ok", { errorKeys: keys })
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string[]>
		/* only not_found should be in the subset (plus any defaultErrors) */
		expect(data.errorKeys).toContain("not_found")
		expect(data.errorKeys).not.toContain("rate_limited")
	})

	it("route with no error keys → full factory available", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
		})

		const app = honey<{}>().errorFactory(errors)
		app.get("/item").handler((ctx) => {
			const keys = Object.keys(ctx.errors as Record<string, unknown>)
			return ctx.res.json("ok", { errorKeys: keys })
		})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string[]>
		expect(data.errorKeys).toContain("not_found")
		expect(data.errorKeys).toContain("auth_failed")
	})
})

/* ══════════════════════════════════════════════
 * 9. i18n FIELD NAME TRANSLATION
 *
 * index.ts:879-891 — translates field paths in error response.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: i18n field name translation", () => {
	it("field names translated using locale map", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {},
			fieldNames: {
				en: { "json.email": "Email Address", "json.name": "Full Name" },
			},
			resolveLocale: () => "en",
		})
		app.get("/fail").handler(() => {
			throw new HoneyError({
				errorKey: "validation_failed",
				fields: {
					email: [{ error_key: "field_invalid", message: "bad", path: "json.email" }],
					name: [{ error_key: "field_required", message: "required", path: "json.name" }],
				},
				status: "bad_request",
			})
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<{ path: string }>>
		/* field paths should be translated */
		expect(fields.email[0].path).toBe("Email Address")
		expect(fields.name[0].path).toBe("Full Name")
	})

	it("field names with no translation → path unchanged", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {},
			fieldNames: {
				en: {},
			},
			resolveLocale: () => "en",
		})
		app.get("/fail").handler(() => {
			throw new HoneyError({
				errorKey: "validation_failed",
				fields: {
					email: [{ error_key: "field_invalid", message: "bad", path: "json.email" }],
				},
				status: "bad_request",
			})
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, unknown>
		const fields = data.fields as Record<string, Array<{ path: string }>>
		expect(fields.email[0].path).toBe("json.email")
	})

	it("error with no fields → field translation skipped cleanly", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: { en: { not_found: "Not found" } },
			fieldNames: { en: { "json.email": "Email" } },
			resolveLocale: () => "en",
		})
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "not_found", status: "not_found" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(404)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.message).toBe("Not found")
		/* fields should be empty, no crash */
		expect(Object.keys(data.fields as Record<string, unknown>).length).toBe(0)
	})
})

/* ══════════════════════════════════════════════
 * 10. executionCtx EXPOSED ON HANDLER
 *
 * index.ts:732 — Object.defineProperty(ctx, "executionCtx", ...)
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: ctx.executionCtx", () => {
	it("executionCtx available when provided", async () => {
		const app = honey<{}>()
		app
			.get("/test")
			.handler((ctx) => ctx.res.json("ok", { hasCtx: ctx.executionCtx !== undefined }))

		const res = await app.fetch(new Request("http://localhost/test"), {}, { waitUntil: () => {} })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.hasCtx).toBe(true)
	})

	it("executionCtx undefined when not provided", async () => {
		const app = honey<{}>()
		app
			.get("/test")
			.handler((ctx) => ctx.res.json("ok", { hasCtx: ctx.executionCtx !== undefined }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.hasCtx).toBe(false)
	})
})

/* ══════════════════════════════════════════════
 * 11. OUTPUT VALIDATION — JSON schema per status key
 *
 * index.ts:811-817 — validates JSON output against schema
 * for specific status key using codeToStatusKey mapping.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: output validation per status key", () => {
	it("201 response validated against 'created' schema", async () => {
		function createdSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => {
						const d = data as Record<string, unknown>
						if (!d.id) {
							return { issues: [{ message: "id required", path: ["id"] }] }
						}
						return { value: data }
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app.outputValidation("always")
		app
			.post("/items")
			.output({ "application/json": { created: createdSchema() } })
			.handler((ctx) => ctx.res.json("created", { name: "test" }))

		const res = await app.fetch(new Request("http://localhost/items", { method: "POST" }), {})
		/* response doesn't have "id", so validation should fail */
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("output_validation_failed")
	})
})

/* ══════════════════════════════════════════════
 * 12. COOKIE VALUE ENCODING — non-ASCII
 *
 * response.ts:50-67 — encodeCookieValue percent-encodes
 * characters outside RFC 6265 cookie-octet range.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: cookie value encoding", () => {
	it("emoji in cookie value → percent-encoded", () => {
		const cookie = serializeCookie("emoji", { value: "🍯" })
		expect(cookie).not.toContain("🍯")
		expect(cookie).toContain("emoji=")
		/* should be percent-encoded */
		expect(cookie).toContain("%")
	})

	it("plain ASCII value → no encoding needed", () => {
		const cookie = serializeCookie("simple", { value: "abc123" })
		expect(cookie).toBe("simple=abc123")
	})

	it("value with comma → percent-encoded", () => {
		const cookie = serializeCookie("list", { value: "a,b,c" })
		expect(cookie).toContain("list=a%2Cb%2Cc")
	})
})

/* ══════════════════════════════════════════════
 * 13. MIDDLEWARE NEXT() CALLED WITH ALL 8 RESERVED KEYS AT ONCE
 *
 * middleware.ts:100-106 — reserved key deletion.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: all 8 reserved keys overwrite attempt", () => {
	it("next() with all reserved keys → all silently dropped", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({
				background: "fake",
				cookies: "fake",
				env: "fake",
				headers: "fake",
				params: "fake",
				req: "fake",
				res: "fake",
				search: "fake",
			})
		})

		const app = honey<{ DB: string }>().use(mw)
		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", {
				bgType: typeof ctx.background,
				envType: typeof ctx.env,
				reqType: typeof ctx.req,
				resType: typeof ctx.res,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/test"), { DB: "real" })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.bgType).toBe("function")
		expect(data.envType).toBe("object")
		expect(data.reqType).toBe("object")
		expect(data.resType).toBe("object")
	})
})

/* ══════════════════════════════════════════════
 * 14. NODE ADAPTER — response with 101 status
 *
 * node.ts:133-140 — if response.status !== 101,
 * writes HTTP error to socket.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: Node adapter response status codes", () => {
	it("HEAD response via Node adapter → empty body", async () => {
		const app = honey<{}>()
		app.get("/data").handler((ctx) => ctx.res.json("ok", { big: "payload" }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/data", { method: "HEAD" })
		expect(res.status).toBe(200)
		expect(res.body).toBe("")
		/* content-type should still be present */
		expect(res.headers["content-type"]).toBe("application/json")
	})
})

/* ══════════════════════════════════════════════
 * 15. STREAM() ERROR IN CALLBACK → stream closed
 *
 * response.ts:295-297 — stream callback .catch closes writable.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: stream() error handling", () => {
	it("callback throws after writing → no unhandled rejection", async () => {
		const app = honey<{}>()
		app.get("/stream").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				await writer.write(new TextEncoder().encode("before-error"))
				await writer.close()
				throw new Error("stream callback failed after close")
			}),
		)

		const res = await app.fetch(new Request("http://localhost/stream"), {})
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toContain("before-error")
	})

	it("callback throws without closing writer → no unhandled rejection", async () => {
		const app = honey<{}>()
		app.get("/stream").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				await writer.write(new TextEncoder().encode("data"))
				/* release lock before throwing so writable.close() can work */
				writer.releaseLock()
				throw new Error("callback error")
			}),
		)

		const res = await app.fetch(new Request("http://localhost/stream"), {})
		expect(res.status).toBe(200)
		/* stream closes via .catch handler */
		const body = await res.text()
		expect(body).toContain("data")
	})
})

/* ══════════════════════════════════════════════
 * 16. ROUTE TREE — DYNAMIC + STATIC AT SAME LEVEL
 *
 * tree.ts:184-193 — static child checked BEFORE dynamic param.
 * What about /users/me vs /users/:id with nested paths?
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: route tree — static + dynamic + nested", () => {
	it("static /users/me/settings doesn't collide with /users/:id/posts", async () => {
		const app = honey<{}>()
		app.get("/users/me/settings").handler((ctx) => ctx.res.json("ok", { route: "settings" }))
		app
			.get("/users/:id/posts")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, route: "posts" }))

		const settingsRes = await app.fetch(new Request("http://localhost/users/me/settings"), {})
		expect(settingsRes.status).toBe(200)
		const settingsData = (await settingsRes.json()) as Record<string, string>
		expect(settingsData.route).toBe("settings")

		const postsRes = await app.fetch(new Request("http://localhost/users/42/posts"), {})
		expect(postsRes.status).toBe(200)
		const postsData = (await postsRes.json()) as Record<string, string>
		expect(postsData.route).toBe("posts")
		expect(postsData.id).toBe("42")
	})

	it("static /users/me/posts uses STATIC me, not DYNAMIC :id", async () => {
		const app = honey<{}>()
		app.get("/users/me/posts").handler((ctx) => ctx.res.json("ok", { route: "me-posts" }))
		app
			.get("/users/:id/posts")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, route: "dynamic-posts" }))

		const res = await app.fetch(new Request("http://localhost/users/me/posts"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		/* static "me" should be preferred over dynamic :id */
		expect(data.route).toBe("me-posts")
	})
})

/* ══════════════════════════════════════════════
 * 17. MERGETREE — WILDCARD CONFLICT
 *
 * tree.ts:324-339 — merging two trees with different wildcard names.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: mergeTree wildcard conflict", () => {
	it("different wildcard names at same position → throws", async () => {
		const { mergeTree } = await import("../../src/tree.ts")

		const a = honey<{}>()
		a.get("/files/*path").handler((ctx) => ctx.res.json("ok", {}))

		const b = honey<{}>()
		b.get("/files/*filepath").handler((ctx) => ctx.res.json("ok", {}))

		expect(() => mergeTree(a.toRouteTree(), b.toRouteTree())).toThrow("wildcard name mismatch")
	})

	it("same wildcard name + different methods → merge succeeds", async () => {
		const { mergeTree } = await import("../../src/tree.ts")

		const a = honey<{}>()
		a.get("/files/*path").handler((ctx) => ctx.res.json("ok", {}))

		const b = honey<{}>()
		b.post("/files/*path").handler((ctx) => ctx.res.json("created", {}))

		const merged = mergeTree(a.toRouteTree(), b.toRouteTree())
		const app = honey<{}>()
		app.routeTree(merged)

		const getRes = await app.fetch(new Request("http://localhost/files/doc.txt"), {})
		expect(getRes.status).toBe(200)

		const postRes = await app.fetch(
			new Request("http://localhost/files/doc.txt", { method: "POST" }),
			{},
		)
		expect(postRes.status).toBe(201)
	})
})

/* ══════════════════════════════════════════════
 * 18. MERGETREE — PARAM NAME CONFLICT
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: mergeTree param name conflict", () => {
	it("different param names at same position → throws", async () => {
		const { mergeTree } = await import("../../src/tree.ts")

		const a = honey<{}>()
		a.get("/users/:userId").handler((ctx) => ctx.res.json("ok", {}))

		const b = honey<{}>()
		b.get("/users/:id").handler((ctx) => ctx.res.json("ok", {}))

		expect(() => mergeTree(a.toRouteTree(), b.toRouteTree())).toThrow("param name mismatch")
	})
})

/* ══════════════════════════════════════════════
 * 19. i18n RESOLUTION FAILURE — caught and swallowed
 *
 * index.ts:892-894 — i18n error caught, logged, but doesn't crash.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: i18n resolution failure", () => {
	it("resolveLocale throws → error response still returned", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: {},
			resolveLocale: () => {
				throw new Error("locale resolution failed")
			},
		})
		app.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "not_found", status: "not_found" })
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		/* should still return the error, just without translation */
		expect(res.status).toBe(404)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("not_found")
	})
})

/* ══════════════════════════════════════════════
 * 20. SAFFIRE — TELEMETRY CALLBACK THROWS
 *
 * index.ts:100-112 — safeFire swallows errors from telemetry.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: telemetry callback errors swallowed", () => {
	it("telemetry onRequest throws → request still processed", async () => {
		const app = honey<{}>()
		app.telemetry({
			onRequest: () => {
				throw new Error("telemetry crash")
			},
		})
		app.get("/api").handler((ctx) => ctx.res.json("ok", { works: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})

	it("telemetry onResponse throws → response still returned", async () => {
		const app = honey<{}>()
		app.telemetry({
			onResponse: () => {
				throw new Error("telemetry crash")
			},
		})
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 21. BODYIMIT + INPUT VALIDATION + MIDDLEWARE ORDERING
 *
 * Verify the fix from round 1 holds under stress:
 * bodyLimit runs first (reconstructs body), then middleware,
 * then input validation (reads reconstructed body).
 * ══════════════════════════════════════════════ */

describe("bug-hunt-6: bodyLimit + middleware + input validation triple stack", () => {
	it("bodyLimit → custom middleware → input validation → handler all work", async () => {
		function okSchema() {
			return {
				"~standard": {
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const logMw = createMiddleware(async (_ctx, next) => {
			return next({ logged: true })
		})

		const app = honey<{}>()
			.use(bodyLimit({ maxSize: 10000 }))
			.use(logMw)
		app
			.post("/items")
			.input({ json: okSchema() })
			.handler((ctx) => ctx.res.json("created", { input: ctx.input, logged: ctx.logged }))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ name: "test" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.logged).toBe(true)
		const input = data.input as Record<string, unknown>
		const json = input.json as Record<string, string>
		expect(json.name).toBe("test")
	})
})
