import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import type { HoneyError } from "../../src/error.ts"
import { defineErrors } from "../../src/errors.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { readableStream } from "../../src/input.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"

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
 * 1. MALFORMED JSON BODY → error
 *
 * validation.ts:267 — req.json() throws SyntaxError
 * on invalid JSON. Should become 500 since it's not
 * a HoneyError (it's a raw JS error from JSON.parse).
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: malformed JSON body", () => {
	it("invalid JSON body → 500 (SyntaxError from req.json())", async () => {
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
			.post("/api")
			.input({ json: okSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: "{invalid json!!!",
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(500)
	})

	it("valid JSON after malformed request → works (no state leak)", async () => {
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
			.post("/api")
			.input({ json: okSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		/* malformed first */
		await app.fetch(
			new Request("http://localhost/api", {
				body: "not json",
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)

		/* valid second */
		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: JSON.stringify({ ok: true }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
	})
})

/* ══════════════════════════════════════════════
 * 2. INPUT VALIDATION — both json and form schemas, wrong CT
 *
 * validation.ts:282-286 — when content-type doesn't match
 * either json or form, throws unsupported_media_type.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: input validation — wrong content-type for declared schemas", () => {
	it("json schema + xml content-type → 415", async () => {
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
			.post("/api")
			.input({ json: okSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: "<xml/>",
				headers: { "content-type": "application/xml" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(415)
		const data = (await res.json()) as Record<string, string>
		expect(data.error_key).toBe("unsupported_media_type")
	})

	it("form schema + text/plain content-type → 415", async () => {
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
				body: "just plain text",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(415)
	})
})

/* ══════════════════════════════════════════════
 * 3. OUTPUT VALIDATION — no content-type on response
 *
 * index.ts:795 — if (ct) — when ct is null, both mismatch
 * check AND json validation are skipped entirely.
 * A noContent() response with output schema passes silently.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: output validation — null content-type bypass", () => {
	it("noContent response with output schema → passes (no CT to validate)", async () => {
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
		app.outputValidation("always")
		app
			.delete("/items/:id")
			.output({ "application/json": { ok: okSchema() } })
			.handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/items/1", { method: "DELETE" }), {})
		/* noContent has no content-type → output validation skipped */
		expect(res.status).toBe(204)
	})
})

/* ══════════════════════════════════════════════
 * 4. OUTPUT VALIDATION — unmapped status code → skips JSON check
 *
 * index.ts:808-809 — codeToStatusKey[206] is undefined,
 * so JSON schema validation is skipped for custom status codes.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: output validation — unmapped status code", () => {
	it("custom status code 206 → output JSON validation skipped", async () => {
		function strictSchema() {
			return {
				"~standard": {
					validate: () => {
						return { issues: [{ message: "always fails", path: [] }] }
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app.outputValidation("always")
		app
			.get("/partial")
			.output({ "application/json": { ok: strictSchema() } })
			.handler((ctx) => {
				/* return 206 which is not in codeToStatusKey mapping */
				return ctx.res.raw(
					new Response(JSON.stringify({ partial: true }), {
						headers: { "content-type": "application/json" },
						status: 206,
					}),
				)
			})

		const res = await app.fetch(new Request("http://localhost/partial"), {})
		/* 206 not in codeToStatusKey → sk is undefined → validation skipped */
		expect(res.status).toBe(206)
	})
})

/* ══════════════════════════════════════════════
 * 5. HANDLER MAP PATCH MODE — error factory pre-computation
 *
 * index.ts:1272-1283 — when patching, ef is pre-computed
 * from factory + handler.ek. Test the full patch + ef flow.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: handler map patch mode — error factory", () => {
	it("patched handler gets pre-computed error factory subset", async () => {
		const errors = defineErrors({
			item_not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		/* build initial app */
		const initial = honey<{}>().errorFactory(errors)
		initial
			.get("/items/:id")
			.errors("item_not_found")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		/* extract route tree with handler map */
		const tree = initial.toRouteTree()
		const handlers: Record<string, unknown> = {}
		function collectHandlers(node: Record<string, unknown>, prefix: string) {
			const m = node.m as Record<string, unknown> | null
			if (m) {
				for (const [method, handler] of Object.entries(m)) {
					handlers[`${method} ${prefix || "/"}`] = handler
				}
			}
			const s = node.s as Record<string, Record<string, unknown>>
			for (const [seg, child] of Object.entries(s)) {
				collectHandlers(child, `${prefix}/${seg}`)
			}
			const d = node.d as { c: Record<string, unknown>; n: string } | null
			if (d) {
				collectHandlers(d.c, `${prefix}/:${d.n}`)
			}
		}
		collectHandlers(tree.root as unknown as Record<string, unknown>, "")

		/* create patched app with handler map */
		const patched = honey<{}>().errorFactory(errors)
		patched.routeTree({ ...tree, handlers: handlers as Record<string, never> })

		/* re-register with new handler — this triggers patch mode */
		patched
			.get("/items/:id")
			.errors("item_not_found")
			.handler((ctx) => {
				/* ctx.errors should have pre-computed factory with item_not_found */
				const errFactory = ctx.errors as Record<string, () => HoneyError>
				if (!ctx.params.id || ctx.params.id === "0") {
					throw errFactory.item_not_found()
				}
				return ctx.res.json("ok", { id: ctx.params.id, patched: true })
			})

		/* valid request */
		const r1 = await patched.fetch(new Request("http://localhost/items/42"), {})
		expect(r1.status).toBe(200)
		const d1 = (await r1.json()) as Record<string, unknown>
		expect(d1.patched).toBe(true)

		/* error via pre-computed factory */
		const r2 = await patched.fetch(new Request("http://localhost/items/0"), {})
		expect(r2.status).toBe(404)
		const d2 = (await r2.json()) as Record<string, string>
		expect(d2.error_key).toBe("item_not_found")
	})
})

