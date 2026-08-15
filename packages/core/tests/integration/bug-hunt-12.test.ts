import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { HoneyError } from "../../src/error.ts"
import { defineErrors } from "../../src/errors.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import "honey/i18n"

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
 * 1. PURE ZERO-MIDDLEWARE FAST PATH
 *
 * No global, no chain, no route middleware at all.
 * index.ts ~line 788: allMiddlewares.length === 0
 * → handler called directly without executeChain.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: pure zero-middleware fast path", () => {
	it("app with no middleware at all → handler called directly", async () => {
		const app = honey<{}>()
		app.get("/fast").handler((ctx) => ctx.res.json("ok", { fast: true }))

		const res = await app.fetch(new Request("http://localhost/fast"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.fast).toBe(true)
	})

	it("zero-middleware route still gets correct ctx properties", async () => {
		const app = honey<{ DB: string }>()
		app.get("/users/:id").handler((ctx) =>
			ctx.res.json("ok", {
				db: ctx.env.DB,
				hasRes: typeof ctx.res.json === "function",
				id: ctx.params.id,
				path: ctx.path,
				routePattern: ctx.routePattern,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/users/42"), { DB: "postgres" })
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.id).toBe("42")
		expect(data.db).toBe("postgres")
		expect(data.path).toBe("/users/42")
		expect(data.routePattern).toBe("/users/:id")
		expect(data.hasRes).toBe(true)
	})
})

/* ══════════════════════════════════════════════
 * 2. DEFAULTERRORS EXPANDS RUNTIME ENFORCEMENT SET
 *
 * Route declares .errors("not_found"), app has
 * .defaultErrors("auth_failed"). Throwing auth_failed
 * should NOT be wrapped as internal_server_error.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: defaultErrors expands enforcement", () => {
	it("defaultErrors key allowed even when route only declares other keys", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		const app = honey<{}>().errorFactory(errors).defaultErrors("auth_failed")

		app
			.get("/item")
			.errors("not_found")
			.handler(() => {
				/* auth_failed is a defaultError, not declared on this route */
				throw errors.auth_failed()
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		/* auth_failed should be allowed (it's in defaultErrors) → 401 */
		expect(res.status).toBe(401)
		const data = (await res.json()) as Record<string, string>
		expect(data.error_key).toBe("auth_failed")
	})

	it("non-default, non-declared error key → wrapped as 500", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
			rate_limited: "too_many_requests",
		})

		const app = honey<{}>().errorFactory(errors).defaultErrors("auth_failed")

		app
			.get("/item")
			.errors("not_found")
			.handler(() => {
				/* rate_limited is NOT in defaultErrors or route errors */
				throw errors.rate_limited()
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		/* rate_limited not allowed → wrapped as 500 */
		expect(res.status).toBe(500)
		const data = (await res.json()) as Record<string, string>
		expect(data.error_key).toBe("internal_server_error")
	})

	it("declared route error still works alongside defaultErrors", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
		})

		const app = honey<{}>().errorFactory(errors).defaultErrors("auth_failed")

		app
			.get("/item")
			.errors("not_found")
			.handler(() => {
				throw errors.not_found()
			})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		expect(res.status).toBe(404)
		const data = (await res.json()) as Record<string, string>
		expect(data.error_key).toBe("not_found")
	})
})

/* ══════════════════════════════════════════════
 * 3. SSE KEEPALIVE TIMER CLEARED ON CALLBACK ERROR
 *
 * When SSE callback throws while keepalive is active,
 * the interval should be cleared and not leak.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: SSE keepalive cleanup on callback error", () => {
	it("callback error with active keepalive → no unhandled interval", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(
				async (stream) => {
					await stream.send({ data: "first", event: "msg" })
					/* throw after first event, while keepalive is active */
					throw new Error("callback died")
				},
				{ keepalive: 10 },
			),
		)

		const res = await app.fetch(new Request("http://localhost/events"), {})
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toContain("data: first")
		/* if keepalive leaked, we'd see ongoing heartbeats — but stream is closed */
	})
})

