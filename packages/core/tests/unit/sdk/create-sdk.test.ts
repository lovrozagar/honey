import { describe, expect, it, vi } from "vitest"
import { createSDK } from "../../../src/client/sdk.ts"

type SDKResult = { data: unknown; error: unknown; response: Response; status: number }

/* mock fetch for testing */
function mockFetch(status: number, body: unknown) {
	return vi.fn(() =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
				status,
			}),
		),
	) as unknown as typeof fetch
}

describe("createSDK", () => {
	it("calls correct method and path for service.action", async () => {
		const fetcher = mockFetch(200, [{ id: "1", name: "Alice" }])
		const sdk = createSDK(
			{
				users: {
					list: { method: "GET", path: "/users" },
				},
			},
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		const result = (await sdk.users.list()) as SDKResult
		const mock = fetcher as unknown as ReturnType<typeof vi.fn>
		expect(mock).toHaveBeenCalledOnce()
		const call = mock.mock.calls[0] as unknown[]
		expect(call[0]).toContain("/users")
		expect((call[1] as Record<string, unknown>).method).toBe("GET")
		expect(result.data).toEqual([{ id: "1", name: "Alice" }])
		expect(result.error).toBeNull()
	})

	it("interpolates path params", async () => {
		const fetcher = mockFetch(200, { id: "42", name: "Widget" })
		const sdk = createSDK(
			{
				items: {
					get: { method: "GET", params: ["id"], path: "/items/:id" },
				},
			},
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.items.get({ params: { id: "42" } })
		const mock = fetcher as unknown as ReturnType<typeof vi.fn>
		const url = (mock.mock.calls[0] as unknown[])[0]
		expect(url).toContain("/items/42")
		expect(url).not.toContain(":id")
	})

	it("sends JSON body on POST", async () => {
		const fetcher = mockFetch(201, { id: "new" })
		const sdk = createSDK(
			{
				users: {
					create: { method: "POST", path: "/users" },
				},
			},
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.users.create({ json: { email: "a@b.com", name: "Alice" } })
		const mock = fetcher as unknown as ReturnType<typeof vi.fn>
		const opts = (mock.mock.calls[0] as unknown[])[1] as Record<string, unknown>
		expect(opts.method).toBe("POST")
		expect((opts.headers as Headers).get("content-type")).toContain("application/json")
		const body = JSON.parse(opts.body as string) as Record<string, unknown>
		expect(body.name).toBe("Alice")
	})

	it("sends search params as query string", async () => {
		const fetcher = mockFetch(200, [])
		const sdk = createSDK(
			{
				items: {
					list: { method: "GET", path: "/items" },
				},
			},
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.items.list({ search: { limit: 10, page: 2 } })
		const mock = fetcher as unknown as ReturnType<typeof vi.fn>
		const url = (mock.mock.calls[0] as unknown[])[0]
		expect(url).toContain("limit=10")
		expect(url).toContain("page=2")
	})

	it("multiple resources accessible on same sdk instance", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{
				items: { list: { method: "GET", path: "/items" } },
				users: { list: { method: "GET", path: "/users" } },
			},
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.users.list()
		await sdk.items.list()
		const mock = fetcher as unknown as ReturnType<typeof vi.fn>
		expect(mock).toHaveBeenCalledTimes(2)
		expect((mock.mock.calls[0] as unknown[])[0]).toContain("/users")
		expect((mock.mock.calls[1] as unknown[])[0]).toContain("/items")
	})

	it("passes custom headers from config", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://localhost",
				fetch: fetcher,
				headers: { authorization: "Bearer tok-123" },
			},
		)

		await sdk.users.list()
		const mock = fetcher as unknown as ReturnType<typeof vi.fn>
		const opts = (mock.mock.calls[0] as unknown[])[1] as Record<string, unknown>
		expect((opts.headers as Headers).get("authorization")).toBe("Bearer tok-123")
	})

	it("handles error responses", async () => {
		const fetcher = mockFetch(404, { error_key: "not_found" })
		const sdk = createSDK(
			{ users: { get: { method: "GET", params: ["id"], path: "/users/:id" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		const result = (await sdk.users.get({ params: { id: "999" } })) as SDKResult
		expect(result.data).toBeNull()
		expect(result.error).not.toBeNull()
		expect((result.error as Record<string, unknown>)?.error_key).toBe("not_found")
		expect(result.status).toBe(404)
	})

	it("nested params from multiple path segments", async () => {
		const fetcher = mockFetch(200, [])
		const sdk = createSDK(
			{
				exports: {
					list: {
						method: "GET",
						params: ["orgId", "projectId"],
						path: "/orgs/:orgId/projects/:projectId/exports",
					},
				},
			},
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.exports.list({ params: { orgId: "o1", projectId: "p1" } })
		const mock = fetcher as unknown as ReturnType<typeof vi.fn>
		const url = (mock.mock.calls[0] as unknown[])[0]
		expect(url).toContain("/orgs/o1/projects/p1/exports")
	})

	it("accessing non-existent resource → undefined", () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://localhost" },
		)

		expect((sdk as Record<string, unknown>).nonexistent).toBeUndefined()
	})

	it("accessing non-existent action → undefined", () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://localhost" },
		)

		expect((sdk.users as Record<string, unknown>).nonexistent).toBeUndefined()
	})
})