/* ══════════════════════════════════════════════
 * 6. STREAM INPUT MODE — multipart form with files
 *
 * validation.ts:273-276 — stream mode splits text from files,
 * validates text only, merges files back.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: readableStream for multipart form data", () => {
	it("readableStream for form → body not consumed, handler reads manually", async () => {
		function textSchema() {
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
			.post("/upload")
			.input({ form: readableStream(textSchema()) })
			.handler(async (ctx) => {
				/* body untouched — read manually */
				const fd = await ctx.req.formData()
				return ctx.res.json("created", {
					hasFile: fd.get("file") instanceof File,
					title: fd.get("title"),
				})
			})

		const formData = new FormData()
		formData.append("title", "My Document")
		formData.append("file", new Blob(["file content"], { type: "text/plain" }), "doc.txt")

		const res = await app.fetch(
			new Request("http://localhost/upload", {
				body: formData,
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.title).toBe("My Document")
		expect(data.hasFile).toBe(true)
	})

	it("readableStream for form → validation never called", async () => {
		let validateCalled = false
		function trackSchema() {
			return {
				"~standard": {
					validate: () => {
						validateCalled = true
						return { issues: [{ message: "should not run", path: [] }] }
					},
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/upload")
			.input({ form: readableStream(trackSchema()) })
			.handler(async (ctx) => {
				const fd = await ctx.req.formData()
				return ctx.res.json("created", { name: fd.get("name") })
			})

		const formData = new FormData()
		formData.append("name", "test")

		const res = await app.fetch(
			new Request("http://localhost/upload", {
				body: formData,
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		expect(validateCalled).toBe(false)
	})
})

/* ══════════════════════════════════════════════
 * 7. MULTIPART FORM — standard validation mode
 *
 * validation.ts:277-278 — standard mode with multipart.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: multipart form — standard validation", () => {
	it("multipart form with standard schema → formDataToRecord", async () => {
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

		const formData = new FormData()
		formData.append("name", "Alice")
		formData.append("email", "alice@test.com")

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: formData,
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		const form = data.form as Record<string, string>
		expect(form.name).toBe("Alice")
		expect(form.email).toBe("alice@test.com")
	})
})

/* ══════════════════════════════════════════════
 * 8. ETAG — handler response with cookies preserved through reconstruction
 *
 * etag reconstructs the response via new Response(body, { headers }).
 * Cookies are set via Set-Cookie headers on the original response.
 * Verify they survive the reconstruction.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: ETag response reconstruction preserves Set-Cookie", () => {
	it("response with cookies → cookies survive ETag reconstruction", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ data: "value" },
				{
					cookies: {
						session: { httpOnly: true, path: "/", value: "tok-1" },
						theme: { path: "/", value: "dark" },
					},
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/data")
		expect(res.status).toBe(200)
		expect(res.headers.etag).toBeTruthy()

		/* cookies must survive the response reconstruction */
		const cookies = res.headers["set-cookie"]
		expect(cookies).toBeTruthy()
		const cookieArr = Array.isArray(cookies) ? cookies : ([cookies as string | undefined].filter(Boolean) as string[])
		expect(cookieArr.length).toBe(2)
		const allCookies = cookieArr.join("; ")
		expect(allCookies).toContain("session=tok-1")
		expect(allCookies).toContain("theme=dark")
	})
})

