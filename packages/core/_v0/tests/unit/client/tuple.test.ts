import { describe, expect, it, vi } from "vitest"
import { ClientError } from "../../../src/client/error.ts"
import { createClient } from "../../../src/client/index.ts"

function mockJsonFetch(body: unknown, status = 200): typeof fetch {
	return vi.fn().mockImplementation(() =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
				status,
			}),
		),
	)
}

function mockErrorFetch(errorKey: string, status: number): typeof fetch {
	return vi.fn().mockImplementation(() =>
		Promise.resolve(
			new Response(
				JSON.stringify({
					error_key: errorKey,
					fields: {},
					message: errorKey,
					status,
					status_key: errorKey,
				}),
				{ headers: { "content-type": "application/json" }, status },
			),
		),
	)
}

describe("tuple mode (throwOnError: false — default)", () => {
	it("2xx returns { data, error: null, response, status }", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockJsonFetch({ id: "1", name: "Alice" }),
		})

		const result = await api.get("/users")
		expect(result).toHaveProperty("data")
		expect(result).toHaveProperty("error")
		expect(result).toHaveProperty("response")
		expect(result).toHaveProperty("status")
		expect(result.data).toEqual({ id: "1", name: "Alice" })
		expect(result.error).toBeNull()
		expect(result.status).toBe(200)
		expect(result.response).toBeInstanceOf(Response)
	})

	it("4xx returns { data: null, error: parsed body }", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockErrorFetch("not_found", 404),
		})

		const result = await api.get("/missing")
		expect(result.data).toBeNull()
		expect((result.error as Record<string, unknown>)?.error_key).toBe("not_found")
		expect(result.status).toBe(404)
		expect(result.response).toBeInstanceOf(Response)
	})

	it("5xx returns { data: null, error: parsed body }", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockErrorFetch("internal_server_error", 500),
		})

		const result = await api.post("/crash", { json: {} })
		expect(result.data).toBeNull()
		expect(result.error).not.toBeNull()
		expect(result.status).toBe(500)
	})

	it("204 returns { data: null, error: null, status: 204 }", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 204 }))),
		})

		const result = await api.delete("/items/1")
		expect(result.data).toBeNull()
		expect(result.error).toBeNull()
		expect(result.status).toBe(204)
	})

	it("network error still throws (no Response to wrap)", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: vi.fn().mockRejectedValue(new TypeError("fetch failed")),
		})

		await expect(api.get("/down")).rejects.toThrow(TypeError)
	})

	it("timeout still throws", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: vi.fn().mockImplementation(
				(_url: string, init: RequestInit) =>
					new Promise((_resolve, reject) => {
						if (init.signal) {
							init.signal.addEventListener("abort", () => reject(init.signal?.reason))
						}
					}),
			),
			timeout: 50,
		})

		await expect(api.get("/slow")).rejects.toThrow()
	})

	it("error.response body is readable in tuple mode", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockErrorFetch("forbidden", 403),
		})

		const result = await api.get("/secret")
		expect(result.error).not.toBeNull()
		const body = (await result.response.json()) as Record<string, unknown>
		expect(body.error_key).toBe("forbidden")
	})

	it("multiple sequential calls work independently", async () => {
		let callCount = 0
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: vi.fn().mockImplementation(() => {
				callCount++
				if (callCount === 1) {
					return Promise.resolve(
						new Response(JSON.stringify({ ok: true }), {
							headers: { "content-type": "application/json" },
							status: 200,
						}),
					)
				}
				return Promise.resolve(
					new Response(
						JSON.stringify({
							error_key: "not_found",
							fields: {},
							message: "nope",
							status: 404,
							status_key: "not_found",
						}),
						{ headers: { "content-type": "application/json" }, status: 404 },
					),
				)
			}),
		})

		const r1 = await api.get("/a")
		const r2 = await api.get("/b")
		expect(r1.data).toEqual({ ok: true })
		expect(r1.error).toBeNull()
		expect(r2.data).toBeNull()
		expect(r2.error).not.toBeNull()
	})
})

describe("throw mode (throwOnError: true)", () => {
	it("2xx returns data directly", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockJsonFetch({ id: "1" }),
			throwOnError: true,
		})

		const data = await api.get("/users")
		expect(data).toEqual({ id: "1" })
	})

	it("4xx throws ClientError", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockErrorFetch("not_found", 404),
			throwOnError: true,
		})

		try {
			await api.get("/missing")
			expect.fail("should have thrown")
		} catch (e) {
			expect(e).toBeInstanceOf(ClientError)
			expect((e as ClientError).status).toBe(404)
		}
	})

	it("204 returns null directly", async () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: vi.fn().mockImplementation(() => Promise.resolve(new Response(null, { status: 204 }))),
			throwOnError: true,
		})

		const data = await api.delete("/items/1")
		expect(data).toBeNull()
	})
})
