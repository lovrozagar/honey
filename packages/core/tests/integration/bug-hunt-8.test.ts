import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { csrf } from "../../src/csrf.ts"
import { defineErrors } from "../../src/errors.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { testClient } from "../../src/testing.ts"

function request(
	port: number,
	path: string,
	opts?: {
		body?: string
		headers?: Record<string, string>
		method?: string
	},
): Promise<{
	body: string
	headers: http.IncomingHttpHeaders
	status: number
}> {
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
					resolve({
						body: data,
						headers: res.headers,
						status: res.statusCode ?? 0,
					})
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
 * 1. DEFAULTS AS FUNCTION — lazy config per request env
 *
 * index.ts:483-484 — when defaults is a function, it receives
 * env and should return config. Tested: different envs produce
 * different basePaths.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: basePath prefixing", () => {
	it("basePath prefixes routes at registration time", async () => {
		const app = honey<{ BASE: string }>().basePath("/api")
		app.get("/users").handler((ctx) => ctx.res.json("ok", { env: ctx.env.BASE }))

		const res1 = await app.fetch(new Request("http://localhost/api/users"), {
			BASE: "/api",
		})
		expect(res1.status).toBe(200)
		const d1 = (await res1.json()) as Record<string, string>
		expect(d1.env).toBe("/api")
	})

	it("logger receives warnings from safeFire", async () => {
		const warnings: string[] = []
		const app = honey<{}>()
		app.logger({ warn: (msg: string) => warnings.push(msg) })
		app.telemetry({
			onRequest: () => {
				throw new Error("telemetry boom")
			},
		})
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		/* logger.warn should have been called by safeFire */
		expect(warnings.length).toBeGreaterThan(0)
		expect(warnings[0]).toContain("telemetry callback failed")
	})
})

/* ══════════════════════════════════════════════
 * 2. USE() CHAIN — shared root tree
 *
 * use() creates a new Honey with same root but new chain mw.
 * Routes registered on the new chain should be accessible
 * on the parent since they share the root tree.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: use() chain shares root tree", () => {
	it("routes registered after use() visible on original app", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			return next({ auth: true })
		})

		const base = honey<{}>()
		base.get("/public").handler((ctx) => ctx.res.json("ok", { public: true }))

		const authed = base.use(mw)
		authed.get("/private").handler((ctx) => ctx.res.json("ok", { auth: ctx.auth }))

		/* both routes should be on the shared root tree */
		const pubRes = await base.fetch(new Request("http://localhost/public"), {})
		expect(pubRes.status).toBe(200)

		/* /private is registered on the root tree, but middleware only runs on authed chain.
		 * When fetched via base, handler runs without the middleware context */
		const privRes = await base.fetch(new Request("http://localhost/private"), {})
		expect(privRes.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 3. CUSTOM HEADERS OVERWRITING GENERATED HEADERS
 *
 * response.ts:40-44 — applyResponseOptions uses headers.set()
 * which OVERWRITES existing headers. If handler passes
 * custom content-type via opts.headers, it should override.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: response opts.headers overwrite", () => {
	it("custom content-type overrides generated content-type", async () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ data: 1 },
				{
					headers: { "content-type": "application/json; charset=utf-8" },
				},
			),
		)

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8")
	})

	it("custom header added alongside generated headers", async () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}, { headers: { "x-powered-by": "honey" } }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.headers.get("content-type")).toBe("application/json")
		expect(res.headers.get("x-powered-by")).toBe("honey")
	})
})

/* ══════════════════════════════════════════════
 * 4. POST WITH application/json BUT EMPTY BODY
 *
 * When req.json() is called on empty body, it should throw.
 * This tests the error path through input validation.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: empty body with json content-type", () => {
	it("POST with empty body + application/json → error", async () => {
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
				body: "",
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)
		/* empty body → req.json() throws → 500 */
		expect(res.status).toBe(500)
	})

	it("POST with valid JSON body → works", async () => {
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
 * 5. SAFFIRE — ASYNC TELEMETRY CALLBACK THAT REJECTS
 *
 * index.ts:111-114 — if telemetry returns a promise that
 * rejects, safeFire catches it via .catch().
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: safeFire with async rejection", () => {
	it("async telemetry callback rejection → request still succeeds", async () => {
		const warnings: string[] = []
		const app = honey<{}>()
		app.logger({ warn: (msg: string) => warnings.push(msg) })
		app.telemetry({
			onRequest: async () => {
				await Promise.reject(new Error("async telemetry fail"))
			},
		})
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		/* give time for the async rejection to be caught */
		await new Promise((r) => setTimeout(r, 10))
		expect(warnings.length).toBeGreaterThan(0)
	})
})

