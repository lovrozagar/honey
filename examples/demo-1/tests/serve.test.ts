import { expect, test } from "bun:test"
import { app } from "../src/app.ts"

test("GET /openapi.json is a 3.1 spec for the demo routes", async () => {
	const res = await app.fetch(new Request("http://x/openapi.json"), {})
	expect(res.status).toBe(200)
	const spec = (await res.json()) as {
		info: { title: string; version: string }
		openapi: string
		paths: Record<string, unknown>
	}
	expect(spec.openapi).toBe("3.1.0")
	expect(spec.info.title).toBe("Demo 1")
	expect(spec.info.version).toBe("0.0.1")
	expect(spec.paths["/health"]).toBeDefined()
	expect(spec.paths["/users/{id}"]).toBeDefined()
	expect(spec.paths["/openapi.json"]).toBeUndefined()
})

test("GET /openapi.yaml matches the JSON title", async () => {
	const res = await app.fetch(new Request("http://x/openapi.yaml"), {})
	expect(res.status).toBe(200)
	expect(res.headers.get("content-type")).toMatch(/yaml/)
	expect(await res.text()).toContain("Demo 1")
})

test("GET /docs is Scalar HTML pointing at /openapi.json", async () => {
	const res = await app.fetch(new Request("http://x/docs"), {})
	expect(res.status).toBe(200)
	const html = await res.text()
	expect(html).toContain("cdn.jsdelivr.net/npm/@scalar/api-reference")
	expect(html).toContain("/openapi.json")
})

test("GET /manifest.json lists product routes only", async () => {
	const res = await app.fetch(new Request("http://x/manifest.json"), {})
	expect(res.status).toBe(200)
	const body = (await res.json()) as { routes: Array<{ path: string }> }
	expect(body.routes.some((r) => r.path === "/health")).toBe(true)
	expect(body.routes.some((r) => r.path === "/manifest.json")).toBe(false)
	expect(body.routes.some((r) => r.path === "/openapi.json")).toBe(false)
})
