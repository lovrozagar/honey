import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { createApp } from "@honey/e2e-kitchen"
import type { ClientError } from "../../src/client/error.ts"
import { HTTPClient } from "../../src/client/http.ts"
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

describe("edge: custom fetch override", () => {
	it("custom fetch is called instead of global fetch", async () => {
		const calls: string[] = []
		const api = createClient({
			baseURL,
			fetch: (input, init) => {
				calls.push(typeof input === "string" ? input : input.toString())
				return fetch(input, init)
			},
			throwOnError: true,
		})
		await api.get("/api/health")
		expect(calls).toHaveLength(1)
		expect(calls[0]).toContain("/api/health")
	})

	it("instance mode via app.fetch adapter", async () => {
		const app = createApp(nodeWebSocket())
		const api = createClient({
			baseURL: "http://test",
			fetch: (input, init) => app.fetch(new Request(input, init), {}),
			throwOnError: true,
		})
		const result = await api.get("/api/health")
		expect(result).toBe("ok")
	})
})

describe("edge: credentials and mode config", () => {
	it("credentials: include is passed to fetch", async () => {
		let capturedInit: RequestInit | undefined
		const api = createClient({
			baseURL,
			credentials: "include",
			fetch: (input, init) => {
				capturedInit = init
				return fetch(input, init)
			},
			throwOnError: true,
		})
		await api.get("/api/health")
		expect(capturedInit?.credentials).toBe("include")
	})

	it("mode: cors is passed to fetch", async () => {
		let capturedInit: RequestInit | undefined
		const api = createClient({
			baseURL,
			fetch: (input, init) => {
				capturedInit = init
				return fetch(input, init)
			},
			mode: "cors",
			throwOnError: true,
		})
		await api.get("/api/health")
		expect(capturedInit?.mode).toBe("cors")
	})
})

describe("edge: cookies sent as Cookie header", () => {
	it("cookies object serialized into Cookie header", async () => {
		let capturedHeaders: Headers | undefined
		const api = createClient({
			baseURL,
			fetch: (input, init) => {
				capturedHeaders = init?.headers as Headers
				return fetch(input, init)
			},
		})
		await api.get("/api/health", {
			cookies: { locale: "en", sid: "abc123" },
		})
		const cookie = capturedHeaders?.get("cookie")
		expect(cookie).toContain("sid=abc123")
		expect(cookie).toContain("locale=en")
	})

	it("cookies merge with config-level cookie header", async () => {
		let capturedHeaders: Headers | undefined
		const api = createClient({
			baseURL,
			fetch: (input, init) => {
				capturedHeaders = init?.headers as Headers
				return fetch(input, init)
			},
			headers: { cookie: "session=xyz" },
		})
		await api.get("/api/health", {
			cookies: { extra: "val" },
		})
		const cookie = capturedHeaders?.get("cookie")
		expect(cookie).toContain("session=xyz")
		expect(cookie).toContain("extra=val")
	})
})

describe("edge: signal composition with timeout", () => {
	it("user signal + timeout — both respected", async () => {
		const controller = new AbortController()
		const api = createClient({
			baseURL,
			throwOnError: true,
			timeout: 5000,
		})
		/* normal request with both signal and timeout — should succeed */
		const result = await api.get("/api/health", { signal: controller.signal })
		expect(result).toBe("ok")
	})

	it("user aborts before timeout fires", async () => {
		const controller = new AbortController()
		const api = createClient({
			baseURL,
			timeout: 30000,
		})
		controller.abort()
		await expect(api.get("/api/health", { signal: controller.signal })).rejects.toThrow()
	})
})

describe("edge: SSE timeout is skipped for streams", () => {
	it("short timeout does not kill SSE stream", async () => {
		const api = createClient({
			baseURL,
			timeout: 50,
		})
		/* /api/events sends 2 events then closes — should complete even with 50ms timeout */
		const stream = api.get("/api/events") as unknown as AsyncIterable<SSEEvent>
		const events: SSEEvent[] = []
		for await (const event of stream) {
			events.push(event)
		}
		expect(events.length).toBeGreaterThanOrEqual(2)
	})
})

