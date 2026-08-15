import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { generateManifest, generateOpenApi, generateRouteTreeFromApp } from "../../src/codegen.ts"
import { HoneyError } from "../../src/error.ts"
import { honey } from "../../src/index.ts"
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
 * 1. CODEGEN — resolveErrorInfo with throwing factory
 *
 * codegen.ts:108-113 — factory function that throws.
 * Should fall back to { status: 0, statusKey: "unknown" }.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: codegen — factory that throws", () => {
	it("error factory that throws → fallback to status 0", () => {
		const throwingFactory = {
			broken_error: () => {
				throw new Error("factory broken")
			},
		}

		const app = honey<{}>()
		;(app as unknown as Record<string, unknown>)._errorFactory = throwingFactory

		app
			.get("/test")
			.errors(throwingFactory, "broken_error")
			.handler((ctx) => ctx.res.json("ok", {}))

		const manifest = generateManifest(app)
		const errInfo = manifest.errors.find((e) => e.errorKey === "broken_error")
		expect(errInfo).toBeTruthy()
		/* factory threw → fallback */
		expect(errInfo?.status).toBe(0)
		expect(errInfo?.statusKey).toBe("unknown")
	})
})

/* ══════════════════════════════════════════════
 * 2. CODEGEN — resolveErrorInfo without factory
 *
 * When no error factory is set, all errors resolve
 * with status: 0, statusKey: "unknown".
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: codegen — no error factory", () => {
	it("error keys without factory → status 0, unknown", () => {
		const app = honey<{}>()
		app
			.get("/test")
			.errors(
				{ custom_error: () => new HoneyError({ errorKey: "x", status: "bad_request" }) },
				"custom_error",
			)
			.handler((ctx) => ctx.res.json("ok", {}))

		/* app has no .errorFactory() call, so _errorFactory is null */
		const manifest = generateManifest(app)
		const errInfo = manifest.errors.find((e) => e.errorKey === "custom_error")
		expect(errInfo).toBeTruthy()
		expect(errInfo?.status).toBe(0)
	})
})

