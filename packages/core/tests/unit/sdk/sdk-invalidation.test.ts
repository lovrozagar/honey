import { describe, expect, it, vi } from "vitest"
import { createSDK } from "../../../src/client/sdk.ts"

type CapturedCtx = {
	invalidatedBy?: string[]
	isStale?: boolean
	selector?: string
}

function mockFetch(status: number, body: unknown) {
	return vi.fn<typeof fetch>(() =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				headers: { "content-type": "application/json" },
				status,
			}),
		),
	) as unknown as typeof fetch
}

/* ---- Test 8: marks collection stale after successful mutation ---- */

describe("marks collection stale after successful mutation", () => {
	it("GET /users isStale after POST /users", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					create: { invalidate: ["GET /users"], method: "POST", path: "/users" },
					list: { method: "GET", path: "/users" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.list()

		expect(captured[1]?.isStale).toBe(true)
	})
})

/* ---- Test 9: instance-level: only stales the mutated resource ---- */

describe("instance-level: only stales the mutated resource", () => {
	it("PATCH /users/2 stales GET /users/2 but not GET /users/3", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					get: { method: "GET", params: ["id"], path: "/users/:id" },
					update: { invalidate: ["GET /users/:id"], method: "PATCH", params: ["id"], path: "/users/:id" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.update({ json: { name: "Bob" }, params: { id: "2" } })
		await sdk.users.get({ params: { id: "2" } })
		await sdk.users.get({ params: { id: "3" } })

		expect(captured[1]?.isStale).toBe(true)
		expect(captured[1]?.selector).toBe("GET /users/2")
		expect(captured[2]?.isStale).toBe(false)
		expect(captured[2]?.selector).toBe("GET /users/3")
	})
})

/* ---- Test 10: instance mutation also stales collection ---- */

describe("instance mutation also stales collection", () => {
	it("PATCH /users/2 stales GET /users/2 and GET /users but not GET /users/3", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					get: { method: "GET", params: ["id"], path: "/users/:id" },
					list: { method: "GET", path: "/users" },
					update: { invalidate: ["GET /users/:id", "GET /users"], method: "PATCH", params: ["id"], path: "/users/:id" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.update({ json: { name: "Bob" }, params: { id: "2" } })
		await sdk.users.get({ params: { id: "2" } })
		await sdk.users.list()
		await sdk.users.get({ params: { id: "3" } })

		expect(captured[1]?.isStale).toBe(true)
		expect(captured[2]?.isStale).toBe(true)
		expect(captured[3]?.isStale).toBe(false)
	})
})

/* ---- Test 11: pattern-level fallback: create stales all instances ---- */

describe("pattern-level fallback: create stales all instances", () => {
	it("POST /users with no params stales all GET /users/:id reads", async () => {
		let callCount = 0
		const fetcher = vi.fn<typeof fetch>(() => {
			callCount++
			/* first call (create) = 200, reads = 500 so one-shot doesn't clear */
			const status = callCount === 1 ? 200 : 500
			return Promise.resolve(
				new Response(JSON.stringify({}), {
					headers: { "content-type": "application/json" },
					status,
				}),
			)
		}) as unknown as typeof fetch

		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					create: { invalidate: ["GET /users/:id"], method: "POST", path: "/users" },
					get: { method: "GET", params: ["id"], path: "/users/:id" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: fetcher,
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.get({ params: { id: "2" } })
		await sdk.users.get({ params: { id: "3" } })

		expect(captured[1]?.isStale).toBe(true)
		expect(captured[2]?.isStale).toBe(true)
	})
})

/* ---- Test 12: one-shot: cleared after successful read ---- */

describe("one-shot: cleared after successful read", () => {
	it("second GET /users is no longer stale", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					create: { invalidate: ["GET /users"], method: "POST", path: "/users" },
					list: { method: "GET", path: "/users" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.list()
		await sdk.users.list()

		expect(captured[1]?.isStale).toBe(true)
		expect(captured[2]?.isStale).toBe(false)
	})
})

/* ---- Test 13: NOT cleared after failed read ---- */

describe("NOT cleared after failed read", () => {
	it("stale persists after 500 response", async () => {
		let callCount = 0
		const fetcher = vi.fn<typeof fetch>(() => {
			callCount++
			const status = callCount === 2 ? 500 : 200
			return Promise.resolve(
				new Response(JSON.stringify(callCount === 2 ? { error: "fail" } : {}), {
					headers: { "content-type": "application/json" },
					status,
				}),
			)
		}) as unknown as typeof fetch

		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					create: { invalidate: ["GET /users"], method: "POST", path: "/users" },
					list: { method: "GET", path: "/users" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: fetcher,
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.list()
		await sdk.users.list()

		expect(captured[1]?.isStale).toBe(true)
		expect(captured[2]?.isStale).toBe(true)
	})
})

/* ---- Test 14: staleTime expiry clears staleness ---- */

describe("staleTime expiry clears staleness", () => {
	it("isStale false after staleTime elapses", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					create: { invalidate: ["GET /users"], method: "POST", path: "/users" },
					list: { method: "GET", path: "/users" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 50 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.create({ json: { name: "Alice" } })
		await new Promise((r) => setTimeout(r, 60))
		await sdk.users.list()

		expect(captured[1]?.isStale).toBe(false)
	})
})

/* ---- Test 15: onRequest receives correct invalidatedBy ---- */

describe("onRequest receives correct invalidatedBy", () => {
	it("invalidatedBy contains the mutation selector", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					create: { invalidate: ["GET /users"], method: "POST", path: "/users" },
					list: { method: "GET", path: "/users" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.list()

		expect(captured[1]?.invalidatedBy).toEqual(["POST /users"])
	})
})

/* ---- Test 16: onResponse receives isStale and invalidatedBy ---- */

describe("onResponse receives isStale and invalidatedBy", () => {
	it("response hook sees isStale true", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					create: { invalidate: ["GET /users"], method: "POST", path: "/users" },
					list: { method: "GET", path: "/users" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 5_000 },
				onResponse: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
						return undefined
					},
				],
			},
		)

		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.list()

		expect(captured[1]?.isStale).toBe(true)
		expect(captured[1]?.invalidatedBy).toEqual(["POST /users"])
	})
})