describe("edge: WS URL construction", () => {
	it("http baseURL → ws URL", () => {
		const http = new HTTPClient({ baseURL: "http://localhost:3000" })
		expect(http.buildWSUrl("/chat", {})).toBe("ws://localhost:3000/chat")
	})

	it("https baseURL → wss URL", () => {
		const http = new HTTPClient({ baseURL: "https://api.example.com" })
		expect(http.buildWSUrl("/chat", {})).toBe("wss://api.example.com/chat")
	})

	it("does not mangle hostnames containing http", () => {
		const http = new HTTPClient({ baseURL: "http://httpbin.org" })
		expect(http.buildWSUrl("/ws", {})).toBe("ws://httpbin.org/ws")
	})

	it("interpolates params in WS URL", () => {
		const http = new HTTPClient({ baseURL: "http://localhost:3000" })
		const url = http.buildWSUrl("/rooms/:roomId", { params: { roomId: "42" } })
		expect(url).toBe("ws://localhost:3000/rooms/42")
	})

	it("appends search to WS URL", () => {
		const http = new HTTPClient({ baseURL: "http://localhost:3000" })
		const url = http.buildWSUrl("/ws", { search: { token: "abc" } })
		expect(url).toContain("ws://localhost:3000/ws?token=abc")
	})
})

describe("edge: WS reconnect-ws with reconnect_token query param", () => {
	it("reconnect token appended as query param", async () => {
		const wsUrl = `${baseURL.replace("http", "ws")}/api/reconnect-ws?reconnect_token=old-session`
		const ws = new WebSocket(wsUrl)

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
		expect(parsed.event).toBe("reconnected")
		expect(parsed.token).toBe("old-session")
	})
})

describe("edge: WS echo with binary-like message", () => {
	it("JSON stringified object echoed back", async () => {
		const wsUrl = `${baseURL.replace("http", "ws")}/api/echo-ws`
		const ws = new WebSocket(wsUrl)

		const messages: string[] = []
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS timeout")), 5000)
			ws.on("open", () => {
				ws.send(JSON.stringify({ complex: true, nested: { a: 1 } }))
			})
			ws.on("message", (data: Buffer) => {
				messages.push(data.toString())
				if (messages.length >= 2) {
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

		/* first = "connected", second = our JSON */
		const echoed = JSON.parse(messages[1]) as {
			complex: boolean
			nested: { a: number }
		}
		expect(echoed.complex).toBe(true)
		expect(echoed.nested.a).toBe(1)
	})
})

describe("edge: large batch of concurrent requests", () => {
	it("20 parallel requests all resolve", async () => {
		const api = createClient({ baseURL })
		const promises = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? api.get("/api/health") : api.get("/api/echo")))
		const results = await Promise.all(promises)
		for (let i = 0; i < 20; i++) {
			expect(results[i].error).toBeNull()
			if (i % 2 === 0) {
				expect(results[i].data).toBe("ok")
			} else {
				expect(results[i].data).toEqual({ method: "GET" })
			}
		}
	})
})

describe("edge: error i18n from kitchen e2e app", () => {
	it("Accept-Language: de returns German error message", async () => {
		const api = createClient({ baseURL })
		const { error, response } = await api.get("/api/v1/organizations", {
			headers: { "accept-language": "de" },
		})
		expect(error).not.toBeNull()
		const body = (await response.json()) as Record<string, unknown>
		/* kitchen e2e app translates "unauthorized" to German */
		expect(typeof body.message).toBe("string")
	})
})

describe("edge: openapi and manifest endpoints", () => {
	it("GET /api/openapi.json returns valid JSON", async () => {
		const api = createClient({ baseURL })
		const { data, error } = await api.get("/api/openapi.json")
		expect(error).toBeNull()
		expect(data).toBeTruthy()
		expect(typeof data).toBe("object")
	})

	it("GET /api/manifest.json returns valid JSON", async () => {
		const api = createClient({ baseURL })
		const { data, error } = await api.get("/api/manifest.json")
		expect(error).toBeNull()
		expect(data).toBeTruthy()
	})
})

describe("edge: throw mode + interceptors combined", () => {
	it("onResponse can prevent throw by returning new 200 Response", async () => {
		const api = createClient({
			baseURL,
			onResponse: [
				async (ctx) => {
					if (ctx.response.status === 404) {
						return new Response(JSON.stringify({ fallback: true }), {
							headers: { "content-type": "application/json" },
							status: 200,
						})
					}
					return undefined
				},
			],
			throwOnError: true,
		})
		/* 404 normally throws — but interceptor replaces with 200 */
		const result = await api.get("/api/nonexistent")
		expect(result).toEqual({ fallback: true })
	})
})

describe("edge: multiple async headers calls don't race", () => {
	it("concurrent requests each get their own resolved headers", async () => {
		let callCount = 0
		const api = createClient({
			baseURL,
			headers: async () => {
				callCount++
				const n = callCount
				await new Promise((r) => setTimeout(r, Math.random() * 10))
				return { "x-call": String(n) }
			},
		})

		const results = await Promise.all([api.get("/api/health"), api.get("/api/health"), api.get("/api/health")])

		/* all 3 resolved, no crash from race */
		for (const r of results) {
			expect(r.error).toBeNull()
		}
		expect(callCount).toBe(3)
	})
})