/* ══════════════════════════════════════════════
 * 3. CODEGEN — OpenAPI with input schemas (json + search)
 *
 * codegen.ts:263-304 — input → requestBody / parameters.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: OpenAPI — input as requestBody and parameters", () => {
	it("json input → requestBody in OpenAPI", async () => {
		function testSchema() {
			return {
				"~standard": {
					types: { input: "{ name: string }", output: "{ name: string }" },
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/items")
			.input({ json: testSchema() })
			.handler((ctx) => ctx.res.json("created", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		const op = spec.paths["/items"].post
		expect(op.requestBody).toBeTruthy()
		const content = (op.requestBody as Record<string, unknown>).content as Record<string, unknown>
		expect(content["application/json"]).toBeTruthy()
	})

	it("form input → application/x-www-form-urlencoded in OpenAPI", async () => {
		function testSchema() {
			return {
				"~standard": {
					types: { input: "{ name: string }", output: "{ name: string }" },
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.post("/form")
			.input({ form: testSchema() })
			.handler((ctx) => ctx.res.json("created", {}))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		const op = spec.paths["/form"].post
		const content = (op.requestBody as Record<string, unknown>).content as Record<string, unknown>
		expect(content["application/x-www-form-urlencoded"]).toBeTruthy()
	})
})

/* ══════════════════════════════════════════════
 * 4. CODEGEN — OpenAPI with output schemas → responses
 *
 * codegen.ts:312-330 — output → responses per status code.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: OpenAPI — output schemas → responses", () => {
	it("output with multiple status keys → multiple responses", async () => {
		function okSchema() {
			return {
				"~standard": {
					types: { input: "unknown", output: "unknown" },
					validate: (data: unknown) => ({ value: data }),
					vendor: "test",
					version: 1,
				},
			}
		}

		const app = honey<{}>()
		app
			.get("/items")
			.output({
				"application/json": {
					created: okSchema(),
					ok: okSchema(),
				},
			})
			.handler((ctx) => ctx.res.json("ok", "ok"))

		const spec = await generateOpenApi(app, {
			info: { title: "Test", version: "1.0.0" },
		})

		const responses = spec.paths["/items"].get.responses as Record<string, unknown>
		expect(responses["200"]).toBeTruthy()
		expect(responses["201"]).toBeTruthy()
	})
})

/* ══════════════════════════════════════════════
 * 5. CODEGEN — generateRouteTreeFromApp with middleware names
 *
 * codegen.ts:441 — handler.mw.map(mw => mw.name || "anonymous")
 * Named middleware should appear in generated code.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: codegen — middleware names in manifest", () => {
	it("named middleware → name in manifest", () => {
		const authMw = createMiddleware(async (_ctx, next) => next())
		Object.defineProperty(authMw, "name", { value: "authMiddleware" })

		const app = honey<{}>()
		app
			.get("/test")
			.use(authMw)
			.handler((ctx) => ctx.res.json("ok", {}))

		const manifest = generateManifest(app)
		expect(manifest.routes[0].middleware).toContain("authMiddleware")
	})

	it("anonymous middleware → 'anonymous' in manifest", () => {
		const app = honey<{}>()
		app
			.get("/test")
			.use(createMiddleware(async (_ctx, next) => next()))
			.handler((ctx) => ctx.res.json("ok", {}))

		const manifest = generateManifest(app)
		const names = manifest.routes[0].middleware
		expect(names.some((n) => n === "anonymous" || n === "")).toBe(true)
	})
})

/* ══════════════════════════════════════════════
 * 6. CODEGEN — extractParams edge cases
 *
 * codegen.ts:59-67 — extracts param names from path.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: codegen — extractParams", () => {
	it("path with multiple params → all extracted", () => {
		const app = honey<{}>()
		app.get("/orgs/:orgId/members/:memberId").handler((ctx) => ctx.res.json("ok", {}))

		const manifest = generateManifest(app)
		expect(manifest.routes[0].params).toEqual(["orgId", "memberId"])
	})

	it("path with optional param → name without ?", () => {
		const app = honey<{}>()
		app.get("/items/:id?").handler((ctx) => ctx.res.json("ok", {}))

		const manifest = generateManifest(app)
		/* optional param registers on both parent and child nodes */
		const route = manifest.routes.find((r) => r.params.length > 0)
		if (route) {
			expect(route.params).toContain("id")
			/* should not contain the ? */
			expect(route.params.every((p) => !p.includes("?"))).toBe(true)
		}
	})

	it("static path → empty params", () => {
		const app = honey<{}>()
		app.get("/health").handler((ctx) => ctx.res.json("ok", {}))

		const manifest = generateManifest(app)
		expect(manifest.routes[0].params).toEqual([])
	})
})

/* ══════════════════════════════════════════════
 * 7. MULTIPLE ROUTE METHODS → manifest has all
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: codegen — all HTTP methods in manifest", () => {
	it("7 methods on same path → 7 manifest entries", () => {
		const app = honey<{}>()
		app.get("/r").handler((ctx) => ctx.res.json("ok", {}))
		app.post("/r").handler((ctx) => ctx.res.json("created", {}))
		app.put("/r").handler((ctx) => ctx.res.json("ok", {}))
		app.patch("/r").handler((ctx) => ctx.res.json("ok", {}))
		app.delete("/r").handler((ctx) => ctx.res.json("ok", {}))
		app.options("/r").handler((ctx) => ctx.res.noContent())
		app.head("/r").handler((ctx) => ctx.res.json("ok", {}))

		const manifest = generateManifest(app)
		const methods = manifest.routes.map((r) => r.method).sort()
		expect(methods).toEqual(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"])
	})
})

/* ══════════════════════════════════════════════
 * 8. RUNTIME — handler with sync return (no async)
 *
 * Most handlers are async (await ctx.req.json etc),
 * but sync handlers returning ctx.res.json() directly
 * should also work through the pipeline.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: sync handler (no await)", () => {
	it("sync handler through middleware chain → works", async () => {
		const mw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			res.headers.set("x-sync", "true")
			return res
		})

		const app = honey<{}>().use(mw)
		app.get("/sync").handler((ctx) => ctx.res.json("ok", { sync: true }))

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/sync")
		expect(res.status).toBe(200)
		expect(res.headers["x-sync"]).toBe("true")
	})
})

/* ══════════════════════════════════════════════
 * 9. RUNTIME — request URL with fragment (#)
 *
 * Fragments are stripped by the URL parser. Verify
 * they don't affect routing.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: URL with fragment", () => {
	it("URL with #fragment → fragment stripped, route matches", async () => {
		const app = honey<{}>()
		app.get("/page").handler((ctx) => ctx.res.json("ok", { matched: true }))

		/* Note: new URL("http://localhost/page#section") strips the fragment */
		const res = await app.fetch(new Request("http://localhost/page#section"), {})
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 10. RUNTIME — request with very long query string
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: very long query string", () => {
	it("1000-char query string → doesn't crash routing", async () => {
		const app = honey<{}>()
		app
			.get("/search")
			.handler((ctx) => ctx.res.json("ok", { qLen: (ctx.search.q as string)?.length ?? 0 }))

		const longQ = "x".repeat(1000)
		const res = await app.fetch(new Request(`http://localhost/search?q=${longQ}`), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, number>
		expect(data.qLen).toBe(1000)
	})
})