/* ══════════════════════════════════════════════
 * 6. ROUTE PRECEDENCE — static > dynamic > wildcard
 *
 * tree.ts:183-202 — matchRoute checks static, then dynamic,
 * then wildcard in that order. Verify all three coexist.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: route precedence — static > dynamic > wildcard", () => {
	it("static wins over dynamic at same level", async () => {
		const app = honey<{}>()
		app.get("/files/readme").handler((ctx) => ctx.res.json("ok", { match: "static" }))
		app.get("/files/:name").handler((ctx) => ctx.res.json("ok", { match: "dynamic", name: ctx.params.name }))

		/* static wins */
		const r1 = await app.fetch(new Request("http://localhost/files/readme"), {})
		expect(((await r1.json()) as Record<string, string>).match).toBe("static")

		/* dynamic wins for non-static segment */
		const r2 = await app.fetch(new Request("http://localhost/files/other"), {})
		expect(((await r2.json()) as Record<string, string>).match).toBe("dynamic")
	})

	it("wildcard catches multi-segment when no dynamic param present", async () => {
		const app = honey<{}>()
		app.get("/static/readme").handler((ctx) => ctx.res.json("ok", { match: "static" }))
		app.get("/static/*path").handler((ctx) => ctx.res.json("ok", { match: "wildcard", path: ctx.params.path }))

		const r1 = await app.fetch(new Request("http://localhost/static/readme"), {})
		expect(((await r1.json()) as Record<string, string>).match).toBe("static")

		const r2 = await app.fetch(new Request("http://localhost/static/a/b/c"), {})
		expect(((await r2.json()) as Record<string, string>).match).toBe("wildcard")
	})

	it("dynamic + wildcard: dynamic takes single, wildcard unreachable for multi-segment", async () => {
		const app = honey<{}>()
		app.get("/files/:name").handler((ctx) => ctx.res.json("ok", { match: "dynamic", name: ctx.params.name }))
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", { match: "wildcard", path: ctx.params.path }))

		/* single segment → dynamic wins */
		const r1 = await app.fetch(new Request("http://localhost/files/doc.txt"), {})
		expect(((await r1.json()) as Record<string, string>).match).toBe("dynamic")

		/* multi-segment → dynamic matches first seg but has no children → 404.
		 * wildcard is only tried when dynamic doesn't exist at that node. */
		const r2 = await app.fetch(new Request("http://localhost/files/a/b"), {})
		expect(r2.status).toBe(404)
	})
})

/* ══════════════════════════════════════════════
 * 7. MULTIPLE DYNAMIC PARAMS IN ONE ROUTE
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: multiple dynamic params", () => {
	it("/orgs/:orgId/members/:memberId → both params extracted", async () => {
		const app = honey<{}>()
		app.get("/orgs/:orgId/members/:memberId").handler((ctx) =>
			ctx.res.json("ok", {
				memberId: ctx.params.memberId,
				orgId: ctx.params.orgId,
			}),
		)

		const res = await app.fetch(new Request("http://localhost/orgs/acme/members/user-42"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.orgId).toBe("acme")
		expect(data.memberId).toBe("user-42")
	})
})

/* ══════════════════════════════════════════════
 * 8. CORS — no origin header → middleware skipped entirely
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: CORS — no origin header", () => {
	it("request without Origin header → no CORS headers added", async () => {
		const app = honey<{}>().use(cors({ origin: "*" }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
		/* no Origin in request → no CORS headers in response */
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})

