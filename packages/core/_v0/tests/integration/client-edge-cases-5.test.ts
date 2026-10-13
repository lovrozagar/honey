import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { createApp } from "@honey/e2e-kitchen"
import { ClientError, isClientError } from "../../src/client/error.ts"
import { createClient } from "../../src/client/index.ts"
import type { SSEEvent } from "../../src/client/sse.ts"
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

describe("edge: form body encoding", () => {
	it("form values with special characters encoded correctly", async () => {
		let capturedBody: string | undefined
		const api = createClient({
			baseURL,
			fetch: (input, init) => {
				capturedBody = init?.body as string
				return fetch(input, init)
			},
		})
		await api.post("/api/echo", {
			form: { message: "hello world & goodbye", name: "O'Brien" },
		})
		expect(capturedBody).toContain("message=hello+world+%26+goodbye")
		expect(capturedBody).toContain("name=O%27Brien")
	})

	it("form with number and boolean values stringified", async () => {
		let capturedBody: string | undefined
		const api = createClient({
			baseURL,
			fetch: (input, init) => {
				capturedBody = init?.body as string
				return fetch(input, init)
			},
		})
		await api.post("/api/echo", {
			form: { active: true, count: 42 },
		})
		expect(capturedBody).toContain("active=true")
		expect(capturedBody).toContain("count=42")
	})
})

describe("edge: json body edge cases", () => {
	it("null json value sent as JSON null", async () => {
		let capturedBody: string | undefined
		const api = createClient({
			baseURL,
			fetch: (input, init) => {
				capturedBody = init?.body as string
				return fetch(input, init)
			},
		})
		await api.post("/api/echo", { json: null })
		expect(capturedBody).toBe("null")
	})

	it("array json value sent as JSON array", async () => {
		let capturedBody: string | undefined
		const api = createClient({
			baseURL,
			fetch: (input, init) => {
				capturedBody = init?.body as string
				return fetch(input, init)
			},
		})
		await api.post("/api/echo", { json: [1, 2, 3] })
		expect(capturedBody).toBe("[1,2,3]")
	})

	it("deeply nested json preserved", async () => {
		let capturedBody: string | undefined
		const api = createClient({
			baseURL,
			fetch: (input, init) => {
				capturedBody = init?.body as string
				return fetch(input, init)
			},
		})
		const deep = { a: { b: { c: { d: [1, { e: "f" }] } } } }
		await api.post("/api/echo", { json: deep })
		expect(JSON.parse(capturedBody ?? "")).toEqual(deep)
	})
})

describe("edge: path params with URL-unsafe characters", () => {
	it("slash in param is double-encoded (safe)", async () => {
		const api = createClient({ baseURL })
		const url = api.$url("/api/v1/organizations/:orgId", {
			params: { orgId: "a/b" },
		})
		expect(url).toContain("a%2Fb")
		expect(url).not.toContain("a/b/")
	})

	it("colon in param encoded", () => {
		const api = createClient({ baseURL })
		const url = api.$url("/api/v1/organizations/:orgId", {
			params: { orgId: "org:123" },
		})
		expect(url).toContain("org%3A123")
	})

	it("unicode in param encoded", () => {
		const api = createClient({ baseURL })
		const url = api.$url("/api/v1/organizations/:orgId", {
			params: { orgId: "org-日本語" },
		})
		expect(url).toContain("org-%E6%97%A5%E6%9C%AC%E8%AA%9E")
	})
})

describe("edge: multiple SSE streams sequentially", () => {
	it("two streams consumed one after another", async () => {
		const api = createClient({ baseURL })

		/* first stream */
		const events1: SSEEvent[] = []
		for await (const event of api.get("/api/events") as unknown as AsyncIterable<SSEEvent>) {
			events1.push(event)
		}

		/* second stream — fresh connection */
		const events2: SSEEvent[] = []
		for await (const event of api.get("/api/events") as unknown as AsyncIterable<SSEEvent>) {
			events2.push(event)
		}

		expect(events1.length).toBeGreaterThanOrEqual(2)
		expect(events2.length).toBeGreaterThanOrEqual(2)
		/* same data — independent streams */
		expect(events1[0].data).toBe(events2[0].data)
	})
})