/* ══════════════════════════════════════════════
 * 4. WILDCARD VS STATIC — insertion order shouldn't matter
 *
 * Register wildcard FIRST, then static. Static should
 * still win because matchRoute checks static before wildcard.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: wildcard vs static — insertion order", () => {
	it("wildcard registered BEFORE static → static still wins", async () => {
		const app = honey<{}>()
		/* wildcard first */
		app
			.get("/files/*path")
			.handler((ctx) => ctx.res.json("ok", { match: "wildcard", path: ctx.params.path }))
		/* static second */
		app.get("/files/readme").handler((ctx) => ctx.res.json("ok", { match: "static" }))

		/* static wins regardless of insertion order */
		const r1 = await app.fetch(new Request("http://localhost/files/readme"), {})
		expect(r1.status).toBe(200)
		expect(((await r1.json()) as Record<string, string>).match).toBe("static")

		/* wildcard catches everything else */
		const r2 = await app.fetch(new Request("http://localhost/files/other.txt"), {})
		expect(r2.status).toBe(200)
		expect(((await r2.json()) as Record<string, string>).match).toBe("wildcard")
	})
})

/* ══════════════════════════════════════════════
 * 5. HONEY.USE() COPIES ALL SETTINGS
 *
 * When use() creates a new Honey instance, it should
 * preserve: defaults, errorFactory, errorFormatter,
 * errorI18n, onError, onNotFound,
 * onMethodNotAllowed, telemetry.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: use() preserves all settings", () => {
	it("onError survives use()", async () => {
		const app = honey<{}>()
		app.onError(
			(_e, _ctx) =>
				new Response(JSON.stringify({ custom: true }), {
					headers: { "content-type": "application/json" },
					status: 503,
				}),
		)

		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/fail").handler(() => {
			throw new Error("boom")
		})

		const res = await authed.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(503)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.custom).toBe(true)
	})

	it("onNotFound survives use()", async () => {
		const app = honey<{}>()
		app.onNotFound(() => new Response("custom 404", { status: 404 }))

		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await authed.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		expect(await res.text()).toBe("custom 404")
	})

	it("onMethodNotAllowed survives use()", async () => {
		const app = honey<{}>()
		app.onMethodNotAllowed(() => new Response("custom 405", { status: 405 }))

		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/resource").handler((ctx) => ctx.res.json("ok", {}))

		const res = await authed.fetch(
			new Request("http://localhost/resource", { method: "DELETE" }),
			{},
		)
		expect(res.status).toBe(405)
		expect(await res.text()).toBe("custom 405")
	})

	it("errorFormatter survives use()", async () => {
		const app = honey<{}>()
		app.defaultErrorFormatter((_err, _shape) => ({ custom_format: true }))

		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "test", status: "bad_request" })
		})

		const res = await authed.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.custom_format).toBe(true)
	})

	it("telemetry survives use()", async () => {
		let telemetryFired = false
		const app = honey<{}>()
		app.telemetry({
			onRequest: () => {
				telemetryFired = true
			},
		})

		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		await authed.fetch(new Request("http://localhost/api"), {})
		expect(telemetryFired).toBe(true)
	})

	it("errorI18n survives use()", async () => {
		const app = honey<{}>()
		app.errorI18n({
			errors: { en: { test: "Translated" } },
			resolveLocale: () => "en",
		})

		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "test", status: "bad_request" })
		})

		const res = await authed.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(400)
		const data = (await res.json()) as Record<string, string>
		expect(data.message).toBe("Translated")
	})

	it("defaults survives use()", async () => {
		const app = honey<{}>().basePath("/api")
		const authed = app.use(createMiddleware(async (_ctx, next) => next()))
		authed.get("/users").handler((ctx) => ctx.res.json("ok", {}))

		const res = await authed.fetch(new Request("http://localhost/api/users"), {})
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 6. PARSEDSEARCHPARAMS vs CTX.SEARCH CONSISTENCY
 *
 * Both use the same array-building logic for duplicates.
 * Verify they produce identical results.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: search params consistency", () => {
	it("input validation search and ctx.search produce same structure", async () => {
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
			.get("/search")
			.input({ search: okSchema() })
			.handler((ctx) => {
				const inputSearch = (ctx.input as Record<string, unknown>).search as Record<string, unknown>
				return ctx.res.json("ok", {
					ctxSearch: ctx.search,
					ctxSearchAll: ctx.searchAll,
					inputSearch,
				})
			})

		const res = await app.fetch(new Request("http://localhost/search?tags=a&tags=b&q=hello"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, Record<string, unknown>>
		/* ctx.search returns first value only */
		expect(data.ctxSearch.tags).toBe("a")
		expect(data.ctxSearch.q).toBe("hello")
		/* ctx.searchAll returns all values as arrays */
		expect(data.ctxSearchAll.tags).toEqual(["a", "b"])
		expect(data.ctxSearchAll.q).toEqual(["hello"])
		/* input validation still passes multi-value to schema */
		expect(data.inputSearch.tags).toEqual(["a", "b"])
		expect(data.inputSearch.q).toBe("hello")
	})
})

