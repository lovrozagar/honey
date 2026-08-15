import { expect, test } from "@playwright/test"

test.describe("composed groups", () => {
	test("GET /health", async ({ request }) => {
		const res = await request.get("/health")
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ cached: null, status: "up" })
	})

	test("GET /docs stays the user text route", async ({ request }) => {
		const res = await request.get("/docs")
		expect(res.status()).toBe(200)
		expect(res.headers()["content-type"]).toMatch(/text\/plain/)
		expect(await res.text()).toBe("API documentation")
	})

	test("GET /feed uses search defaults", async ({ request }) => {
		const res = await request.get("/feed")
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ items: [], page: 1 })
	})

	test("GET /account is session-backed", async ({ request }) => {
		const res = await request.get("/account")
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ orgId: "org-1", userId: "u-1" })
	})

	test("POST /account/settings", async ({ request }) => {
		const res = await request.post("/account/settings", {
			data: { notifications: true, theme: "dark" },
		})
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ notifications: true, theme: "dark" })
	})

	test("GET /resources/:id", async ({ request }) => {
		const res = await request.get("/resources/res-1")
		expect(res.status()).toBe(200)
		expect(await res.json()).toEqual({ id: "res-1" })
	})

	test("POST /resources", async ({ request }) => {
		const res = await request.post("/resources", {
			data: { name: "n1", type: "doc" },
		})
		expect(res.status()).toBe(201)
		expect(await res.json()).toEqual({ name: "n1", type: "doc" })
	})

	test("DELETE /resources/:id → 204", async ({ request }) => {
		const res = await request.delete("/resources/res-1")
		expect(res.status()).toBe(204)
	})
})

test.describe("openapi collision", () => {
	test("Scalar falls back off /docs", async ({ request }) => {
		const docs = await request.get("/docs")
		expect(await docs.text()).toBe("API documentation")

		const ref = await request.get("/reference")
		expect(ref.status()).toBe(200)
		const html = await ref.text()
		expect(html).toContain("cdn.jsdelivr.net/npm/@scalar/api-reference")
		expect(html).toContain("/openapi.json")
	})

	test("spec includes routes from every .route() group", async ({ request }) => {
		const res = await request.get("/openapi.json")
		expect(res.status()).toBe(200)
		const spec = await res.json()
		expect(spec.info.title).toBe("Honey Compose")
		expect(spec.paths["/health"]).toBeDefined()
		expect(spec.paths["/account"]).toBeDefined()
		expect(spec.paths["/resources"]).toBeDefined()
		expect(spec.paths["/resources/{resourceId}"]).toBeDefined()
		expect(spec.paths["/docs"]).toBeDefined()
		expect(spec.paths["/openapi.json"]).toBeUndefined()
	})
})
