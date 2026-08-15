import { describe, expect, test } from "bun:test"
import { createApp } from "../src/app.ts"

const app = createApp()

async function fetchApp(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`http://honey.test${path}`, init), {})
}

describe("e2e gateway consumes honey", () => {
	test("GET /app/ping → 308 to /app/ping/", async () => {
		const res = await fetchApp("/app/ping")
		expect(res.status).toBe(308)
		expect(res.headers.get("location")).toContain("/app/ping/")
	})

	test("GET /app/ping/ → pong", async () => {
		const res = await fetchApp("/app/ping/")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("pong")
	})
})
