import { describe, expect, it, vi } from "vitest"
import { cors } from "../../../src/cors.ts"
import { defineErrors, HoneyError, honey } from "../../../src/index.ts"
import type { MiddlewareFn } from "../../../src/middleware.ts"
import { testClient } from "../../../src/testing.ts"
import "honey/i18n"

/* ---- shared env ---- */
type Env = { DB_URL: string; ENVIRONMENT: string; JWT_SECRET: string }
const testEnv: Env = {
	DB_URL: "test://db",
	ENVIRONMENT: "test",
	JWT_SECRET: "secret",
}

/* ---- mock errors ---- */
const errors = defineErrors({
	bad_request: "bad_request",
	email_taken: "conflict",
	not_found: "not_found",
	org_limit_reached: "forbidden",
	org_slug_taken: "conflict",
	quota_exceeded: "payment_required",
	unauthorized: "unauthorized",
})

/* ---- mock middleware ---- */
type DbCtx = { db: { query: (sql: string) => string } }
const withDb: MiddlewareFn<{ env: Env }, DbCtx> = async (_ctx, next) => {
	const db = { query: (sql: string) => `result:${sql}` }
	return next({ db })
}

type AuthCtx = { user: { id: string; locale: string; name: string } }
const withAuth: MiddlewareFn<DbCtx & { req: Request }, AuthCtx> = async (ctx, next) => {
	const token = ctx.req.headers.get("authorization")?.replace("Bearer ", "")
	if (!token) throw errors.unauthorized()
	if (token === "expired") throw errors.unauthorized({ cause: "expired token" })
	return next({ user: { id: "u1", locale: "en", name: "Alice" } })
}

/* ---- translations ---- */
const enErrors: Record<string, string> = {
	org_slug_taken: "Organization slug {slug} is already taken",
	unauthorized: "Authentication required",
}
const deErrors: Record<string, string> = {
	org_slug_taken: "Organisationsname {slug} ist bereits vergeben",
	unauthorized: "Authentifizierung erforderlich",
}

function createApp() {
	const h = honey<Env>()
		.basePath("/api")
		.trailingSlash("strip")
		.onError((error, ctx) => {
			if (error instanceof HoneyError && error.errorKey === "db_constraint_orgs_slug") {
				return ctx.jsonFromError(errors.org_slug_taken({ vars: { slug: "test" } }))
			}
			return undefined
		})
		.defaultErrorFormatter((_error, defaultShape) => ({
			...defaultShape,
			request_id: "test-req-123",
		}))
		.errorI18n({
			errors: { de: deErrors, en: enErrors },
			resolveLocale: (ctx) => {
				const accept = ctx.req.headers.get("accept-language")
				if (accept?.startsWith("de")) return "de"
				return "en"
			},
		})

	/* chain: cors applied to all subsequent routes */
	const corsed = h.use(
		cors({
			credentials: true,
			origin: ["http://localhost:3000", "http://example.com"],
		}),
	)
	const base = corsed.use(withDb)
	const authed = base.use(withAuth)

	/* health — gets CORS only */
	corsed.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

	/* SSE endpoint — gets CORS */
	corsed.get("/events").handler((ctx) =>
		ctx.res.sse(async (stream) => {
			stream.send({ data: "hello", event: "greeting" })
			stream.send({ data: "world", event: "greeting" })
			stream.close()
		}),
	)

	/* all method catch-all — gets CORS */
	corsed.all("/catch").handler((ctx) => ctx.res.json("ok", { method: ctx.req.method }))

	/* background work — gets CORS */
	corsed.get("/bg").handler((ctx) => {
		ctx.background(Promise.resolve("bg-task-done"))
		return ctx.res.text("ok", "queued")
	})

	/* organizations CRUD */
	authed
		.post("/v1/organizations")
		.errors(errors, "org_slug_taken", "org_limit_reached")
		.handler(async (ctx) => {
			const body = (await ctx.req.json()) as { name: string; slug: string }
			if (body.slug === "taken") throw errors.org_slug_taken({ vars: { slug: body.slug } })
			return ctx.res.json("created", {
				id: "org1",
				name: body.name,
				slug: body.slug,
			})
		})

	authed.get("/v1/organizations").handler((ctx) =>
		ctx.res.json("ok", {
			items: [{ id: "org1", name: "Acme", slug: "acme" }],
			total: 1,
		}),
	)

	authed
		.get("/v1/organizations/:orgId")
		.handler((ctx) => ctx.res.json("ok", { id: ctx.params.orgId, name: "Acme", slug: "acme" }))

	authed.delete("/v1/organizations/:orgId").handler((ctx) => ctx.res.noContent())

	/* route with strict error enforcement */
	authed
		.get("/v1/strict")
		.errors(errors, "org_slug_taken")
		.handler((ctx) => {
			void ctx
			throw errors.not_found()
		})

	/* route that triggers db_constraint via onError */
	authed
		.post("/v1/constraint-test")
		.errors(errors, "org_slug_taken")
		.handler((_ctx) => {
			throw new HoneyError({
				errorKey: "db_constraint_orgs_slug",
				status: "internal_server_error",
			})
		})

	return h
}

