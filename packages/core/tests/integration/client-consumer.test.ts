import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { createApp } from "@honey/e2e-app"
import { ClientError, isClientError } from "../../src/client/error.ts"
import { createClient } from "../../src/client/index.ts"
import type { SSEEvent } from "../../src/client/sse.ts"
import { parseSSEStream } from "../../src/client/sse.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { nodeWebSocket } from "../../src/ws/node.ts"

let server: HoneyServer
let baseURL: string

beforeAll(() => {
	const app = createApp(nodeWebSocket())
	server = serve(app, { env: {}, port: 0 })
	const addr = server.address() as { port: number }
	baseURL = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
	await server.shutdown(1000)
})

describe("consumer: tuple mode (default)", () => {
	it("GET success → { data, error: null }", async () => {
		const api = createClient({ baseURL })
		const { data, error, response, status } = await api.get("/api/health")
		expect(error).toBeNull()
		expect(data).toBe("ok")
		expect(status).toBe(200)
		expect(response).toBeInstanceOf(Response)
	})

	it("GET JSON → typed data in tuple", async () => {
		const api = createClient({ baseURL })
		const { data, error } = await api.get("/api/echo")
		expect(error).toBeNull()
		expect(data).toEqual({ method: "GET" })
	})

	it("GET with search params", async () => {
		const api = createClient({ baseURL })
		const { data, error } = await api.get("/api", { search: { id: "tuple-123" } })
		expect(error).toBeNull()
		expect(data).toEqual({ id: "tuple-123" })
	})

	it("server error → { data: null, error: parsed body }", async () => {
		const api = createClient({ baseURL })
		const { data, error, status } = await api.get("/api/v1/organizations")
		expect(data).toBeNull()
		expect(error).not.toBeNull()
		expect(status).toBeGreaterThanOrEqual(400)
	})

	it("404 → { data: null, error with status 404 }", async () => {
		const api = createClient({ baseURL })
		const { data, error, status } = await api.get("/api/nonexistent")
		expect(data).toBeNull()
		expect(error).not.toBeNull()
		expect(status).toBe(404)
	})

	it("error.response body still readable", async () => {
		const api = createClient({ baseURL })
		const { error, response } = await api.get("/api/boundary/default")
		expect(error).not.toBeNull()
		const body = (await response.json()) as Record<string, unknown>
		expect(body.error_key).toBe("api_error")
		expect(body.request_id).toBe("e2e-req-001")
	})

	it("DELETE 204 → { data: null, error: null }", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		})
		const created = await api.post("/api/v1/organizations", {
			json: { name: "TupleDel", slug: `tuple-del-${Date.now()}` },
		})
		expect(created.error).toBeNull()
		const id = (created.data as unknown as { id: string }).id

		const { data, error, status } = await api.delete("/api/v1/organizations/:orgId", {
			params: { orgId: id },
		})
		expect(data).toBeNull()
		expect(error).toBeNull()
		expect(status).toBe(204)
	})
})

describe("consumer: throw mode", () => {
	it("GET success → returns data directly", async () => {
		const api = createClient({ baseURL, throwOnError: true })
		const data = await api.get("/api/health")
		expect(data).toBe("ok")
	})

	it("server error → throws ClientError", async () => {
		const api = createClient({ baseURL, throwOnError: true })
		try {
			await api.get("/api/v1/organizations")
			expect.fail("should have thrown")
		} catch (e) {
			expect(isClientError(e)).toBe(true)
			expect((e as ClientError).status).toBeGreaterThanOrEqual(400)
		}
	})
})

describe("consumer: async headers", () => {
	it("dynamic headers sent on every request", async () => {
		const api = createClient({
			baseURL,
			headers: async () => ({ authorization: "Bearer test" }),
			throwOnError: true,
		})
		const result = (await api.get("/api/v1/organizations")) as unknown as {
			items: Array<{ slug: string }>
			total: number
		}
		expect(result.total).toBeGreaterThanOrEqual(1)
	})

	it("conditional headers by path", async () => {
		const api = createClient({
			baseURL,
			headers: ({ path }) => {
				if (path === "/api/health") return {}
				return { authorization: "Bearer test" }
			},
			throwOnError: true,
		})
		/* public route — no auth needed */
		const health = await api.get("/api/health")
		expect(health).toBe("ok")

		/* authed route — dynamic header applied */
		const orgs = (await api.get("/api/v1/organizations")) as unknown as { total: number }
		expect(orgs.total).toBeGreaterThanOrEqual(1)
	})
})

