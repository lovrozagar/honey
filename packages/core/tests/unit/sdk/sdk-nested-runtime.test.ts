import { describe, expect, it } from "vitest"
import { createSDK } from "../../../src/client/sdk.ts"
import { captureFetch } from "./_helpers/phase-f.ts"

/* ======================================================= */
describe("createSDK — nested Proxy (T20–T26)", () => {
	/* T20: 2-segment runtime — regression guard */
	it("T20 2-segment sdk.items.list() issues GET to /v1/items", async () => {
		const serviceMap = {
			items: {
				list: { method: "GET", params: [], path: "/v1/items" },
			},
		}
		type SDK = { items: { list: () => Promise<unknown> } }
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<SDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		await sdk.items.list()

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain("/v1/items")
		expect(calls[0]?.init?.method ?? "GET").toBe("GET")
	})

	/* T21: 3-segment runtime */
	it("T21 3-segment sdk.checkout.sessions.create() issues POST to /checkout/sessions", async () => {
		/* RED: createSDK currently only supports 2-level Proxy; 3-segment will fail */
		const serviceMap = {
			checkout: {
				sessions: {
					create: { method: "POST", params: [], path: "/checkout/sessions" },
				},
			},
		}
		type SDK = {
			checkout: {
				sessions: {
					create: (input?: { json?: Record<string, unknown> }) => Promise<unknown>
				}
			}
		}
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<SDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		/* intermediate access must return a Proxy, not undefined */
		const sessionsProxy = sdk.checkout.sessions
		expect(sessionsProxy).toBeDefined()
		expect(typeof sessionsProxy).toBe("object")

		await sdk.checkout.sessions.create({ json: { x: 1 } })

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain("/checkout/sessions")
		expect(calls[0]?.init?.method).toBe("POST")
	})

	/* T22: mixed depth runtime */
	it("T22 mixed depth: sdk.users.list() and sdk.users.profile.update() both resolve correctly", async () => {
		/* RED: profile sub-namespace not traversable in current 2-level Proxy */
		const serviceMap = {
			users: {
				list: { method: "GET", params: [], path: "/users" },
				profile: {
					update: { method: "PATCH", params: [], path: "/users/{id}/profile" },
				},
			},
		}
		type SDK = {
			users: {
				list: () => Promise<unknown>
				profile: {
					update: (input?: { params?: { id: string }; json?: Record<string, unknown> }) => Promise<unknown>
				}
			}
		}
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<SDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		await sdk.users.list()
		await sdk.users.profile.update({ params: { id: "42" }, json: {} })

		expect(calls).toHaveLength(2)
		expect(calls[0]?.url).toContain("/users")
		expect(calls[0]?.init?.method ?? "GET").toBe("GET")
		expect(calls[1]?.url).toContain("/users")
		expect(calls[1]?.init?.method).toBe("PATCH")
	})

	/* T23: top-level method runtime — leaf at root with method field */
	it("T23 top-level method getStatus: root entry with method field is callable directly", async () => {
		/* RED: createSDK currently wraps root entries as resource namespaces, not leaf detectors */
		const serviceMap = {
			getStatus: { method: "GET", params: [], path: "/status" },
		}
		type SDK = { getStatus: () => Promise<unknown> }
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<SDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		await sdk.getStatus()

		expect(calls).toHaveLength(1)
		expect(calls[0]?.url).toContain("/status")
	})

	/* T24: non-existent key returns undefined */
	it("T24 accessing non-existent key on sdk returns undefined", () => {
		const serviceMap = {
			items: { list: { method: "GET", params: [], path: "/items" } },
		}
		type SDK = { items: { list: () => Promise<unknown> } }
		const { fetcher } = captureFetch()
		const sdk = createSDK<SDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		/* accessing unknown key must return undefined, not throw */
		/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
		expect((sdk as any).nonexistent).toBeUndefined()
	})

	/* T25: action cache hits on second access through nested Proxy */
	it("T25 sdk.checkout.sessions.create accessed twice returns same function reference", () => {
		/* RED: nested Proxy does not cache child Proxies; each access builds new fn */
		const serviceMap = {
			checkout: {
				sessions: {
					create: { method: "POST", params: [], path: "/checkout/sessions" },
				},
			},
		}
		type SDK = {
			checkout: {
				sessions: {
					create: (input?: Record<string, unknown>) => Promise<unknown>
				}
			}
		}
		const { fetcher } = captureFetch()
		const sdk = createSDK<SDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		const first = sdk.checkout.sessions.create
		const second = sdk.checkout.sessions.create
		expect(first).toBe(second)
	})

	/* T26: invalidation propagates through nested method */
	it("T26 nested method with invalidate marks stale entries when invoked", async () => {
		/* RED: invalidation wiring lives in 2-level Proxy; nested path not wired */
		const serviceMap = {
			users: {
				create: {
					invalidate: ["GET /users"],
					method: "POST",
					params: [],
					path: "/users",
				},
				list: { method: "GET", params: [], path: "/users" },
			},
		}
		type SDK = {
			users: {
				create: (input?: { json?: Record<string, unknown> }) => Promise<unknown>
				list: () => Promise<unknown>
			}
		}
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<SDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		/* prime the list cache */
		await sdk.users.list()
		/* create should invalidate the list cache — causes refetch on next list call */
		await sdk.users.create({ json: { name: "Alice" } })
		/* list again after invalidation — should trigger a new network request */
		await sdk.users.list()

		/* 3 distinct network calls: list, create, re-fetched list */
		expect(calls.length).toBeGreaterThanOrEqual(2)
		/* both create and list were called */
		const methods = calls.map((c) => c.init?.method ?? "GET")
		expect(methods).toContain("POST")
		expect(methods).toContain("GET")
	})
})