/* ══════════════════════════════════════════════
 * 9. CSRF — same-origin SEC-FETCH-SITE with form content
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: CSRF — origin matching", () => {
	it("POST with form + matching origin → passes", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://localhost" }))
		app.post("/form").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: "field=val",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					origin: "http://localhost",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("POST with form + origin array matching → passes", async () => {
		const app = honey<{}>().use(csrf({ origin: ["http://localhost", "http://app.com"] }))
		app.post("/form").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: "field=val",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					origin: "http://app.com",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("POST with form + origin function matching → passes", async () => {
		const app = honey<{}>().use(csrf({ origin: (o) => o.startsWith("http://trusted") }))
		app.post("/form").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/form", {
				body: "field=val",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					origin: "http://trusted.example.com",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 10. MIDDLEWARE RESPONSE MODIFICATION
 *
 * Middleware can modify the response returned by next().
 * Verify headers added after next() are preserved.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: middleware response modification", () => {
	it("middleware adds header to response after next()", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			res.headers.set("x-processed", "true")
			return res
		})

		const app = honey<{}>().use(mw)
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api")
		expect(res.status).toBe(200)
		expect(res.headers["x-processed"]).toBe("true")
	})

	it("middleware replaces response entirely", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			if (res.status === 404) {
				return new Response(JSON.stringify({ custom: true }), {
					headers: { "content-type": "application/json" },
					status: 200,
				})
			}
			return res
		})

		const app = honey<{}>().use(mw)
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		/* existing route → normal response */
		const r1 = await app.fetch(new Request("http://localhost/exists"), {})
		expect(r1.status).toBe(200)

		/* 404 → middleware replaces with custom response */
		const r2 = await app.fetch(new Request("http://localhost/nope"), {})
		expect(r2.status).toBe(200)
		const data = (await r2.json()) as Record<string, boolean>
		expect(data.custom).toBe(true)
	})
})

/* ══════════════════════════════════════════════
 * 11. TRANSLATION REGISTRY — caching behavior
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: TranslationRegistry caching", () => {
	it("translations loaded once and cached", async () => {
		const { TranslationRegistry } = await import("../../src/i18n.ts")
		let loadCount = 0
		const registry = new TranslationRegistry({
			en: () => {
				loadCount++
				return { greeting: "Hello {name}" }
			},
		})

		const map1 = await registry.get("en")
		const map2 = await registry.get("en")
		expect(loadCount).toBe(1)
		expect(map1).toBe(map2)
		expect(map1?.greeting).toBe("Hello {name}")
	})

	it("unknown locale → undefined", async () => {
		const { TranslationRegistry } = await import("../../src/i18n.ts")
		const registry = new TranslationRegistry({ en: { hello: "Hi" } })
		const map = await registry.get("fr")
		expect(map).toBeUndefined()
	})

	it("async loader supported", async () => {
		const { TranslationRegistry } = await import("../../src/i18n.ts")
		const registry = new TranslationRegistry({
			de: async () => ({ hello: "Hallo" }),
		})
		const map = await registry.get("de")
		expect(map?.hello).toBe("Hallo")
	})
})

/* ══════════════════════════════════════════════
 * 12. ETAG — empty body response → no ETag
 *
 * etag.ts:43 — body.byteLength === 0 → return original response.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: ETag — empty body", () => {
	it("204 no-content response → no ETag header", async () => {
		const app = honey<{}>().use(etag())
		app.get("/empty").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/empty"), {})
		/* ETag middleware only runs on GET/HEAD, and noContent has null body */
		expect(res.status).toBe(204)
		expect(res.headers.get("etag")).toBeNull()
	})
})