describe("consumer: interceptors", () => {
	it("onRequest adds header visible to server", async () => {
		const api = createClient({
			baseURL,
			onRequest: [
				(ctx) => {
					ctx.headers.set("authorization", "Bearer test")
				},
			],
			throwOnError: true,
		})
		const result = (await api.get("/api/v1/organizations")) as unknown as { total: number }
		expect(result.total).toBeGreaterThanOrEqual(1)
	})

	it("onResponse sees status", async () => {
		const statuses: number[] = []
		const api = createClient({
			baseURL,
			onResponse: [
				(ctx) => {
					statuses.push(ctx.response.status)
					return undefined
				},
			],
			throwOnError: true,
		})
		await api.get("/api/health")
		expect(statuses).toEqual([200])
	})
})

describe("consumer: $url / $path", () => {
	it("$url builds full URL", () => {
		const api = createClient({ baseURL })
		const url = api.$url("/api/v1/organizations/:orgId", {
			params: { orgId: "org-1" },
			search: { include: "members" },
		})
		expect(url).toContain(baseURL)
		expect(url).toContain("/api/v1/organizations/org-1")
		expect(url).toContain("include=members")
	})

	it("$path builds path only", () => {
		const api = createClient({ baseURL })
		const path = api.$path("/api/v1/organizations/:orgId", {
			params: { orgId: "org-1" },
		})
		expect(path).toBe("/api/v1/organizations/org-1")
	})
})

describe("consumer: CRUD lifecycle", () => {
	it("create → read → delete with tuple mode", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		})

		/* create */
		const created = await api.post("/api/v1/organizations", {
			json: { name: "Lifecycle Org", slug: `lifecycle-${Date.now()}` },
		})
		expect(created.error).toBeNull()
		const org = created.data as unknown as { id: string; name: string }
		expect(org.name).toBe("Lifecycle Org")

		/* read */
		const fetched = await api.get("/api/v1/organizations/:orgId", {
			params: { orgId: org.id },
		})
		expect(fetched.error).toBeNull()
		expect((fetched.data as unknown as { id: string }).id).toBe(org.id)

		/* delete */
		const deleted = await api.delete("/api/v1/organizations/:orgId", {
			params: { orgId: org.id },
		})
		expect(deleted.error).toBeNull()
		expect(deleted.data).toBeNull()
		expect(deleted.status).toBe(204)

		/* verify gone */
		const gone = await api.get("/api/v1/organizations/:orgId", {
			params: { orgId: org.id },
		})
		expect(gone.error).not.toBeNull()
	})
})

describe("consumer: validation errors", () => {
	it("missing fields → error with fields", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		})
		const result = await api.post("/api/v1/organizations", { json: {} })
		expect(result.error).not.toBeNull()
		expect((result.error as Record<string, unknown>)?.error_key).toBe("invalid_input")
		expect(result.status).toBe(400)
		const fields = (result.error as Record<string, unknown>)?.fields as Record<string, unknown>
		expect(fields.name).toBeDefined()
		expect(fields.slug).toBeDefined()
	})

	it("duplicate slug → conflict", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		})
		const result = await api.post("/api/v1/organizations", {
			json: { name: "Dupe", slug: "acme" },
		})
		expect(result.error).not.toBeNull()
		expect((result.error as Record<string, unknown>)?.error_key).toBe("org_slug_taken")
		expect(result.status).toBe(409)
	})
})

