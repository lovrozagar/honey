import { expect, test } from "@playwright/test"

test.describe("stripPrefix + enforce", () => {
	test("GET /app/ping → 308 /app/ping/", async ({ request }) => {
		const res = await request.get("/app/ping", { maxRedirects: 0 })
		expect(res.status()).toBe(308)
		expect(res.headers()["location"]).toContain("/app/ping/")
	})

	test("GET /app/ping/ → pong", async ({ request }) => {
		const res = await request.get("/app/ping/")
		expect(res.status()).toBe(200)
		expect(await res.text()).toBe("pong")
	})

	test("GET /ping/ still matches the registered route", async ({ request }) => {
		const res = await request.get("/ping/")
		expect(res.status()).toBe(200)
		expect(await res.text()).toBe("pong")
	})

	test("GET /other/ping/ is not stripped → 404", async ({ request }) => {
		const res = await request.get("/other/ping/")
		expect(res.status()).toBe(404)
	})
})

test.describe("swagger docs behind the prefix", () => {
	test("GET /app/openapi.json", async ({ request }) => {
		const res = await request.get("/app/openapi.json")
		expect(res.status()).toBe(200)
		const spec = await res.json()
		expect(spec.openapi).toBe("3.1.0")
		expect(spec.info.title).toBe("Honey Gateway")
		expect(spec.paths["/ping"]).toBeDefined()
	})

	test("GET /app/docs is Swagger UI", async ({ request }) => {
		const res = await request.get("/app/docs")
		expect(res.status()).toBe(200)
		const html = await res.text()
		expect(html).toContain("swagger-ui")
		expect(html).toContain("SwaggerUIBundle")
	})

	test("GET /app/manifest.json", async ({ request }) => {
		const res = await request.get("/app/manifest.json")
		expect(res.status()).toBe(200)
		const body = (await res.json()) as { routes: Array<{ path: string }> }
		expect(body.routes.some((r) => r.path.includes("ping"))).toBe(true)
	})
})