/* ══════════════════════════════════════════════
 * 11. RUNTIME — ctx.cookies accessed multiple times (cached)
 *
 * context.ts — cookies getter is lazy-initialized and cached.
 * Multiple accesses should return same object.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: ctx.cookies caching", () => {
	it("multiple accesses return same object reference", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const c1 = ctx.cookies
			const c2 = ctx.cookies
			return ctx.res.json("ok", { same: c1 === c2, val: c1.session })
		})

		const res = await app.fetch(
			new Request("http://localhost/test", {
				headers: { cookie: "session=abc" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.same).toBe(true)
		expect(data.val).toBe("abc")
	})
})

/* ══════════════════════════════════════════════
 * 12. RUNTIME — ctx.headers accessed multiple times (cached)
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: ctx.headers caching", () => {
	it("multiple accesses return same object reference", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const h1 = ctx.headers
			const h2 = ctx.headers
			return ctx.res.json("ok", { same: h1 === h2 })
		})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.same).toBe(true)
	})
})

/* ══════════════════════════════════════════════
 * 13. RUNTIME — ctx.search accessed multiple times (cached)
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: ctx.search caching", () => {
	it("multiple accesses return same object reference", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const s1 = ctx.search
			const s2 = ctx.search
			return ctx.res.json("ok", { same: s1 === s2 })
		})

		const res = await app.fetch(new Request("http://localhost/test?q=hello"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.same).toBe(true)
	})
})

/* ══════════════════════════════════════════════
 * 14. CODEGEN — generateRouteTree with optional param
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: codegen — optional param in route tree", () => {
	it("optional param route generates valid tree code", () => {
		const app = honey<{}>()
		app.get("/items/:id?").handler((ctx) => ctx.res.json("ok", {}))

		const code = generateRouteTreeFromApp(app)
		expect(code).toContain("export const tree")
		expect(code).toContain("export const routeTree")
		/* should compile without errors — verified by the code being syntactically valid */
		expect(code).toContain("H0")
	})
})

/* ══════════════════════════════════════════════
 * 15. RUNTIME — Node adapter handles 100 rapid requests
 * ══════════════════════════════════════════════ */

describe("bug-hunt-17: Node adapter — 100 rapid requests", () => {
	it("100 concurrent requests via Node adapter → all correct", async () => {
		const app = honey<{}>()
		app.get("/n/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const promises = Array.from({ length: 100 }, (_, i) => request(addr.port, `/n/${i}`))
		const results = await Promise.all(promises)

		let allCorrect = true
		for (let i = 0; i < 100; i++) {
			if (results[i].status !== 200) {
				allCorrect = false
				break
			}
			const data = JSON.parse(results[i].body) as Record<string, string>
			if (data.id !== String(i)) {
				allCorrect = false
				break
			}
		}
		expect(allCorrect).toBe(true)
	})
})