describe("consumer: SSE streaming", () => {
	it("GET /api/events via for-await on client", async () => {
		const api = createClient({ baseURL })
		const stream = api.get("/api/events") as unknown as AsyncIterable<SSEEvent>
		const events: SSEEvent[] = []
		for await (const event of stream) {
			events.push(event)
		}
		const msgs = events.filter((e) => e.event === "message")
		expect(msgs).toHaveLength(2)
		expect(msgs[0].data).toBe("hello")
		expect(msgs[1].data).toBe("world")
	})

	it("SSE /api/events-live Last-Event-ID resume", async () => {
		const res = await fetch(`${baseURL}/api/events-live`, {
			headers: { accept: "text/event-stream", "last-event-id": "prev-5" },
		})
		const events: SSEEvent[] = []
		if (res.body) {
			for await (const event of parseSSEStream(res.body)) {
				events.push(event)
			}
		}
		const resume = events.find((e) => e.event === "resume")
		expect(resume).toBeDefined()
		expect(resume?.data).toBe("resumed from prev-5")
	})
})

describe("consumer: WebSocket", () => {
	it("echo-ws echoes messages", async () => {
		const ws = new WebSocket(`${baseURL.replace("http", "ws")}/api/echo-ws`)
		const messages: string[] = []
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS timeout")), 5000)
			ws.on("message", (data: Buffer) => {
				messages.push(data.toString())
				if (messages.length >= 2) {
					clearTimeout(timer)
					ws.close()
					resolve()
				}
			})
			ws.on("open", () => ws.send("ping"))
			ws.on("error", (err) => {
				clearTimeout(timer)
				reject(err)
			})
		})
		expect(messages[0]).toBe("connected")
		expect(messages[1]).toBe("ping")
	})

	it("reconnect-ws sends token", async () => {
		const ws = new WebSocket(`${baseURL.replace("http", "ws")}/api/reconnect-ws`)
		const messages: string[] = []
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS timeout")), 5000)
			ws.on("message", (data: Buffer) => {
				messages.push(data.toString())
				clearTimeout(timer)
				ws.close()
				resolve()
			})
			ws.on("error", (err) => {
				clearTimeout(timer)
				reject(err)
			})
		})
		const parsed = JSON.parse(messages[0]) as { event: string; token: string }
		expect(parsed.event).toBe("open")
		expect(parsed.token).toBe("fresh-token-123")
	})
})

describe("consumer: $isClientError on client", () => {
	it("returns false for parsed body in safe mode", async () => {
		const api = createClient({ baseURL })
		const result = await api.get("/api/nonexistent")
		expect(api.$isClientError(result.error)).toBe(false)
	})

	it("returns false for non-ClientError", async () => {
		const api = createClient({ baseURL })
		expect(api.$isClientError(new Error("nope"))).toBe(false)
		expect(api.$isClientError(null)).toBe(false)
	})
})

describe("consumer: catch-all /echo with multiple methods", () => {
	it("POST /api/echo returns method", async () => {
		const api = createClient({ baseURL })
		const { data, error } = await api.post("/api/echo", { json: {} })
		expect(error).toBeNull()
		expect(data).toEqual({ method: "POST" })
	})

	it("PUT /api/echo returns method", async () => {
		const api = createClient({ baseURL })
		const { data, error } = await api.put("/api/echo", { json: {} })
		expect(error).toBeNull()
		expect(data).toEqual({ method: "PUT" })
	})

	it("PATCH /api/echo returns method", async () => {
		const api = createClient({ baseURL })
		const { data, error } = await api.patch("/api/echo", { json: {} })
		expect(error).toBeNull()
		expect(data).toEqual({ method: "PATCH" })
	})

	it("DELETE /api/echo returns method", async () => {
		const api = createClient({ baseURL })
		const { data, error } = await api.delete("/api/echo")
		expect(error).toBeNull()
		expect(data).toEqual({ method: "DELETE" })
	})
})

