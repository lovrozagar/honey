import { describe, expect, it, vi } from "vitest"
import { createClient } from "../../../src/client/index.ts"

function mockFetch(body: unknown = { ok: true }, status = 200): typeof fetch {
	return vi.fn().mockImplementation(() =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
				status,
			}),
		),
	)
}

describe("onRequest interceptors", () => {
	it("runs before fetch and can mutate headers", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onRequest: [
				(ctx) => {
					ctx.headers.set("x-injected", "from-interceptor")
				},
			],
			throwOnError: true,
		})

		await api.get("/test")

		const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.headers.get("x-injected")).toBe("from-interceptor")
	})

	it("runs multiple interceptors in order", async () => {
		const order: string[] = []
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onRequest: [
				(ctx) => {
					order.push("first")
					ctx.headers.set("x-first", "1")
				},
				(ctx) => {
					order.push("second")
					ctx.headers.set("x-second", "2")
				},
			],
			throwOnError: true,
		})

		await api.get("/test")

		expect(order).toEqual(["first", "second"])
		const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.headers.get("x-first")).toBe("1")
		expect(init.headers.get("x-second")).toBe("2")
	})

	it("receives method, path, url context", async () => {
		const fetchFn = mockFetch()
		const captured: Record<string, unknown>[] = []
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onRequest: [
				(ctx) => {
					captured.push({ method: ctx.method, path: ctx.path, url: ctx.url })
				},
			],
			throwOnError: true,
		})

		await api.post("/users/:id", { params: { id: "42" } })

		expect(captured[0].method).toBe("POST")
		expect(captured[0].path).toBe("/users/:id")
		expect(captured[0].url).toContain("/users/42")
	})

	it("supports async interceptors", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onRequest: [
				async (ctx) => {
					await new Promise((r) => setTimeout(r, 5))
					ctx.headers.set("x-async", "resolved")
				},
			],
			throwOnError: true,
		})

		await api.get("/test")

		const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.headers.get("x-async")).toBe("resolved")
	})

	it("interceptor errors propagate to caller", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockFetch(),
			onRequest: [
				() => {
					throw new Error("interceptor broke")
				},
			],
			throwOnError: true,
		})

		await expect(api.get("/test")).rejects.toThrow("interceptor broke")
	})

	it("runs after async headers are resolved", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: async () => ({ authorization: "Bearer token" }),
			onRequest: [
				(ctx) => {
					/* should see the resolved auth header */
					ctx.headers.set("x-saw-auth", ctx.headers.get("authorization") ?? "none")
				},
			],
			throwOnError: true,
		})

		await api.get("/test")

		const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.headers.get("x-saw-auth")).toBe("Bearer token")
	})
})

describe("onResponse interceptors", () => {
	it("runs after fetch with response context", async () => {
		const captured: Record<string, unknown>[] = []
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockFetch({ id: "1" }),
			onResponse: [
				(ctx) => {
					captured.push({
						method: ctx.method,
						path: ctx.path,
						status: ctx.response.status,
						url: ctx.url,
					})
					return undefined
				},
			],
			throwOnError: true,
		})

		await api.get("/users")

		expect(captured[0].method).toBe("GET")
		expect(captured[0].path).toBe("/users")
		expect(captured[0].status).toBe(200)
	})

	it("runs multiple interceptors in order", async () => {
		const order: string[] = []
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockFetch(),
			onResponse: [
				() => {
					order.push("first")
					return undefined
				},
				() => {
					order.push("second")
					return undefined
				},
			],
			throwOnError: true,
		})

		await api.get("/test")
		expect(order).toEqual(["first", "second"])
	})

	it("supports async interceptors", async () => {
		const logged: number[] = []
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockFetch(),
			onResponse: [
				async (ctx) => {
					await new Promise((r) => setTimeout(r, 5))
					logged.push(ctx.response.status)
					return undefined
				},
			],
			throwOnError: true,
		})

		await api.get("/test")
		expect(logged).toEqual([200])
	})

	it("ctx.retry() re-executes the request", async () => {
		let callCount = 0
		const fetchFn = vi.fn().mockImplementation(() => {
			callCount++
			if (callCount === 1) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error_key: "unauthorized",
							fields: {},
							message: "expired",
							status: 401,
							status_key: "unauthorized",
						}),
						{ headers: { "content-type": "application/json" }, status: 401 },
					),
				)
			}
			return Promise.resolve(
				new Response(JSON.stringify({ ok: true }), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
			)
		})

		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onResponse: [
				async (ctx) => {
					if (ctx.response.status === 401 && !ctx.isRetry) {
						return ctx.retry()
					}
				},
			],
			throwOnError: true,
		})

		const result = await api.get("/protected")
		expect(result).toEqual({ ok: true })
		expect(callCount).toBe(2)
	})

	it("ctx.isRetry is true on retry", async () => {
		const retryFlags: boolean[] = []
		let callCount = 0
		const fetchFn = vi.fn().mockImplementation(() => {
			callCount++
			if (callCount === 1) {
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error_key: "unauthorized",
							fields: {},
							message: "x",
							status: 401,
							status_key: "unauthorized",
						}),
						{ headers: { "content-type": "application/json" }, status: 401 },
					),
				)
			}
			return Promise.resolve(
				new Response(JSON.stringify({ ok: true }), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
			)
		})

		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onResponse: [
				async (ctx) => {
					retryFlags.push(ctx.isRetry)
					if (ctx.response.status === 401 && !ctx.isRetry) {
						return ctx.retry()
					}
				},
			],
			throwOnError: true,
		})

		await api.get("/test")
		expect(retryFlags).toEqual([false, true])
	})

	it("max 1 retry — second retry throws", async () => {
		const fetchFn = vi.fn().mockImplementation(() =>
			Promise.resolve(
				new Response(
					JSON.stringify({
						error_key: "unauthorized",
						fields: {},
						message: "x",
						status: 401,
						status_key: "unauthorized",
					}),
					{ headers: { "content-type": "application/json" }, status: 401 },
				),
			),
		)

		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onResponse: [
				async (ctx) => {
					if (ctx.response.status === 401) {
						return ctx.retry()
					}
				},
			],
			throwOnError: true,
		})

		await expect(api.get("/test")).rejects.toThrow()
	})

	it("works with tuple mode", async () => {
		const logged: number[] = []
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockFetch({ value: 42 }),
			onResponse: [
				(ctx) => {
					logged.push(ctx.response.status)
					return undefined
				},
			],
		})

		const result = await api.get("/test")
		expect(result.data).toEqual({ value: 42 })
		expect(logged).toEqual([200])
	})

	it("interceptor errors propagate to caller", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockFetch(),
			onResponse: [
				() => {
					throw new Error("response interceptor broke")
				},
			],
			throwOnError: true,
		})

		await expect(api.get("/test")).rejects.toThrow("response interceptor broke")
	})
})

describe("onRequest + onResponse combined", () => {
	it("full flow: onRequest adds header, onResponse logs", async () => {
		const fetchFn = mockFetch()
		const log: string[] = []

		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			onRequest: [
				(ctx) => {
					const id = "corr-123"
					ctx.headers.set("x-correlation-id", id)
					log.push(`req:${id}`)
				},
			],
			onResponse: [
				(ctx) => {
					log.push(`res:${ctx.response.status}`)
					return undefined
				},
			],
			throwOnError: true,
		})

		await api.get("/test")

		expect(log).toEqual(["req:corr-123", "res:200"])
		const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.headers.get("x-correlation-id")).toBe("corr-123")
	})
})
