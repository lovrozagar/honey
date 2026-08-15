import { expect, test } from "@playwright/test"

test.describe("routes", () => {
	test("GET /health → 200 ok", async ({ request }) => {
		const res = await request.get("/health")
		expect(res.status()).toBe(200)
		expect(await res.text()).toBe("ok")
	})

	test("GET /users/:id echoes the param", async ({ request }) => {
		const res = await request.get("/users/abc")
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ id: "abc" })
	})

	test("POST /echo returns the body as created", async ({ request }) => {
		const res = await request.post("/echo", { data: "hello" })
		expect(res.status()).toBe(201)
		expect(await res.json()).toBe("hello")
	})
})

test.describe("origin defaults", () => {
	test("no Access-Control-* on a simple GET with Origin", async ({ request }) => {
		const res = await request.get("/health", {
			headers: { origin: "http://localhost:3000" },
		})
		expect(res.status()).toBe(200)
		expect(res.headers()["access-control-allow-origin"]).toBeUndefined()
		expect(res.headers()["access-control-allow-credentials"]).toBeUndefined()
	})

	test("trailingSlash ignore does not 308 /health/", async ({ request }) => {
		const res = await request.get("/health/", { maxRedirects: 0 })
		expect(res.status()).not.toBe(308)
	})

	test("GET /api/health is 404 (no basePath)", async ({ request }) => {
		const res = await request.get("/api/health")
		expect(res.status()).toBe(404)
	})
})

test.describe("openapi at root", () => {
	test("GET /openapi.json → 3.1 spec", async ({ request }) => {
		const res = await request.get("/openapi.json")
		expect(res.status()).toBe(200)
		const spec = await res.json()
		expect(spec.openapi).toBe("3.1.0")
		expect(spec.info.title).toBe("Honey Defaults")
		expect(spec.paths["/health"]).toBeDefined()
		expect(spec.paths["/users/{id}"]).toBeDefined()
		expect(spec.paths["/openapi.json"]).toBeUndefined()
		expect(spec.paths["/docs"]).toBeUndefined()
	})

	test("GET /openapi.yaml matches the JSON title", async ({ request }) => {
		const res = await request.get("/openapi.yaml")
		expect(res.status()).toBe(200)
		expect(res.headers()["content-type"]).toMatch(/yaml/)
		expect(await res.text()).toContain("Honey Defaults")
	})

	test("GET /docs is Scalar pointing at /openapi.json", async ({ request }) => {
		const res = await request.get("/docs")
		expect(res.status()).toBe(200)
		const html = await res.text()
		expect(html).toContain("cdn.jsdelivr.net/npm/@scalar/api-reference")
		expect(html).toContain("/openapi.json")
	})

	test("GET /manifest.json lists product routes only", async ({ request }) => {
		const res = await request.get("/manifest.json")
		expect(res.status()).toBe(200)
		const body = (await res.json()) as { routes: Array<{ path: string }> }
		expect(body.routes.some((r) => r.path === "/health")).toBe(true)
		expect(body.routes.some((r) => r.path === "/manifest.json")).toBe(false)
		expect(body.routes.some((r) => r.path === "/openapi.json")).toBe(false)
	})
})