/* ══════════════════════════════════════════════
 * 9. GLOBAL MIDDLEWARES — run on matched routes only
 *
 * Global middlewares are prepended to handler.mw.
 * They DON'T run on 404/405 (only chain middlewares do).
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: global vs chain middleware behavior", () => {
	it("chain middleware runs on 404, route middleware does not", async () => {
		const order: string[] = []

		const chainMw = createMiddleware(async (_ctx, next) => {
			order.push("chain")
			return next()
		})
		const routeMw = createMiddleware(async (_ctx, next) => {
			order.push("route")
			return next()
		})

		const app = honey<{}>().use(chainMw)
		app
			.get("/exists")
			.use(routeMw)
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.json("ok", {})
			})

		/* 404 → only chain middleware runs */
		order.length = 0
		await app.fetch(new Request("http://localhost/nope"), {})
		expect(order).toEqual(["chain"])

		/* matched → chain + route + handler */
		order.length = 0
		await app.fetch(new Request("http://localhost/exists"), {})
		expect(order).toEqual(["chain", "route", "handler"])
	})
})

/* ══════════════════════════════════════════════
 * 10. BODYLIMIT — request with Content-Length header
 *    that matches body exactly at boundary
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: bodyLimit — Content-Length fast path edge", () => {
	it("Content-Length exactly at maxSize → passes fast path", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 5 }))
		app.post("/echo").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.text("ok", text)
		})

		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "12345",
				headers: { "content-length": "5" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("Content-Length one over maxSize → 413 via fast path (no body read)", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 5 }))
		app.post("/echo").handler(async (ctx) => {
			const text = await ctx.req.text()
			return ctx.res.text("ok", text)
		})

		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "123456",
				headers: { "content-length": "6" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(413)
	})
})

/* ══════════════════════════════════════════════
 * 11. BODYLIMIT + ETAG + INPUT VALIDATION — three-way interaction
 *
 * This is the most complex middleware ordering test:
 * bodyLimit (reconstructs body) → etag (on GET only) →
 * input validation (reads body for POST).
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: bodyLimit + etag + input validation", () => {
	it("POST with bodyLimit + input validation → body read works", async () => {
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
			.use(bodyLimit({ maxSize: 50000 }))
			.use(etag())
		app
			.post("/items")
			.input({ json: okSchema() })
			.handler((ctx) => ctx.res.json("created", ctx.input))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ name: "Widget" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, unknown>
		const json = data.json as Record<string, string>
		expect(json.name).toBe("Widget")
	})

	it("GET with bodyLimit + etag → ETag computed", async () => {
		const app = honey<{}>()
			.use(bodyLimit({ maxSize: 50000 }))
			.use(etag())
		app.get("/items").handler((ctx) => ctx.res.json("ok", []))

		const res = await app.fetch(new Request("http://localhost/items"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("etag")).toBeTruthy()
	})
})

/* ══════════════════════════════════════════════
 * 12. CORS + ETAG INTERACTION ON 304
 *
 * When CORS wraps etag, the 304 from etag is returned
 * to CORS which then adds headers to it. The CORS
 * middleware uses response.headers.set() on the 304.
 * Verify this chain works.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: CORS modifies ETag 304 response", () => {
	it("CORS outside etag → 304 gets CORS headers + Vary", async () => {
		const app = honey<{}>()
			.use(cors({ origin: "http://app.com" }))
			.use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { v: 1 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* first request to get ETag */
		const first = await request(addr.port, "/data", {
			headers: { origin: "http://app.com" },
		})
		expect(first.headers.etag).toBeTruthy()

		/* conditional → 304 with CORS */
		const second = await request(addr.port, "/data", {
			headers: {
				"if-none-match": first.headers.etag as string,
				origin: "http://app.com",
			},
		})
		expect(second.status).toBe(304)
		expect(second.headers["access-control-allow-origin"]).toBe("http://app.com")
		expect(second.headers.etag).toBe(first.headers.etag)
		/* Vary should include Origin for non-wildcard CORS */
		const vary = second.headers.vary
		expect(vary).toBeTruthy()
	})
})

/* ══════════════════════════════════════════════
 * 13. ROUTE TREE ROUND-TRIP — toRouteTree() → routeTree()
 *
 * Build an app, export tree, import into new app → routes work.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-11: route tree round-trip", () => {
	it("export tree → import → all routes accessible", async () => {
		const original = honey<{}>()
		original.get("/users").handler((ctx) => ctx.res.json("ok", { route: "list" }))
		original.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, route: "detail" }))
		original.post("/users").handler((ctx) => ctx.res.json("created", { route: "create" }))

		const tree = original.toRouteTree()
		const clone = honey<{}>()
		clone.routeTree(tree)

		const r1 = await clone.fetch(new Request("http://localhost/users"), {})
		expect(r1.status).toBe(200)
		expect(((await r1.json()) as Record<string, string>).route).toBe("list")

		const r2 = await clone.fetch(new Request("http://localhost/users/42"), {})
		expect(r2.status).toBe(200)
		expect(((await r2.json()) as Record<string, string>).id).toBe("42")

		const r3 = await clone.fetch(new Request("http://localhost/users", { method: "POST" }), {})
		expect(r3.status).toBe(201)
	})
})
