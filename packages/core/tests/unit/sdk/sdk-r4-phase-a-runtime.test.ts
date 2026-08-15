import { describe, expect, it, vi } from "vitest"
import { createSDK } from "../../../src/client/sdk.ts"

/* ── helpers ── */

function mockFetch204() {
	return vi.fn<typeof fetch>(() =>
		Promise.resolve(new Response(null, { status: 204 })),
	) as unknown as typeof fetch
}

/**
 * Returns a fetch mock that cycles through the provided responses in order.
 * Each entry is [status, body, contentType].
 */
function mockFetchSequence(
	responses: Array<[number, string | null, string]>,
): typeof fetch {
	let call = 0
	return vi.fn<typeof fetch>(() => {
		const entry = responses[call] ?? responses[responses.length - 1]
		call++
		const [status, body, contentType] = entry
		return Promise.resolve(
			new Response(body, {
				headers: contentType ? { "content-type": contentType } : {},
				status,
			}),
		)
	}) as unknown as typeof fetch
}

/* service map for #2 tests: POST mutation invalidates GET /v1/users */
const invalidationServiceMap = {
	users: {
		create: {
			invalidate: ["GET /v1/users"] as string[],
			method: "POST",
			path: "/v1/users",
		},
		list: {
			method: "GET",
			path: "/v1/users",
		},
	},
}

/* ═══════════════════════════════════════════════════════════════════
   #2 — 204 invalidation — runtime behavior via createSDK
   Bug: r.data !== null fails when data is null (204 returns null data)
   Fix: r.error === null correctly identifies success on 204 responses
   ═══════════════════════════════════════════════════════════════════ */

describe("#2 204 invalidation — runtime: stale marking fires on 204 mutation", () => {
	type TestSDK = {
		users: {
			create: (input: { json: Record<string, unknown> }) => Promise<{
				data: null
				error: null
				response: Response
				status: number
			}>
			list: () => Promise<{ data: unknown; error: null; response: Response; status: number }>
		}
	}

	it("204 mutation marks GET /v1/users as stale (isStale: true on next GET)", async () => {
		/*
		 * staleUntil is per-SDK-instance — both calls must share the same instance
		 * so the stale mark from the POST is visible when the GET runs.
		 */
		const singleInstanceCtx: Array<Record<string, unknown>> = []
		const fetcher = mockFetchSequence([
			[204, null, ""],
			[200, JSON.stringify([{ id: 1 }]), "application/json"],
		])

		const sdk = createSDK<TestSDK>(invalidationServiceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => {
				singleInstanceCtx.push({ ...ctx })
			}],
		})

		/* first call: POST mutation → 204 */
		await sdk.users.create({ json: { name: "Alice" } })

		/* second call: GET → should see isStale: true */
		await sdk.users.list()

		/* the GET's onRequest context must have isStale: true */
		const getCtx = singleInstanceCtx.find((ctx) => ctx.method === "GET")
		expect(getCtx).toBeDefined()
		expect(getCtx?.isStale).toBe(true)
	})

	it("204 mutation marks GET /v1/users stale — invalidatedBy is non-empty on next GET", async () => {
		const singleInstanceCtx: Array<Record<string, unknown>> = []
		const fetcher = mockFetchSequence([
			[204, null, ""],
			[200, JSON.stringify([]), "application/json"],
		])

		const sdk = createSDK<TestSDK>(invalidationServiceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => {
				singleInstanceCtx.push({ ...ctx })
			}],
		})

		await sdk.users.create({ json: { name: "Bob" } })
		await sdk.users.list()

		const getCtx = singleInstanceCtx.find((ctx) => ctx.method === "GET")
		expect(getCtx).toBeDefined()
		const invalidatedBy = getCtx?.invalidatedBy as string[] | undefined
		expect(Array.isArray(invalidatedBy)).toBe(true)
		expect((invalidatedBy ?? []).length).toBeGreaterThan(0)
	})

	it("204 mutation result has data: null and error: null (204 is a success, not an error)", async () => {
		/*
		 * Locks the correct parse behavior of 204:
		 * data === null AND error === null — both are null, meaning it IS a success.
		 * The bug was (result).data !== null evaluated to false for 204,
		 * so #markStale was never called.
		 */
		const sdk = createSDK<TestSDK>(invalidationServiceMap, {
			baseURL: "http://api.example.com",
			fetch: mockFetch204(),
			invalidation: { staleTime: 60_000 },
		})

		const result = await sdk.users.create({ json: { name: "Test" } })

		/* 204: both data and error are null — this IS a success, not an error */
		expect(result.data).toBeNull()
		expect(result.error).toBeNull()
		expect(result.status).toBe(204)
	})
})