/* ---- Test 17: selector field uses concrete interpolated path ---- */

describe("selector field uses concrete interpolated path", () => {
	it("selector is GET /users/2 not GET /users/:id", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					get: { method: "GET", params: ["id"], path: "/users/:id" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({ selector: ctx.selector })
					},
				],
			},
		)

		await sdk.users.get({ params: { id: "2" } })

		expect(captured[0]?.selector).toBe("GET /users/2")
	})
})

/* ---- Test 18: multiple mutations accumulate invalidatedBy ---- */

describe("multiple mutations accumulate invalidatedBy", () => {
	it("invalidatedBy contains both mutation selectors", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					create: { invalidate: ["GET /users"], method: "POST", path: "/users" },
					list: { method: "GET", path: "/users" },
					update: { invalidate: ["GET /users"], method: "PATCH", params: ["id"], path: "/users/:id" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.update({ json: { name: "Bob" }, params: { id: "5" } })
		await sdk.users.list()

		expect(captured[2]?.invalidatedBy).toContain("POST /users")
		expect(captured[2]?.invalidatedBy).toContain("PATCH /users/5")
	})
})

/* ---- Test 19: no overhead when invalidation not configured ---- */

describe("no overhead when invalidation not configured", () => {
	it("onRequest context does not have invalidation fields", async () => {
		const captured: Record<string, unknown>[] = []
		const sdk = createSDK(
			{
				users: {
					list: { method: "GET", path: "/users" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				onRequest: [
					(ctx) => {
						captured.push({ ...ctx })
					},
				],
			},
		)

		await sdk.users.list()

		expect(captured[0]?.isStale).toBeUndefined()
		expect(captured[0]?.invalidatedBy).toBeUndefined()
		expect(captured[0]?.selector).toBeUndefined()
	})
})

/* ---- Test 20: mutation failure does not mark targets stale ---- */

describe("mutation failure does not mark targets stale", () => {
	it("GET /users not stale after failed POST /users", async () => {
		let callCount = 0
		const fetcher = vi.fn<typeof fetch>(() => {
			callCount++
			const status = callCount === 1 ? 500 : 200
			return Promise.resolve(
				new Response(JSON.stringify(callCount === 1 ? { error: "fail" } : {}), {
					headers: { "content-type": "application/json" },
					status,
				}),
			)
		}) as unknown as typeof fetch

		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					create: { invalidate: ["GET /users"], method: "POST", path: "/users" },
					list: { method: "GET", path: "/users" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: fetcher,
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.list()

		expect(captured[1]?.isStale).toBe(false)
	})
})

/* ---- Test 21: isStale false for non-stale reads ---- */

describe("isStale false for non-stale reads", () => {
	it("no mutations happened, isStale false", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					list: { method: "GET", path: "/users" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.list()

		expect(captured[0]?.isStale).toBe(false)
		expect(captured[0]?.invalidatedBy).toEqual([])
	})
})

/* ---- Test 22: pattern-level one-shot clears for all instances ---- */

describe("pattern-level one-shot clears for all instances", () => {
	it("first stale read clears pattern entry", async () => {
		const captured: CapturedCtx[] = []
		const sdk = createSDK(
			{
				users: {
					create: { invalidate: ["GET /users/:id"], method: "POST", path: "/users" },
					get: { method: "GET", params: ["id"], path: "/users/:id" },
				},
			},
			{
				baseURL: "http://localhost",
				fetch: mockFetch(200, {}),
				invalidation: { staleTime: 5_000 },
				onRequest: [
					(ctx) => {
						captured.push({
							invalidatedBy: ctx.invalidatedBy,
							isStale: ctx.isStale,
							selector: ctx.selector,
						})
					},
				],
			},
		)

		await sdk.users.create({ json: { name: "Alice" } })
		await sdk.users.get({ params: { id: "2" } })
		await sdk.users.get({ params: { id: "3" } })

		expect(captured[1]?.isStale).toBe(true)
		expect(captured[2]?.isStale).toBe(false)
	})
})