/* ══════════════════════════════════════════════
 * 7. NODE ADAPTER — socket destroyed mid-stream
 *
 * What happens when the client disconnects while
 * the server is still writing response body chunks?
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: Node adapter — socket destroyed mid-stream", () => {
	it("client aborts during large response → server handles cleanly", async () => {
		const app = honey<{}>()
		app.get("/big").handler((ctx) => {
			function* gen() {
				for (let i = 0; i < 10000; i++) {
					yield `line ${i}: ${"x".repeat(100)}\n`
				}
			}
			return ctx.res.generate(gen(), { contentType: "text/plain" })
		})
		app.get("/health").handler((ctx) => ctx.res.json("ok", { alive: true }))

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* start a large response then abort early */
		await new Promise<void>((resolve) => {
			const req = http.request(
				{ hostname: "127.0.0.1", method: "GET", path: "/big", port: addr.port },
				(res) => {
					res.once("data", () => {
						res.destroy()
						resolve()
					})
				},
			)
			req.end()
		})

		/* wait for cleanup */
		await new Promise((r) => setTimeout(r, 50))

		/* server should still respond */
		const health = await request(addr.port, "/health")
		expect(health.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 8. CTX.SEARCH WITH PRE-PARSED URL
 *
 * When the URL is pre-parsed (passed to HoneyContext
 * constructor via opts.url), ctx.search should use that
 * URL's search params, not re-parse from req.url.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: ctx.search uses pre-parsed URL", () => {
	it("fetch provides pre-parsed URL → ctx.search uses it", async () => {
		const app = honey<{}>()
		app.get("/search").handler((ctx) => ctx.res.json("ok", { q: ctx.search.q }))

		/* app.fetch pre-parses the URL before passing to HoneyContext */
		const res = await app.fetch(new Request("http://localhost/search?q=from-url"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.q).toBe("from-url")
	})
})

/* ══════════════════════════════════════════════
 * 9. ERROR ENFORCEMENT — no error keys declared → full factory
 *
 * When handler.ek.size === 0 (no errors declared, no defaults),
 * the enforcement check at line 846 is skipped entirely.
 * Any error key should pass through.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: error enforcement — no keys declared", () => {
	it("route with no .errors() → any error key passes through", async () => {
		const errors = defineErrors({
			auth_failed: "unauthorized",
			not_found: "not_found",
		})

		const app = honey<{}>().errorFactory(errors)
		/* no .errors() on the route, no .defaultErrors() on the app */
		app.get("/item").handler(() => {
			throw errors.auth_failed()
		})

		const res = await app.fetch(new Request("http://localhost/item"), {})
		/* auth_failed should pass through (no enforcement) → 401 */
		expect(res.status).toBe(401)
		const data = (await res.json()) as Record<string, string>
		expect(data.error_key).toBe("auth_failed")
	})
})

