import { expect, test } from "@playwright/test"

test.describe("health", () => {
	test("GET /api/health → 200 ok", async ({ request }) => {
		const res = await request.get("/api/health")
		expect(res.status()).toBe(200)
		expect(await res.text()).toBe("ok")
	})
})

test.describe("CORS", () => {
	test("preflight from browser → echoes origin (credentials + wildcard)", async ({ request }) => {
		const res = await request.fetch("/api/echo", {
			headers: {
				"access-control-request-method": "POST",
				origin: "http://localhost:3000",
			},
			method: "OPTIONS",
		})
		expect(res.status()).toBe(204)
		/* credentials: true + origin: "*" echoes back the request origin per CORS spec */
		expect(res.headers()["access-control-allow-origin"]).toBe("http://localhost:3000")
		expect(res.headers()["access-control-allow-credentials"]).toBe("true")
		expect(res.headers()["vary"]).toContain("Origin")
	})

	test("simple request → echoes origin with credentials", async ({ request }) => {
		const res = await request.get("/api/health", {
			headers: { origin: "http://example.com" },
		})
		expect(res.status()).toBe(200)
		expect(res.headers()["access-control-allow-origin"]).toBe("http://example.com")
		expect(res.headers()["access-control-allow-credentials"]).toBe("true")
	})
})

test.describe("auth", () => {
	test("request without auth → 401", async ({ request }) => {
		const res = await request.get("/api/v1/organizations")
		expect(res.status()).toBe(401)
		const body = await res.json()
		expect(body.error_key).toBe("unauthorized")
	})
})

test.describe("organizations CRUD", () => {
	test("GET /api/v1/organizations → list", async ({ request }) => {
		const res = await request.get("/api/v1/organizations", {
			headers: { authorization: "Bearer test-token" },
		})
		expect(res.status()).toBe(200)
		const body = await res.json()
		expect(body.items).toBeDefined()
		expect(body.total).toBeGreaterThanOrEqual(0)
	})

	test("POST /api/v1/organizations with valid body → 201", async ({ request }) => {
		const slug = `test-${Date.now()}`
		const res = await request.post("/api/v1/organizations", {
			data: { name: "Test Org", slug },
			headers: { authorization: "Bearer test-token" },
		})
		expect(res.status()).toBe(201)
		const body = await res.json()
		expect(body.name).toBe("Test Org")
		expect(body.slug).toBe(slug)
	})

	test("POST with invalid body → 400 with fields", async ({ request }) => {
		const res = await request.post("/api/v1/organizations", {
			data: {},
			headers: { authorization: "Bearer test-token" },
		})
		expect(res.status()).toBe(400)
		const body = await res.json()
		expect(body.error_key).toBe("invalid_input")
	})

	test("POST with duplicate slug → 409", async ({ request }) => {
		const res = await request.post("/api/v1/organizations", {
			data: { name: "Dup", slug: "acme" },
			headers: { authorization: "Bearer test-token" },
		})
		expect(res.status()).toBe(409)
		const body = await res.json()
		expect(body.error_key).toBe("org_slug_taken")
	})

	test("GET /api/v1/organizations/:id → 200", async ({ request }) => {
		const res = await request.get("/api/v1/organizations/org-1", {
			headers: { authorization: "Bearer test-token" },
		})
		expect(res.status()).toBe(200)
		const body = await res.json()
		expect(body.id).toBe("org-1")
	})

	test("DELETE /api/v1/organizations/:id → 204", async ({ request }) => {
		/* create an org to delete */
		const slug = `del-${Date.now()}`
		const createRes = await request.post("/api/v1/organizations", {
			data: { name: "Delete Me", slug },
			headers: { authorization: "Bearer test-token" },
		})
		const created = await createRes.json()

		const res = await request.delete(`/api/v1/organizations/${created.id}`, {
			headers: { authorization: "Bearer test-token" },
		})
		expect(res.status()).toBe(204)
	})
})

test.describe("404 and 405", () => {
	test("GET /nonexistent → 404", async ({ request }) => {
		const res = await request.get("/api/nonexistent")
		expect(res.status()).toBe(404)
		const body = await res.json()
		expect(body.error_key).toBe("not_found")
	})

	test("PATCH /api/health → 405 with Allow header", async ({ request }) => {
		const res = await request.patch("/api/health")
		expect(res.status()).toBe(405)
		expect(res.headers()["allow"]).toContain("GET")
	})
})

test.describe("i18n", () => {
	test("Accept-Language de → German error message", async ({ request }) => {
		const res = await request.post("/api/v1/organizations", {
			data: { name: "Dup", slug: "acme" },
			headers: {
				"accept-language": "de-DE",
				authorization: "Bearer test-token",
			},
		})
		expect(res.status()).toBe(409)
		const body = await res.json()
		expect(body.message).toContain("bereits vergeben")
	})
})

test.describe("error formatter", () => {
	test("response includes custom request_id", async ({ request }) => {
		const res = await request.get("/api/nonexistent")
		const body = await res.json()
		expect(body.request_id).toBe("e2e-req-001")
	})
})

test.describe("trailing slash", () => {
	test("GET /api/health/ → 308 redirect", async ({ request }) => {
		const res = await request.get("/api/health/", { maxRedirects: 0 })
		expect(res.status()).toBe(308)
		expect(res.headers()["location"]).toContain("/api/health")
	})
})