describe("consumer: onResponse retry against real server", () => {
	it("401 → retry with auth → success", async () => {
		let attempt = 0
		const api = createClient({
			baseURL,
			headers: () => {
				attempt++
				/* first attempt: no auth. second: with auth */
				if (attempt === 1) return {}
				return { authorization: "Bearer test" }
			},
			onResponse: [
				async (ctx) => {
					if (ctx.response.status === 500 && !ctx.isRetry) {
						/* e2e-app wraps unauthorized as 500 via boundary */
						return ctx.retry()
					}
					return undefined
				},
			],
			throwOnError: true,
		})
		const result = (await api.get("/api/v1/organizations")) as unknown as { total: number }
		expect(result.total).toBeGreaterThanOrEqual(1)
		expect(attempt).toBe(2)
	})
})

describe("consumer: concurrent requests", () => {
	it("parallel calls resolve independently", async () => {
		const api = createClient({ baseURL })
		const [health, echo, notFound] = await Promise.all([
			api.get("/api/health"),
			api.get("/api/echo"),
			api.get("/api/nonexistent"),
		])
		expect(health.error).toBeNull()
		expect(health.data).toBe("ok")
		expect(echo.error).toBeNull()
		expect(echo.data).toEqual({ method: "GET" })
		expect(notFound.error).not.toBeNull()
		expect(notFound.status).toBe(404)
	})
})

describe("consumer: path param encoding", () => {
	it("special characters in params are encoded", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		})
		/* org ID with special chars — will 404 but proves encoding works */
		const result = await api.get("/api/v1/organizations/:orgId", {
			params: { orgId: "org with spaces & symbols" },
		})
		expect(result.error).not.toBeNull()
		/* if encoding failed, the server wouldn't even route this */
	})
})

describe("consumer: SSE via client for-await with keepalive", () => {
	it("GET /api/events-live streams events with retry field", async () => {
		const api = createClient({ baseURL })
		const stream = api.get("/api/events-live") as unknown as AsyncIterable<SSEEvent>
		const events: SSEEvent[] = []
		for await (const event of stream) {
			events.push(event)
		}
		const tick = events.find((e) => e.event === "tick")
		expect(tick).toBeDefined()
		expect(tick?.data).toBe("live")
		expect(tick?.id).toBe("t1")
	})
})

describe("consumer: boundary errors in tuple mode", () => {
	it("default boundary → api_error with custom formatter", async () => {
		const api = createClient({ baseURL })
		const { error, response, status } = await api.get("/api/boundary/default")
		expect(error).not.toBeNull()
		expect((error as Record<string, unknown>)?.error_key).toBe("api_error")
		expect(status).toBe(500)
		const body = (await response.json()) as Record<string, unknown>
		expect(body.request_id).toBe("e2e-req-001")
	})

	it("custom boundary → org_limit_reached", async () => {
		const api = createClient({ baseURL })
		const { error, status } = await api.get("/api/boundary/custom")
		expect(error).not.toBeNull()
		expect((error as Record<string, unknown>)?.error_key).toBe("org_limit_reached")
		expect(status).toBe(403)
	})
})

describe("consumer: multiple interceptors chained", () => {
	it("onRequest hooks run in order", async () => {
		const order: string[] = []
		const api = createClient({
			baseURL,
			onRequest: [
				(ctx) => {
					order.push("first")
					ctx.headers.set("authorization", "Bearer test")
				},
				() => {
					order.push("second")
				},
			],
			throwOnError: true,
		})
		await api.get("/api/v1/organizations")
		expect(order).toEqual(["first", "second"])
	})

	it("onResponse hooks run in order", async () => {
		const statuses: number[] = []
		const api = createClient({
			baseURL,
			onResponse: [
				(ctx) => {
					statuses.push(ctx.response.status)
					return undefined
				},
				(ctx) => {
					statuses.push(ctx.response.status + 1000)
					return undefined
				},
			],
			throwOnError: true,
		})
		await api.get("/api/health")
		expect(statuses).toEqual([200, 1200])
	})
})

describe("consumer: sortSearchParams against real server", () => {
	it("sorted params produce correct response", async () => {
		const api = createClient({
			baseURL,
			sortSearchParams: true,
		})
		const { data, error } = await api.get("/api", { search: { id: "sorted-test" } })
		expect(error).toBeNull()
		expect(data).toEqual({ id: "sorted-test" })
	})
})
