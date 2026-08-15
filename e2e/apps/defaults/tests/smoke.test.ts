import { describe, expect, test } from "bun:test"
import { createApp } from "../src/app.ts"

const app = createApp()

async function fetchApp(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`http://honey.test${path}`, init), {})
}

describe("e2e defaults consumes honey", () => {
	test("GET /health", async () => {
		const res = await fetchApp("/health")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})

	test("GET /openapi.json is a 3.1 spec at the origin root", async () => {
		const res = await fetchApp("/openapi.json")
		expect(res.status).toBe(200)
		const spec = (await res.json()) as {
			info: { title: string }
			openapi: string
			paths: Record<string, unknown>
		}
		expect(spec.openapi).toBe("3.1.0")
		expect(spec.info.title).toBe("Honey Defaults")
		expect(spec.paths["/health"]).toBeDefined()
		expect(spec.paths["/openapi.json"]).toBeUndefined()
	})

	test("no CORS headers without middleware", async () => {
		const res = await fetchApp("/health", { headers: { origin: "http://localhost:3000" } })
		expect(res.status).toBe(200)
		expect(res.headers.get("access-control-allow-origin")).toBeNull()
	})
})