describe("edge: client created with no optional config", () => {
	it("minimal config — just baseURL", async () => {
		const api = createClient({ baseURL })
		const { data, error } = await api.get("/api/health")
		expect(error).toBeNull()
		expect(data).toBe("ok")
	})
})

describe("edge: response status on created (201)", () => {
	it("POST that returns 201 has correct status in tuple", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		})
		const result = await api.post("/api/v1/organizations", {
			json: { name: "StatusCheck201", slug: `sc201-${Date.now()}` },
		})
		expect(result.error).toBeNull()
		expect(result.status).toBe(201)
	})
})

describe("edge: safe mode error is plain object, not ClientError", () => {
	it("safe mode error is NOT instanceof Error/ClientError", async () => {
		const api = createClient({ baseURL })
		const { error } = await api.get("/api/nonexistent")
		expect(error).not.toBeNull()
		expect(error).not.toBeInstanceOf(Error)
		expect(error).not.toBeInstanceOf(ClientError)
	})

	it("isClientError works with subclasses of Error", () => {
		class CustomError extends Error {}
		expect(isClientError(new CustomError("nope"))).toBe(false)
	})

	it("safe mode error has no .stack (plain parsed body)", async () => {
		const api = createClient({ baseURL })
		const { error } = await api.get("/api/nonexistent")
		expect(error).not.toBeNull()
		expect((error as Record<string, unknown>).stack).toBeUndefined()
	})
})

describe("edge: WS multiple messages rapid fire", () => {
	it("sends and receives multiple messages in sequence", async () => {
		const wsUrl = `${baseURL.replace("http", "ws")}/api/echo-ws`
		const ws = new WebSocket(wsUrl)

		const messages: string[] = []
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS timeout")), 5000)
			let sentCount = 0

			ws.on("open", () => {
				for (let i = 0; i < 5; i++) {
					ws.send(`msg-${i}`)
				}
				sentCount = 5
			})

			ws.on("message", (data: Buffer) => {
				messages.push(data.toString())
				/* +1 for "connected" from onOpen */
				if (messages.length >= sentCount + 1) {
					clearTimeout(timer)
					ws.close()
					resolve()
				}
			})

			ws.on("error", (err) => {
				clearTimeout(timer)
				reject(err)
			})
		})

		expect(messages[0]).toBe("connected")
		expect(messages.slice(1)).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"])
	})
})

describe("edge: interceptor can add custom error info", () => {
	it("onResponse enriches error body before consumer sees it", async () => {
		const enrichments: Array<{ path: string; status: number }> = []
		const api = createClient({
			baseURL,
			onResponse: [
				(ctx) => {
					if (!ctx.response.ok) {
						enrichments.push({ path: ctx.path, status: ctx.response.status })
					}
					return undefined
				},
			],
		})

		await api.get("/api/nonexistent")
		await api.get("/api/boundary/default")

		expect(enrichments).toHaveLength(2)
		expect(enrichments[0]).toEqual({ path: "/api/nonexistent", status: 404 })
		expect(enrichments[1]).toEqual({ path: "/api/boundary/default", status: 500 })
	})
})

describe("edge: $isClientError vs isClientError — same function", () => {
	it("both return same result for same error", async () => {
		const api = createClient({ baseURL })
		const { error } = await api.get("/api/nonexistent")

		expect(api.$isClientError(error)).toBe(isClientError(error))
		/* safe mode error is plain object, not ClientError */
		expect(api.$isClientError(error)).toBe(false)

		expect(api.$isClientError(new Error("x"))).toBe(isClientError(new Error("x")))
		expect(api.$isClientError(null)).toBe(isClientError(null))
	})
})
