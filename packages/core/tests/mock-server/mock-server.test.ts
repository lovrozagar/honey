import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { generateSDK } from "../../src/codegen.ts"
import { generateGoSDK } from "../../src/codegen-go.ts"
import { generatePythonSDK } from "../../src/codegen-python.ts"
import { generateRustSDK } from "../../src/codegen-rust.ts"
import { parseSSEStream } from "../../src/client/sse.ts"
import { startServer } from "./start.ts"

let server: { port: number; close: () => void }
let base: string

beforeAll(async () => {
	server = await startServer(0)
	base = `http://127.0.0.1:${server.port}`
})

afterAll(() => {
	server.close()
})

const AUTH = { Authorization: "Bearer valid-token" }

describe("CRUD", () => {
	let createdId: string

	it("GET /users → empty array on fresh server", async () => {
		const res = await fetch(`${base}/users`, { headers: AUTH })
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({ items: [], total: 0 })
	})

	it("POST /users → creates user, returns 201 with id/name/email", async () => {
		const res = await fetch(`${base}/users`, {
			body: JSON.stringify({ email: "a@b.com", name: "Alice" }),
			headers: { ...AUTH, "Content-Type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(typeof body.id).toBe("string")
		expect(body.name).toBe("Alice")
		expect(body.email).toBe("a@b.com")
		createdId = body.id
	})

	it("GET /users/:id → returns created user", async () => {
		const res = await fetch(`${base}/users/${createdId}`, { headers: AUTH })
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.id).toBe(createdId)
		expect(body.name).toBe("Alice")
		expect(body.email).toBe("a@b.com")
	})

	it("GET /users → non-empty after create", async () => {
		const res = await fetch(`${base}/users`, { headers: AUTH })
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.items.length).toBe(1)
		expect(body.total).toBe(1)
	})

	it("PUT /users/:id → updates name, preserves email", async () => {
		const res = await fetch(`${base}/users/${createdId}`, {
			body: JSON.stringify({ name: "Bob" }),
			headers: { ...AUTH, "Content-Type": "application/json" },
			method: "PUT",
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.name).toBe("Bob")
		expect(body.email).toBe("a@b.com")
	})

	it("DELETE /users/:id → 204, subsequent GET returns 404", async () => {
		const delRes = await fetch(`${base}/users/${createdId}`, {
			headers: AUTH,
			method: "DELETE",
		})
		expect(delRes.status).toBe(204)

		const getRes = await fetch(`${base}/users/${createdId}`, { headers: AUTH })
		expect(getRes.status).toBe(404)
	})

	it("GET /users/:id → 404 with typed error body for missing id", async () => {
		const res = await fetch(`${base}/users/nonexistent-id`, { headers: AUTH })
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body).toEqual({ message: "Not found", status: 404 })
	})
})

describe("Auth", () => {
	it("GET /users with no token → 401 with error body", async () => {
		const res = await fetch(`${base}/users`)
		expect(res.status).toBe(401)
		const body = await res.json()
		expect(body).toEqual({ message: "Unauthorized", status: 401 })
	})

	it("GET /users with expired token → 401", async () => {
		const res = await fetch(`${base}/users`, {
			headers: { Authorization: "Bearer expired-token" },
		})
		expect(res.status).toBe(401)
	})

	it("GET /users with valid token → 200", async () => {
		const res = await fetch(`${base}/users`, { headers: AUTH })
		expect(res.status).toBe(200)
	})

	it("POST /auth/refresh with valid refresh_token → 200 + access_token", async () => {
		const res = await fetch(`${base}/auth/refresh`, {
			body: JSON.stringify({ refresh_token: "refresh-valid" }),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body).toEqual({ access_token: "valid-token", expires_in: 3600 })
	})

	it("POST /auth/refresh with bad refresh_token → 401", async () => {
		const res = await fetch(`${base}/auth/refresh`, {
			body: JSON.stringify({ refresh_token: "bad" }),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(401)
	})
})

describe("SSE", () => {
	it("GET /stream → Content-Type text/event-stream, 3 events event-0..event-2", async () => {
		const res = await fetch(`${base}/stream`, {
			headers: { ...AUTH, Accept: "text/event-stream" },
		})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toMatch(/text\/event-stream/)

		const events: Array<{ data?: string; event?: string; id?: string }> = []

		if (!res.body) throw new Error("No response body")

		for await (const event of parseSSEStream(res.body)) {
			events.push(event)
		}

		expect(events.length).toBe(3)
		expect(events[0]).toMatchObject({ data: "event-0", event: "message" })
		expect(events[1]).toMatchObject({ data: "event-1", event: "message" })
		expect(events[2]).toMatchObject({ data: "event-2", event: "message" })
	})

	it("GET /stream with Last-Event-ID: 1 → resumes from event-2 (1 event)", async () => {
		const res = await fetch(`${base}/stream`, {
			headers: { ...AUTH, Accept: "text/event-stream", "Last-Event-ID": "1" },
		})
		expect(res.status).toBe(200)

		const events: Array<{ data?: string; event?: string; id?: string }> = []

		if (!res.body) throw new Error("No response body")

		for await (const event of parseSSEStream(res.body)) {
			events.push(event)
		}

		expect(events.length).toBe(1)
		expect(events[0]).toMatchObject({ data: "event-2", event: "message" })
	})
})

describe("WebSocket", () => {
	it("WS /ws → echo: send 'hello', receive 'hello' back", async () => {
		await new Promise<void>((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
			ws.on("open", () => {
				ws.send("hello")
			})
			ws.on("message", (data) => {
				try {
					expect(data.toString()).toBe("hello")
					ws.close()
					resolve()
				} catch (err) {
					ws.close()
					reject(err)
				}
			})
			ws.on("error", reject)
		})
	})
})

describe("Error Routes", () => {
	it("GET /errors/400 → 400 with { status: 400, message: 'Bad Request' }", async () => {
		const res = await fetch(`${base}/errors/400`)
		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body).toEqual({ message: "Bad Request", status: 400 })
	})

	it("GET /errors/404 → 404 with { status: 404, message: 'Not Found' }", async () => {
		const res = await fetch(`${base}/errors/404`)
		expect(res.status).toBe(404)
		const body = await res.json()
		expect(body).toEqual({ message: "Not Found", status: 404 })
	})

	it("GET /errors/500 → 500 with { status: 500, message: 'Internal Server Error' }", async () => {
		const res = await fetch(`${base}/errors/500`)
		expect(res.status).toBe(500)
		const body = await res.json()
		expect(body).toEqual({ message: "Internal Server Error", status: 500 })
	})

	it("GET /errors/422 → 422 with { status: 422, message: 'Unprocessable Entity' }", async () => {
		const res = await fetch(`${base}/errors/422`)
		expect(res.status).toBe(422)
		const body = await res.json()
		expect(body).toEqual({ message: "Unprocessable Entity", status: 422 })
	})
})

describe("Invalidation", () => {
	let userId: string

	it("POST /users response includes x-invalidate: GET /users", async () => {
		const res = await fetch(`${base}/users`, {
			body: JSON.stringify({ email: "e@f.com", name: "Eve" }),
			headers: { ...AUTH, "Content-Type": "application/json" },
			method: "POST",
		})
		expect(res.status).toBe(201)
		expect(res.headers.get("x-invalidate")).toBe("GET /users")
		const body = await res.json()
		userId = body.id
	})

	it("PUT /users/:id response includes x-invalidate: GET /users,GET /users/:id", async () => {
		const res = await fetch(`${base}/users/${userId}`, {
			body: JSON.stringify({ name: "Eve Updated" }),
			headers: { ...AUTH, "Content-Type": "application/json" },
			method: "PUT",
		})
		expect(res.status).toBe(200)
		expect(res.headers.get("x-invalidate")).toBe("GET /users,GET /users/:id")
	})

	it("DELETE /users/:id response includes x-invalidate: GET /users,GET /users/:id", async () => {
		const res = await fetch(`${base}/users/${userId}`, {
			headers: AUTH,
			method: "DELETE",
		})
		expect(res.status).toBe(204)
		expect(res.headers.get("x-invalidate")).toBe("GET /users,GET /users/:id")
	})
})

describe("OpenAPI Spec Validation", () => {
	let spec: Record<string, unknown>

	it("spec.json has required OpenAPI 3.1 structure", async () => {
		const raw = await import("./spec.json", { with: { type: "json" } })
		spec = raw.default as Record<string, unknown>
		expect(spec.openapi).toBe("3.1.0")
		expect(spec.info).toBeDefined()
		expect(spec.paths).toBeDefined()
		const components = spec.components as Record<string, unknown> | undefined
		expect(components?.schemas).toBeDefined()
		expect(components?.securitySchemes).toBeDefined()
	})

	it("generateSDK consumes spec.json without error and returns files", () => {
		const result = generateSDK(spec as Parameters<typeof generateSDK>[0])
		expect(result.files).toBeDefined()
		expect(typeof result.files.types).toBe("string")
	})

	it("generatePythonSDK consumes spec.json without error and returns files", () => {
		const result = generatePythonSDK(spec)
		expect(result.files).toBeDefined()
		expect(typeof result.files["types.py"]).toBe("string")
	})

	it("generateGoSDK consumes spec.json without error and returns files", () => {
		const result = generateGoSDK(spec)
		expect(result.files).toBeDefined()
		expect(typeof result.files["types.go"]).toBe("string")
	})

	it("generateRustSDK consumes spec.json without error and returns files", () => {
		const result = generateRustSDK(spec)
		expect(result.files).toBeDefined()
		expect(typeof Object.keys(result.files)[0]).toBe("string")
	})
})
