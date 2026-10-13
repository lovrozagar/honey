import { describe, expect, it, vi } from "vitest"
import { ClientError } from "../../../src/client/error.ts"
import { HTTPClient } from "../../../src/client/http.ts"

function mockFetch(body: unknown, init?: ResponseInit): typeof fetch {
	return vi.fn().mockResolvedValue(
		new Response(JSON.stringify(body), {
			headers: { "content-type": "application/json" },
			...init,
		}),
	)
}

function mockStreamFetch(chunks: string[]): typeof fetch {
	const encoder = new TextEncoder()
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk))
			}
			controller.close()
		},
	})
	return vi.fn().mockResolvedValue(
		new Response(stream, {
			headers: { "content-type": "text/event-stream" },
			status: 200,
		}),
	)
}

describe("HTTPClient", () => {
	describe("request()", () => {
		it("makes GET request with correct URL", async () => {
			const fetchFn = mockFetch({ ok: true })
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
			})

			await client.request("GET", "/health", {})

			expect(fetchFn).toHaveBeenCalledOnce()
			const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(url).toBe("https://api.test.com/health")
		})

		it("appends search params to URL", async () => {
			const fetchFn = mockFetch({ items: [] })
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
			})

			await client.request("GET", "/items", {
				search: { limit: "10", q: "test" },
			})

			const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
			const parsed = new URL(url)
			expect(parsed.searchParams.get("limit")).toBe("10")
			expect(parsed.searchParams.get("q")).toBe("test")
		})

		it("sends JSON body on POST", async () => {
			const fetchFn = mockFetch({ id: "1" }, { status: 201 })
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
			})

			await client.request("POST", "/users", { json: { name: "Alice" } })

			const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(init.method).toBe("POST")
			expect(init.headers.get("content-type")).toBe("application/json")
			expect(init.body).toBe(JSON.stringify({ name: "Alice" }))
		})

		it("sends form-urlencoded body", async () => {
			const fetchFn = mockFetch({ ok: true })
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
			})

			await client.request("POST", "/login", {
				form: { password: "secret", username: "alice" },
			})

			const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(init.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
			expect(init.body).toContain("username=alice")
			expect(init.body).toContain("password=secret")
		})

		it("interpolates path params", async () => {
			const fetchFn = mockFetch({ id: "42" })
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
			})

			await client.request("GET", "/users/:id/posts/:postId", {
				params: { id: "42", postId: "7" },
			})

			const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(url).toBe("https://api.test.com/users/42/posts/7")
		})

		it("merges custom headers", async () => {
			const fetchFn = mockFetch({ ok: true })
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
				headers: { authorization: "Bearer token123" },
			})

			await client.request("GET", "/protected", {
				headers: { "x-custom": "value" },
			})

			const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(init.headers.get("authorization")).toBe("Bearer token123")
			expect(init.headers.get("x-custom")).toBe("value")
		})

		it("returns parsed JSON on success", async () => {
			const fetchFn = mockFetch({ id: "1", name: "Test" })
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
			})

			const result = await client.request("GET", "/users/1", {})
			expect(result).toEqual({ id: "1", name: "Test" })
		})

		it("throws ClientError on non-2xx", async () => {
			const makeErrorResponse = () =>
				new Response(
					JSON.stringify({
						error_key: "not_found",
						fields: {},
						message: "Not found",
						status: 404,
						status_key: "not_found",
					}),
					{ headers: { "content-type": "application/json" }, status: 404 },
				)
			const fetchFn = vi.fn().mockImplementation(() => Promise.resolve(makeErrorResponse()))
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
			})

			await expect(client.request("GET", "/missing", {})).rejects.toThrow(ClientError)

			try {
				await client.request("GET", "/missing", {})
			} catch (e) {
				expect(e).toBeInstanceOf(ClientError)
				const ce = e as ClientError
				expect(ce.status).toBe(404)
				const body = ce.body as Record<string, unknown>
				expect(body.error_key).toBe("not_found")
				expect(body.status_key).toBe("not_found")
			}
		})

		it("applies timeout via AbortSignal", async () => {
			const fetchFn = vi.fn().mockImplementation(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						if (init.signal) {
							init.signal.addEventListener("abort", () => reject(init.signal?.reason))
						}
					}),
			)
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
				timeout: 50,
			})

			await expect(client.request("GET", "/slow", {})).rejects.toThrow()
		})

		it("handles 204 No Content", async () => {
			const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
			})

			const result = await client.request("DELETE", "/items/1", {})
			expect(result).toBeNull()
		})
	})

	describe("requestStream()", () => {
		it("returns AsyncIterable for SSE response", async () => {
			const fetchFn = mockStreamFetch(["event: message\ndata: hello\n\nevent: message\ndata: world\n\n"])
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
			})

			const events = []
			for await (const event of client.requestStream("GET", "/events", {})) {
				events.push(event)
			}

			expect(events).toHaveLength(2)
			expect(events[0].data).toBe("hello")
			expect(events[1].data).toBe("world")
		})

		it("passes Last-Event-ID header when provided", async () => {
			const fetchFn = mockStreamFetch(["event: resume\ndata: ok\n\n"])
			const client = new HTTPClient({
				baseURL: "https://api.test.com",
				fetch: fetchFn,
			})

			const iter = client.requestStream("GET", "/events", {
				lastEventId: "evt-5",
			})
			for await (const _unusedEvent of iter) {
				/* consume */
			}

			const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
			expect(init.headers.get("last-event-id")).toBe("evt-5")
		})
	})

	describe("requestWS()", () => {
		it("constructs correct ws:// URL from http:// base", () => {
			const client = new HTTPClient({ baseURL: "http://localhost:3000" })
			const url = client.buildWSUrl("/echo-ws", {})
			expect(url).toBe("ws://localhost:3000/echo-ws")
		})

		it("constructs correct wss:// URL from https:// base", () => {
			const client = new HTTPClient({ baseURL: "https://api.test.com" })
			const url = client.buildWSUrl("/chat", {})
			expect(url).toBe("wss://api.test.com/chat")
		})

		it("interpolates params in WS URL", () => {
			const client = new HTTPClient({ baseURL: "https://api.test.com" })
			const url = client.buildWSUrl("/rooms/:roomId", {
				params: { roomId: "42" },
			})
			expect(url).toBe("wss://api.test.com/rooms/42")
		})

		it("converts a path-only baseURL against location.origin to wss", () => {
			const desc = Object.getOwnPropertyDescriptor(globalThis, "location")
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin: "https://app.example.com" },
			})
			try {
				const client = new HTTPClient({ baseURL: "/api" })
				expect(client.buildWSUrl("/echo-ws", {})).toBe("wss://app.example.com/api/echo-ws")
			} finally {
				if (desc) Object.defineProperty(globalThis, "location", desc)
				else Reflect.deleteProperty(globalThis, "location")
			}
		})
	})

	describe("default fetch and relative baseURL", () => {
		it("omitted fetch does not throw Illegal invocation when the environment fetch is a method", async () => {
			const previous = globalThis.fetch
			const urls: string[] = []
			function methodFetch(this: unknown, input: RequestInfo | URL): Promise<Response> {
				if (this !== globalThis) {
					throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
				}
				urls.push(String(input))
				return Promise.resolve(
					new Response(JSON.stringify({ ok: true }), {
						headers: { "content-type": "application/json" },
						status: 200,
					}),
				)
			}
			globalThis.fetch = methodFetch as typeof fetch
			try {
				const client = new HTTPClient({ baseURL: "https://api.example.com" })
				const result = await client.request("GET", "/health", {})
				expect(result).toEqual({ ok: true })
				expect(urls).toEqual(["https://api.example.com/health"])
			} finally {
				globalThis.fetch = previous
			}
		})

		it("honors a provided fetch as-is and does not call the environment fetch", async () => {
			const previous = globalThis.fetch
			let nativeCalls = 0
			globalThis.fetch = (async () => {
				nativeCalls++
				return new Response()
			}) as typeof fetch
			try {
				const fetchFn = mockFetch({ ok: true })
				const client = new HTTPClient({
					baseURL: "https://api.example.com",
					fetch: fetchFn,
				})
				await client.request("GET", "/health", {})
				expect(fetchFn).toHaveBeenCalledOnce()
				expect(nativeCalls).toBe(0)
			} finally {
				globalThis.fetch = previous
			}
		})

		it("joins a path-only baseURL with the operation path against location.origin", async () => {
			const desc = Object.getOwnPropertyDescriptor(globalThis, "location")
			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin: "https://app.example.com" },
			})
			try {
				const fetchFn = mockFetch({ ok: true })
				const client = new HTTPClient({
					baseURL: "/api",
					fetch: fetchFn,
				})
				await client.request("POST", "/v1/items", { json: { name: "n" } })
				const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
				expect(url).toBe("https://app.example.com/api/v1/items")
				expect(client.buildUrl("/v1/items", {})).toBe("https://app.example.com/api/v1/items")
			} finally {
				if (desc) Object.defineProperty(globalThis, "location", desc)
				else Reflect.deleteProperty(globalThis, "location")
			}
		})

		it("throws a clear error for a path-only baseURL without an origin", () => {
			const client = new HTTPClient({ baseURL: "/api", fetch: mockFetch({}) })
			expect(() => client.buildUrl("/v1/items", {})).toThrow(
				/Invalid baseURL "\/api": expected an absolute http\(s\): or ws\(s\): URL/,
			)
		})

		it("uses the bound default fetch for SSE when config.fetch is omitted", async () => {
			const previous = globalThis.fetch
			function methodFetch(this: unknown): Promise<Response> {
				if (this !== globalThis) {
					throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
				}
				const encoder = new TextEncoder()
				const stream = new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode("event: message\ndata: hi\n\n"))
						controller.close()
					},
				})
				return Promise.resolve(new Response(stream, { headers: { "content-type": "text/event-stream" }, status: 200 }))
			}
			globalThis.fetch = methodFetch as typeof fetch
			try {
				const client = new HTTPClient({ baseURL: "https://api.example.com" })
				const events = []
				for await (const event of client.requestStream("GET", "/events", {})) {
					events.push(event)
				}
				expect(events).toEqual([{ data: "hi", event: "message" }])
			} finally {
				globalThis.fetch = previous
			}
		})
	})
})