describe("integration: full framework", () => {
	const app = createApp()
	const client = testClient(app, { env: testEnv })

	describe("health check", () => {
		it("GET /api/health → 200", async () => {
			const res = await client.get("/api/health")
			expect(res.status).toBe(200)
			expect(await res.text()).toBe("ok")
		})
	})

	describe("CORS", () => {
		it("preflight from allowed origin → 204 with CORS headers", async () => {
			/* preflight uses .all() route which accepts all methods including OPTIONS */
			const res = await client.options("/api/catch", {
				headers: {
					"access-control-request-method": "POST",
					origin: "http://localhost:3000",
				},
			})
			expect(res.status).toBe(204)
			expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
			expect(res.headers.get("access-control-allow-credentials")).toBe("true")
		})

		it("simple request from allowed origin → CORS headers on response", async () => {
			const res = await client.get("/api/health", {
				headers: { origin: "http://example.com" },
			})
			expect(res.status).toBe(200)
			expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com")
		})

		it("request from disallowed origin → no CORS headers", async () => {
			const res = await client.get("/api/health", {
				headers: { origin: "http://evil.com" },
			})
			expect(res.status).toBe(200)
			expect(res.headers.get("access-control-allow-origin")).toBeNull()
		})
	})

	describe("authentication", () => {
		it("request without auth → 401", async () => {
			const res = await client.get("/api/v1/organizations")
			expect(res.status).toBe(401)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.error_key).toBe("unauthorized")
		})

		it("request with valid token → 200", async () => {
			const res = await client.get("/api/v1/organizations", {
				headers: { authorization: "Bearer valid-token" },
			})
			expect(res.status).toBe(200)
		})
	})

	describe("CRUD routes", () => {
		it("POST creates organization → 201", async () => {
			const res = await client.post("/api/v1/organizations", {
				headers: { authorization: "Bearer tok" },
				json: { name: "New Org", slug: "new-org" },
			})
			expect(res.status).toBe(201)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.slug).toBe("new-org")
		})

		it("GET list → 200 with items", async () => {
			const res = await client.get("/api/v1/organizations", {
				headers: { authorization: "Bearer tok" },
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as { items: unknown[]; total: number }
			expect(body.items).toHaveLength(1)
			expect(body.total).toBe(1)
		})

		it("GET by id with param → 200", async () => {
			const res = await client.get("/api/v1/organizations/org42", {
				headers: { authorization: "Bearer tok" },
			})
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.id).toBe("org42")
		})

		it("DELETE → 204", async () => {
			const res = await client.delete("/api/v1/organizations/org42", {
				headers: { authorization: "Bearer tok" },
			})
			expect(res.status).toBe(204)
		})
	})

	describe("404 and 405", () => {
		it("GET unknown path → 404", async () => {
			const res = await client.get("/api/nonexistent")
			expect(res.status).toBe(404)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.error_key).toBe("not_found")
		})

		it("PATCH /api/health → 405 with Allow header", async () => {
			const res = await client.patch("/api/health")
			expect(res.status).toBe(405)
			const allow = res.headers.get("allow")
			expect(allow).toContain("GET")
		})
	})

	describe("business errors", () => {
		it("duplicate slug → 409 with translated message (en)", async () => {
			const res = await client.post("/api/v1/organizations", {
				headers: { authorization: "Bearer tok" },
				json: { name: "Dup", slug: "taken" },
			})
			expect(res.status).toBe(409)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.error_key).toBe("org_slug_taken")
			expect(body.message).toBe("Organization slug taken is already taken")
		})

		it("i18n: Accept-Language de → German error message", async () => {
			const res = await client.post("/api/v1/organizations", {
				headers: {
					"accept-language": "de-DE",
					authorization: "Bearer tok",
				},
				json: { name: "Dup", slug: "taken" },
			})
			expect(res.status).toBe(409)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.message).toBe("Organisationsname taken ist bereits vergeben")
		})
	})

	describe("onError: DB constraint → typed error", () => {
		it("db constraint caught by onError → 409 org_slug_taken", async () => {
			const res = await client.post("/api/v1/constraint-test", {
				headers: { authorization: "Bearer tok" },
				json: {},
			})
			expect(res.status).toBe(409)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.error_key).toBe("org_slug_taken")
		})
	})

	describe("error formatter", () => {
		it("error responses include custom request_id field", async () => {
			const res = await client.get("/api/nonexistent")
			const body = (await res.json()) as Record<string, unknown>
			expect(body.request_id).toBe("test-req-123")
		})
	})

	describe("trailing slash redirect", () => {
		it("GET /api/health/ → 308 redirect to /api/health", async () => {
			const res = await client.get("/api/health/")
			expect(res.status).toBe(308)
			const location = res.headers.get("location")
			expect(location).toContain("/api/health")
			expect(location).not.toContain("health/")
		})
	})

	describe(".all() catch-all route", () => {
		it("GET /api/catch → reflects method", async () => {
			const res = await client.get("/api/catch")
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.method).toBe("GET")
		})

		it("POST /api/catch → reflects method", async () => {
			const res = await client.post("/api/catch")
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.method).toBe("POST")
		})

		it("DELETE /api/catch → reflects method", async () => {
			const res = await client.delete("/api/catch")
			expect(res.status).toBe(200)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.method).toBe("DELETE")
		})
	})

	describe("SSE streaming", () => {
		it("GET /api/events → SSE stream with events", async () => {
			const res = await client.get("/api/events")
			expect(res.status).toBe(200)
			expect(res.headers.get("content-type")).toBe("text/event-stream")
			const text = await res.text()
			expect(text).toContain("event: greeting")
			expect(text).toContain("data: hello")
			expect(text).toContain("data: world")
		})
	})

	describe("background work", () => {
		it("waitUntil receives background promise", async () => {
			const promises: Promise<unknown>[] = []
			const req = new Request("http://localhost/api/bg")
			await app.fetch(req, testEnv, {
				waitUntil: (p) => {
					promises.push(p)
				},
			})
			expect(promises).toHaveLength(1)
			await expect(promises[0]).resolves.toBe("bg-task-done")
		})
	})

	describe("error key runtime enforcement", () => {
		it("undeclared error key keeps the thrown error status", async () => {
			const res = await client.get("/api/v1/strict", {
				headers: { authorization: "Bearer tok" },
			})
			expect(res.status).toBe(404)
			const body = (await res.json()) as Record<string, unknown>
			expect(body.error_key).toBe("not_found")
		})
	})

	describe("testClient all methods", () => {
		it("HEAD /api/catch → 200 via .all()", async () => {
			const res = await client.head("/api/catch")
			expect(res.status).toBe(200)
		})

		it("PUT via request() → works with .all()", async () => {
			const res = await client.put("/api/catch")
			expect(res.status).toBe(200)
		})

		it("request() with custom method", async () => {
			const res = await client.request("GET", "/api/health")
			expect(res.status).toBe(200)
		})
	})
})

