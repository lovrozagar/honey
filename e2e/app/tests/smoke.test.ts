import { describe, expect, test } from "bun:test"
import type { WSAdapter } from "honey"
import { createApp } from "../src/app.ts"

const stubWs: WSAdapter = {
	upgrade() {
		return {
			response: new Response("websocket upgrade not used in smoke", { status: 426 }),
			socket: {
				close() {},
				raw: { close() {}, readyState: 3, send() {} },
				get readyState() {
					return 3 as const
				},
				send() {},
			},
		}
	},
}

const app = createApp(stubWs)

async function fetchApp(path: string, init?: RequestInit): Promise<Response> {
	return app.fetch(new Request(`http://honey.test${path}`, init), {})
}

describe("e2e-app consumes honey", () => {
	test("GET /api/health", async () => {
		const res = await fetchApp("/api/health")
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("ok")
	})

	test("GET /api/echo echoes method", async () => {
		const res = await fetchApp("/api/echo")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ method: "GET" })
	})

	test("GET /api/v1/organizations without auth is rejected", async () => {
		const res = await fetchApp("/api/v1/organizations")
		expect(res.status).toBeGreaterThanOrEqual(400)
		const body = (await res.json()) as { error_key?: string }
		expect(body.error_key).toBeDefined()
	})

	test("CORS preflight echoes origin", async () => {
		const res = await fetchApp("/api/echo", {
			headers: {
				"access-control-request-method": "POST",
				origin: "http://localhost:3000",
			},
			method: "OPTIONS",
		})
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
	})
})