test.describe("SSE", () => {
	test("GET /api/events → event stream", async ({ request }) => {
		const res = await request.get("/api/events")
		expect(res.status()).toBe(200)
		expect(res.headers()["content-type"]).toBe("text/event-stream")
		const text = await res.text()
		expect(text).toContain("event: message")
		expect(text).toContain("data: hello")
		expect(text).toContain("data: world")
	})

	test("GET /api/events-live → retry directive + keepalive heartbeats", async ({ request }) => {
		const res = await request.get("/api/events-live")
		expect(res.status()).toBe(200)
		const text = await res.text()
		/* defaultRetry sends initial retry: directive */
		expect(text).toContain("retry: 3000")
		/* keepalive sends heartbeat comments */
		expect(text).toContain(": heartbeat")
		/* normal event data present */
		expect(text).toContain("event: tick")
		expect(text).toContain("data: live")
	})

	test("GET /api/events-live with Last-Event-ID → resumes", async ({ request }) => {
		const res = await request.get("/api/events-live", {
			headers: { "last-event-id": "t1" },
		})
		expect(res.status()).toBe(200)
		const text = await res.text()
		expect(text).toContain("event: resume")
		expect(text).toContain("resumed from t1")
	})
})

test.describe("basePath boundary", () => {
	test("GET /api-docs → 404 (not matched by basePath /api)", async ({ request }) => {
		const res = await request.get("/api-docs")
		expect(res.status()).toBe(404)
	})

	test("GET /apiary → 404", async ({ request }) => {
		const res = await request.get("/apiary")
		expect(res.status()).toBe(404)
	})
})

test.describe("input validation", () => {
	test("GET /api/?id=test → valid response with id", async ({ request }) => {
		const res = await request.get("/api/?id=test")
		expect(res.status()).toBe(200)
		const body = await res.json()
		expect(body.id).toBe("test")
	})
})

test.describe("OpenAPI", () => {
	test("GET /api/openapi.json → valid OpenAPI 3.1 spec", async ({ request }) => {
		const res = await request.get("/api/openapi.json")
		expect(res.status()).toBe(200)
		const spec = await res.json()
		expect(spec.openapi).toBe("3.1.0")
		expect(spec.info.title).toBe("Honey E2E")
		expect(spec.info.version).toBe("1.0.0")
		expect(spec.paths).toBeDefined()
	})

	test("OpenAPI spec includes paths with correct methods", async ({ request }) => {
		const res = await request.get("/api/openapi.json")
		const spec = await res.json()
		/* root route (GET /) should be in spec */
		expect(spec.paths["/api"]).toBeDefined()
		expect(spec.paths["/api"].get).toBeDefined()
		/* organizations routes */
		expect(spec.paths["/api/v1/organizations"]).toBeDefined()
		expect(spec.paths["/api/v1/organizations"].get).toBeDefined()
		expect(spec.paths["/api/v1/organizations"].post).toBeDefined()
	})

	test("OpenAPI spec includes path parameters", async ({ request }) => {
		const res = await request.get("/api/openapi.json")
		const spec = await res.json()
		const orgByIdPath = spec.paths["/api/v1/organizations/{orgId}"]
		expect(orgByIdPath).toBeDefined()
		const getOp = orgByIdPath.get ?? orgByIdPath.delete
		expect(getOp.parameters).toBeDefined()
		expect(getOp.parameters[0].name).toBe("orgId")
		expect(getOp.parameters[0].in).toBe("path")
	})

	test("OpenAPI spec includes response schemas from .output()", async ({ request }) => {
		const res = await request.get("/api/openapi.json")
		const spec = await res.json()
		const rootGet = spec.paths["/api"].get
		expect(rootGet.responses["200"]).toBeDefined()
		expect(rootGet.responses["200"].content["application/json"]).toBeDefined()
	})

	test("OpenAPI spec includes meta summary and tags", async ({ request }) => {
		const res = await request.get("/api/openapi.json")
		const spec = await res.json()
		const rootGet = spec.paths["/api"].get
		expect(rootGet.summary).toBe("Root test route")
		expect(rootGet.tags).toEqual(["test"])
	})
})

test.describe("manifest", () => {
	test("GET /api/manifest.json → route manifest", async ({ request }) => {
		const res = await request.get("/api/manifest.json")
		expect(res.status()).toBe(200)
		const manifest = await res.json()
		expect(manifest.routes).toBeDefined()
		expect(manifest.errors).toBeDefined()
		expect(Array.isArray(manifest.errors)).toBe(true)
		expect(manifest.errors.length).toBeGreaterThan(0)
		expect(manifest.routes.length).toBeGreaterThan(0)
	})

	test("manifest includes route methods, paths, and middleware names", async ({ request }) => {
		const res = await request.get("/api/manifest.json")
		const manifest = await res.json()
		const healthRoute = manifest.routes.find(
			(r: { method: string; path: string }) => r.path === "/api/health" && r.method === "GET",
		)
		expect(healthRoute).toBeDefined()
		expect(healthRoute.middleware.length).toBeGreaterThan(0)
	})

	test("manifest includes custom error keys", async ({ request }) => {
		const res = await request.get("/api/manifest.json")
		const manifest = await res.json()
		const postOrg = manifest.routes.find(
			(r: { method: string; path: string }) =>
				r.path === "/api/v1/organizations" && r.method === "POST",
		)
		expect(postOrg).toBeDefined()
		expect(postOrg.errors).toContain("org_slug_taken")
	})
})

test.describe("generated route tree", () => {
	test("GET /api/generated-tree → valid TypeScript route tree code", async ({ request }) => {
		const res = await request.get("/api/generated-tree")
		expect(res.status()).toBe(200)
		const code = await res.text()
		/* generated code should import from honey/tree */
		expect(code).toContain(
			'import type { TreeNode, RouteHandler, RouteTree } from "honey/tree"',
		)
		/* should export a tree constant */
		expect(code).toContain("export const tree: TreeNode")
		/* should contain handler definitions */
		expect(code).toContain("const H0: RouteHandler")
	})
})
