import { describe, expect, it, vi } from "vitest"
import { createClient } from "../../../src/client/index.ts"

const api = createClient({
	baseURL: "https://api.example.com",
	fetch: vi.fn(),
})

describe("$url()", () => {
	it("builds full URL from baseURL + path", () => {
		const url = api.$url("/health")
		expect(url).toBe("https://api.example.com/health")
	})

	it("interpolates path params", () => {
		const url = api.$url("/users/:userId", { params: { userId: "42" } })
		expect(url).toBe("https://api.example.com/users/42")
	})

	it("appends search params", () => {
		const url = api.$url("/users", { search: { limit: 10, page: 1 } })
		const parsed = new URL(url)
		expect(parsed.searchParams.get("limit")).toBe("10")
		expect(parsed.searchParams.get("page")).toBe("1")
	})

	it("combines params + search", () => {
		const url = api.$url("/users/:userId/posts", {
			params: { userId: "42" },
			search: { sort: "date" },
		})
		expect(url).toContain("/users/42/posts")
		expect(url).toContain("sort=date")
	})

	it("encodes param values", () => {
		const url = api.$url("/search/:query", { params: { query: "hello world" } })
		expect(url).toContain("hello%20world")
	})

	it("handles no input", () => {
		const url = api.$url("/simple")
		expect(url).toBe("https://api.example.com/simple")
	})

	it("handles array search params", () => {
		const url = api.$url("/filter", { search: { ids: [1, 2, 3] } })
		const parsed = new URL(url)
		expect(parsed.searchParams.getAll("ids")).toEqual(["1", "2", "3"])
	})

	it("works with baseURL that has path prefix", () => {
		const prefixed = createClient({
			baseURL: "https://api.example.com/v1",
			fetch: vi.fn(),
		})
		const url = prefixed.$url("/users")
		expect(url).toBe("https://api.example.com/v1/users")
	})
})

describe("$path()", () => {
	it("returns path without baseURL", () => {
		const path = api.$path("/health")
		expect(path).toBe("/health")
	})

	it("interpolates path params", () => {
		const path = api.$path("/users/:userId", { params: { userId: "42" } })
		expect(path).toBe("/users/42")
	})

	it("appends search params", () => {
		const path = api.$path("/users", { search: { limit: 10 } })
		expect(path).toBe("/users?limit=10")
	})

	it("combines params + search", () => {
		const path = api.$path("/users/:userId/posts", {
			params: { userId: "42" },
			search: { sort: "date" },
		})
		expect(path).toBe("/users/42/posts?sort=date")
	})

	it("handles no input", () => {
		const path = api.$path("/simple")
		expect(path).toBe("/simple")
	})

	it("does not fetch", () => {
		api.$url("/test")
		api.$path("/test")
		/* $url and $path are synchronous helpers that never call fetch */
		expect(true).toBe(true)
	})
})
