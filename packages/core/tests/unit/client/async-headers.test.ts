import { describe, expect, it, vi } from "vitest"
import { createClient } from "../../../src/client/index.ts"

function mockFetch(): typeof fetch {
	return vi.fn().mockImplementation(() =>
		Promise.resolve(
			new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		),
	)
}

describe("async headers function", () => {
	it("static headers still work", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: { "x-static": "value" },
			throwOnError: true,
		})

		await api.get("/test")

		const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.headers.get("x-static")).toBe("value")
	})

	it("sync function headers work", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: () => ({ authorization: "Bearer sync-token" }),
			throwOnError: true,
		})

		await api.get("/test")

		const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.headers.get("authorization")).toBe("Bearer sync-token")
	})

	it("async function headers work", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: async () => ({ authorization: "Bearer async-token" }),
			throwOnError: true,
		})

		await api.get("/test")

		const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.headers.get("authorization")).toBe("Bearer async-token")
	})

	it("receives method and path context", async () => {
		const fetchFn = mockFetch()
		const headersFn = vi.fn().mockReturnValue({})
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: headersFn,
			throwOnError: true,
		})

		await api.post("/users/:id", { params: { id: "42" } })

		expect(headersFn).toHaveBeenCalledWith({ method: "POST", path: "/users/:id" })
	})

	it("called on every request (not cached)", async () => {
		const fetchFn = mockFetch()
		let callCount = 0
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: () => {
				callCount++
				return { "x-count": String(callCount) }
			},
			throwOnError: true,
		})

		await api.get("/a")
		await api.get("/b")

		const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
		expect(calls[0][1].headers.get("x-count")).toBe("1")
		expect(calls[1][1].headers.get("x-count")).toBe("2")
	})

	it("per-request headers override dynamic headers", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: () => ({ authorization: "Bearer dynamic", "x-from": "dynamic" }),
			throwOnError: true,
		})

		await api.get("/test", { headers: { authorization: "Bearer override" } })

		const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.headers.get("authorization")).toBe("Bearer override")
		expect(init.headers.get("x-from")).toBe("dynamic")
	})

	it("skips auth for specific paths", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: ({ path }) => {
				if (path.startsWith("/public")) return {}
				return { authorization: "Bearer secret" }
			},
			throwOnError: true,
		})

		await api.get("/public/health")
		await api.get("/users")

		const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls
		expect(calls[0][1].headers.get("authorization")).toBeNull()
		expect(calls[1][1].headers.get("authorization")).toBe("Bearer secret")
	})

	it("works in tuple mode too", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: async () => ({ "x-async": "tuple" }),
		})

		const result = await api.get("/test")
		expect(result.data).toEqual({ ok: true })

		const [, init] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(init.headers.get("x-async")).toBe("tuple")
	})
})