describe("integration: multiple instances + mergeTree", () => {
	it("mergeTree combines two honey instances via toRouteTree + fromTree", async () => {
		const app1 = honey<{}>()
		app1.get("/a").handler((ctx) => ctx.res.text("ok", "from-a"))

		const app2 = honey<{}>()
		app2.get("/b").handler((ctx) => ctx.res.text("ok", "from-b"))

		const { mergeTree } = await import("../../../src/tree.ts")
		const merged = mergeTree(app1.toRouteTree(), app2.toRouteTree())

		const gateway = honey<{}>().routeTree(merged)

		const client = testClient(gateway, { env: {} })
		const resA = await client.get("/a")
		expect(resA.status).toBe(200)
		expect(await resA.text()).toBe("from-a")

		const resB = await client.get("/b")
		expect(resB.status).toBe(200)
		expect(await resB.text()).toBe("from-b")
	})
})

describe("integration: i18n fallback", () => {
	it("unknown locale falls back to error key as message", async () => {
		const h = honey<{}>().errorI18n({
			errors: { en: { bad_request: "Bad request" } },
			resolveLocale: () => "fr",
		})

		h.get("/fail").handler(() => {
			throw new HoneyError({ errorKey: "bad_request", status: "bad_request" })
		})

		const client = testClient(h, { env: {} })
		const res = await client.get("/fail")
		expect(res.status).toBe(400)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("bad_request")
	})
})

describe("integration: middleware short-circuit", () => {
	it("middleware returns response directly → handler never runs", async () => {
		const handlerCalled = vi.fn()

		const cache: MiddlewareFn<{ req: Request }, {}> = async (ctx, next) => {
			if (ctx.req.url.includes("/cached")) {
				return new Response(JSON.stringify({ cached: true }), {
					headers: { "content-type": "application/json" },
					status: 200,
				})
			}
			return next()
		}

		const h = honey<{}>()
		const cached = h.use(cache)

		cached.get("/cached").handler((ctx) => {
			handlerCalled()
			return ctx.res.text("ok", "not-cached")
		})
		cached.get("/uncached").handler((ctx) => ctx.res.text("ok", "fresh"))

		const client = testClient(h, { env: {} })

		const res1 = await client.get("/cached")
		expect(res1.status).toBe(200)
		const body = (await res1.json()) as Record<string, unknown>
		expect(body.cached).toBe(true)
		expect(handlerCalled).not.toHaveBeenCalled()

		const res2 = await client.get("/uncached")
		expect(res2.status).toBe(200)
		expect(await res2.text()).toBe("fresh")
	})
})