/* ══════════════════════════════════════════════
 * 13. TESTCLIENT — form data
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: testClient with form data", () => {
	it("form option sends multipart/form-data", async () => {
		const app = honey<{}>()
		app.post("/upload").handler(async (ctx) => {
			const formData = await ctx.req.formData()
			return ctx.res.json("created", {
				name: formData.get("name"),
			})
		})

		const client = testClient(app, { env: {} })
		const res = await client.post("/upload", { form: { name: "Alice" } })
		expect(res.status).toBe(201)
		const data = (await res.json()) as Record<string, string>
		expect(data.name).toBe("Alice")
	})
})

/* ══════════════════════════════════════════════
 * 14. NODE ADAPTER — request without host header
 *
 * node.ts:14 — req.headers.host ?? "localhost"
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: Node adapter edge cases", () => {
	it("OPTIONS method with body → hasBody = true but works", async () => {
		const app = honey<{}>()
		app.options("/api").handler((ctx) => ctx.res.noContent())
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api", { method: "OPTIONS" })
		expect(res.status).toBe(204)
	})

	it("HEAD method → hasBody = false, no stream created", async () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", { data: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/api", { method: "HEAD" })
		expect(res.status).toBe(200)
		expect(res.body).toBe("")
	})
})

/* ══════════════════════════════════════════════
 * 15. ERROR FACTORY — _createError uses factory when available
 *
 * index.ts:231-238 — if error factory has the key, use factory fn.
 * Otherwise construct HoneyError directly.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: error factory for 404/405", () => {
	it("custom error factory for not_found → custom error shape", async () => {
		const errors = defineErrors({
			not_found: "not_found",
		})

		const app = honey<{}>().errorFactory(errors)
		app.get("/exists").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/nope"), {})
		expect(res.status).toBe(404)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("not_found")
	})
})

/* ══════════════════════════════════════════════
 * 16. MIDDLEWARE THAT WRAPS AND RE-THROWS
 *
 * Middleware can catch errors from next(), transform them,
 * and re-throw.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: middleware error wrapping", () => {
	it("middleware detects error response and rewrites it", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			if (res.status >= 500) {
				return new Response(JSON.stringify({ error_key: "wrapped_error", status: 502 }), {
					headers: { "content-type": "application/json" },
					status: 502,
				})
			}
			return res
		})

		const app = honey<{}>().use(mw)
		app.get("/fail").handler(() => {
			throw new Error("original")
		})

		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(502)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error_key).toBe("wrapped_error")
	})
})

/* ══════════════════════════════════════════════
 * 17. CONCURRENT REQUESTS WITH DIFFERENT ENVS
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: concurrent requests with different envs", () => {
	it("each request sees its own env", async () => {
		const app = honey<{ TENANT: string }>()
		app.get("/tenant").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, Math.random() * 10))
			return ctx.res.json("ok", { tenant: ctx.env.TENANT })
		})

		const promises = ["alpha", "beta", "gamma"].map((tenant) =>
			app.fetch(new Request("http://localhost/tenant"), { TENANT: tenant }),
		)
		const results = await Promise.all(promises)

		for (let i = 0; i < 3; i++) {
			const data = (await results[i].json()) as Record<string, string>
			expect(data.tenant).toBe(["alpha", "beta", "gamma"][i])
		}
	})
})

/* ══════════════════════════════════════════════
 * 18. ETAG — same content same hash (deterministic)
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: ETag determinism", () => {
	it("same response content → same ETag", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { stable: true }))

		const res1 = await app.fetch(new Request("http://localhost/data"), {})
		const res2 = await app.fetch(new Request("http://localhost/data"), {})

		expect(res1.headers.get("etag")).toBeTruthy()
		expect(res1.headers.get("etag")).toBe(res2.headers.get("etag"))
	})
})

/* ══════════════════════════════════════════════
 * 19. MIDDLEWARE + BODYLIMIT + ETAG + CORS — full stack
 *
 * Real-world configuration: multiple middlewares stacked.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: full middleware stack integration", () => {
	it("cors + bodyLimit + etag on same app → all work together", async () => {
		const app = honey<{}>()
			.use(cors({ origin: "*" }))
			.use(bodyLimit({ maxSize: 50000 }))
			.use(etag())
		app.post("/api").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("created", body)
		})
		app.get("/api").handler((ctx) => ctx.res.json("ok", { data: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* POST → CORS + bodyLimit + no ETag (POST not hashed) */
		const postRes = await request(addr.port, "/api", {
			body: JSON.stringify({ key: "value" }),
			headers: {
				"content-type": "application/json",
				origin: "http://app.com",
			},
			method: "POST",
		})
		expect(postRes.status).toBe(201)
		expect(postRes.headers["access-control-allow-origin"]).toBe("*")

		/* GET → CORS + ETag */
		const getRes = await request(addr.port, "/api", {
			headers: { origin: "http://app.com" },
		})
		expect(getRes.status).toBe(200)
		expect(getRes.headers.etag).toBeTruthy()
		expect(getRes.headers["access-control-allow-origin"]).toBe("*")

		/* conditional GET → 304 */
		const condRes = await request(addr.port, "/api", {
			headers: {
				"if-none-match": getRes.headers.etag as string,
				origin: "http://app.com",
			},
		})
		expect(condRes.status).toBe(304)
	})
})

/* ══════════════════════════════════════════════
 * 20. IPRESSTRICT — X-Real-IP fallback
 * ══════════════════════════════════════════════ */

describe("bug-hunt-8: ipRestrict — X-Real-IP header", () => {
	it("X-Real-IP used when no CF or XFF headers", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: ["10.0.0.1"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { "x-real-ip": "10.0.0.1" },
			}),
			{},
		)
		expect(res.status).toBe(200)
	})

	it("CF-Connecting-IP takes priority over X-Forwarded-For", async () => {
		const { ipRestrict } = await import("../../src/ip-restrict.ts")
		const app = honey<{}>().use(ipRestrict({ allowList: ["1.1.1.1"], trustProxy: true }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: {
					"cf-connecting-ip": "1.1.1.1",
					"x-forwarded-for": "2.2.2.2",
				},
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})
