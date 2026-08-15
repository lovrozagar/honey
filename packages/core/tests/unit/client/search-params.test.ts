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

describe("sortSearchParams", () => {
	it("sorts query params alphabetically by key", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			sortSearchParams: true,
			throwOnError: true,
		})

		await api.get("/test", { search: { a: "first", m: "middle", z: "last" } })

		const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		const qs = new URL(url).search
		expect(qs).toBe("?a=first&m=middle&z=last")
	})

	it("sorts with $url() too", () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockFetch(),
			sortSearchParams: true,
		})

		const url = api.$url("/test", { search: { a: "1", m: "2", z: "3" } })
		const qs = new URL(url).search
		expect(qs).toBe("?a=1&m=2&z=3")
	})

	it("sorts with $path() too", () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: mockFetch(),
			sortSearchParams: true,
		})

		const path = api.$path("/test", { search: { a: "1", z: "3" } })
		expect(path).toBe("/test?a=1&z=3")
	})

	it("disabled by default — no forced sort", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		/* build object with known insertion order — biome sorts literals */
		const search: Record<string, unknown> = {}
		search.z = "last"
		search.a = "first"
		await api.get("/test", { search })

		const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		const qs = new URL(url).search
		expect(qs).toBe("?z=last&a=first")
	})
})

describe("buildSearchParams (custom serializer)", () => {
	it("uses custom serializer for bracket notation", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			buildSearchParams: (query) => {
				const params = new URLSearchParams()
				for (const [k, v] of Object.entries(query)) {
					if (Array.isArray(v)) {
						for (const item of v) params.append(`${k}[]`, String(item))
					} else if (v !== undefined && v !== null) {
						params.set(k, String(v))
					}
				}
				return params
			},
			fetch: fetchFn,
			throwOnError: true,
		})

		await api.get("/test", { search: { ids: [1, 2, 3], name: "x" } })

		const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		const parsed = new URL(url)
		expect(parsed.searchParams.getAll("ids[]")).toEqual(["1", "2", "3"])
		expect(parsed.searchParams.get("name")).toBe("x")
	})

	it("sort applies after custom serializer", async () => {
		const fetchFn = mockFetch()
		const api = createClient({
			baseURL: "https://api.test.com",
			buildSearchParams: (query) => {
				const params = new URLSearchParams()
				for (const [k, v] of Object.entries(query)) {
					if (v !== undefined && v !== null) params.set(k, String(v))
				}
				return params
			},
			fetch: fetchFn,
			sortSearchParams: true,
			throwOnError: true,
		})

		await api.get("/test", { search: { a: "1", z: "3" } })

		const [url] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(new URL(url).search).toBe("?a=1&z=3")
	})

	it("custom serializer works with $url()", () => {
		const api = createClient({
			baseURL: "https://api.test.com",
			buildSearchParams: (query) => {
				const params = new URLSearchParams()
				for (const [k, v] of Object.entries(query)) {
					if (v !== undefined && v !== null) params.set(k, String(v).toUpperCase())
				}
				return params
			},
			fetch: mockFetch(),
		})

		const url = api.$url("/test", { search: { name: "alice" } })
		expect(new URL(url).searchParams.get("name")).toBe("ALICE")
	})
})