/* ══════════════════════════════════════════════
 * 10. ETAG MIDDLEWARE — skips empty body (0 bytes)
 *
 * etag.ts:43 — body.byteLength === 0 → returns original.
 * What about a JSON response that is literally "null"?
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: ETag — edge case bodies", () => {
	it("JSON null body → has bytes, gets ETag", async () => {
		const app = honey<{}>().use(etag())
		app.get("/null").handler((ctx) => ctx.res.json("ok", null))

		const res = await app.fetch(new Request("http://localhost/null"), {})
		expect(res.status).toBe(200)
		/* "null" is 4 bytes, should get ETag */
		expect(res.headers.get("etag")).toBeTruthy()
		expect(await res.text()).toBe("null")
	})

	it("empty string text body → 0 bytes, no ETag", async () => {
		const app = honey<{}>().use(etag())
		app.get("/empty").handler((ctx) => ctx.res.text("ok", ""))

		const res = await app.fetch(new Request("http://localhost/empty"), {})
		expect(res.status).toBe(200)
		/* empty string = 0 bytes → no ETag */
		expect(res.headers.get("etag")).toBeNull()
	})
})

/* ══════════════════════════════════════════════
 * 11. ALL HTTP METHODS — handler registered for each
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: all HTTP method registrations", () => {
	it("all 7 methods + ALL → each responds correctly", async () => {
		const app = honey<{}>()
		app.get("/m").handler((ctx) => ctx.res.json("ok", { m: "GET" }))
		app.post("/m").handler((ctx) => ctx.res.json("created", { m: "POST" }))
		app.put("/m").handler((ctx) => ctx.res.json("ok", { m: "PUT" }))
		app.patch("/m").handler((ctx) => ctx.res.json("ok", { m: "PATCH" }))
		app.delete("/m").handler((ctx) => ctx.res.json("ok", { m: "DELETE" }))
		app.options("/m").handler((ctx) => ctx.res.noContent())
		app.head("/m").handler((ctx) => ctx.res.json("ok", { m: "HEAD" }))

		for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const) {
			const res = await app.fetch(new Request("http://localhost/m", { method }), {})
			if (method === "OPTIONS") {
				expect(res.status).toBe(204)
			} else if (method === "POST") {
				expect(res.status).toBe(201)
			} else {
				expect(res.status).toBe(200)
			}
		}
	})
})

/* ══════════════════════════════════════════════
 * 12. MIDDLEWARE TIMING TELEMETRY — named vs anonymous
 *
 * index.ts:760 — mw.name || "anonymous".
 * Named functions should show their name in telemetry.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-12: middleware timing telemetry names", () => {
	it("named middleware → telemetry receives name", async () => {
		const mwNames: string[] = []
		const app = honey<{}>()
		app.telemetry({
			onMiddleware: (ctx) => {
				mwNames.push(ctx.name)
			},
		})

		const namedMw = createMiddleware(async (_ctx, next) => next())
		Object.defineProperty(namedMw, "name", { value: "authMiddleware" })

		app
			.get("/test")
			.use(namedMw)
			.handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(mwNames).toContain("authMiddleware")
	})

	it("anonymous middleware → telemetry receives 'anonymous'", async () => {
		const mwNames: string[] = []
		const app = honey<{}>()
		app.telemetry({
			onMiddleware: (ctx) => {
				mwNames.push(ctx.name)
			},
		})

		app
			.get("/test")
			.use(createMiddleware(async (_ctx, next) => next()))
			.handler((ctx) => ctx.res.json("ok", {}))

		await app.fetch(new Request("http://localhost/test"), {})
		expect(mwNames.some((n) => n === "anonymous" || n === "")).toBe(true)
	})
})
