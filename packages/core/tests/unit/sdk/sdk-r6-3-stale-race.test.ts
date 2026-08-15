import { describe, expect, it } from "vitest"
import { createSDK } from "../../../src/client/sdk.ts"
import { deferredFetch, tick } from "./_helpers/phase-f.ts"

const PHASE_F_FIXED = process.env["PHASE_F_FIXED"] === "1"

/* service map fixture from the spec — posts before users (sort-keys) */
const serviceMap = {
	posts: {
		get: { method: "GET", params: ["id"], path: "/v1/posts/:id" },
		update: {
			invalidate: ["GET /v1/posts/:id"],
			method: "PATCH",
			params: ["id"],
			path: "/v1/posts/:id",
		},
	},
	users: {
		get: { method: "GET", params: ["id"], path: "/v1/users/:id" },
		update: {
			invalidate: ["GET /v1/users/:id"],
			method: "PATCH",
			params: ["id"],
			path: "/v1/users/:id",
		},
	},
}

type UserSDK = {
	users: {
		get: (input: { params: { id: string } }) => Promise<{ data: unknown; error: unknown; response: Response; status: number }>
		update: (input: { json?: unknown; params: { id: string } }) => Promise<{ data: unknown; error: unknown; response: Response; status: number }>
	}
	posts: {
		get: (input: { params: { id: string } }) => Promise<{ data: unknown; error: unknown; response: Response; status: number }>
		update: (input: { json?: unknown; params: { id: string } }) => Promise<{ data: unknown; error: unknown; response: Response; status: number }>
	}
}

function jsonOk(body: unknown = {}) {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status: 200,
	})
}

/*
 * Resolve a deferred call by index.
 * IMPORTANT: always call `await tick()` after starting an SDK call and before
 * calling resolveCall — the SDK invokes fetch inside an async function, so the
 * fetch invocation is a microtask that must be flushed first.
 */
function resolveCall(
	calls: Array<{ resolve: (r: Response) => void }>,
	idx: number,
	r: Response,
): void {
	const call = calls[idx]
	if (!call) throw new Error(`deferredFetch: no call at index ${idx} (have ${calls.length})`)
	call.resolve(r)
}

/* ═══════════════════════════════════════════════════════════════════
   #R6-3 — Layer A invariants (always GREEN before and after fix)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-3 stale race — Layer A invariants", () => {
	it("sequential read-then-mutation: GET after PATCH sees isStale: true", async () => {
		const captured: Array<{ isStale?: boolean; method: string }> = []
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<UserSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => { captured.push({ isStale: ctx.isStale, method: ctx.method }) }],
		})

		const getPromise = sdk.users.get({ params: { id: "1" } })
		await tick()
		resolveCall(calls, 0, jsonOk({ id: "1" }))
		await getPromise

		const patchPromise = sdk.users.update({ json: { name: "Alice" }, params: { id: "1" } })
		await tick()
		resolveCall(calls, 1, jsonOk({}))
		await patchPromise

		const get2Promise = sdk.users.get({ params: { id: "1" } })
		await tick()
		resolveCall(calls, 2, jsonOk({ id: "1" }))
		await get2Promise

		const getContexts = captured.filter((c) => c.method === "GET")
		expect(getContexts[0]?.isStale).toBeFalsy()
		expect(getContexts[1]?.isStale).toBe(true)
	})

	it("sequential mutation-then-read: GET after PATCH sees isStale: true", async () => {
		const captured: Array<{ isStale?: boolean; method: string }> = []
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<UserSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => { captured.push({ isStale: ctx.isStale, method: ctx.method }) }],
		})

		const patchPromise = sdk.users.update({ json: {}, params: { id: "2" } })
		await tick()
		resolveCall(calls, 0, jsonOk({}))
		await patchPromise

		const getPromise = sdk.users.get({ params: { id: "2" } })
		await tick()
		resolveCall(calls, 1, jsonOk({}))
		await getPromise

		const getCtx = captured.find((c) => c.method === "GET")
		expect(getCtx?.isStale).toBe(true)
	})

	it("two mutations on different resources do not cross-invalidate", async () => {
		const captured: Array<{ isStale?: boolean; method: string; selector?: string }> = []
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<UserSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => {
				captured.push({ isStale: ctx.isStale, method: ctx.method, selector: ctx.selector })
			}],
		})

		const p1 = sdk.users.update({ json: {}, params: { id: "1" } })
		await tick()
		resolveCall(calls, 0, jsonOk({}))
		await p1

		const p2 = sdk.posts.update({ json: {}, params: { id: "1" } })
		await tick()
		resolveCall(calls, 1, jsonOk({}))
		await p2

		const getUsers = sdk.users.get({ params: { id: "1" } })
		await tick()
		resolveCall(calls, 2, jsonOk({}))
		await getUsers

		const getPosts = sdk.posts.get({ params: { id: "1" } })
		await tick()
		resolveCall(calls, 3, jsonOk({}))
		await getPosts

		const usersGetCtx = captured.find((c) => c.method === "GET" && c.selector?.includes("users"))
		const postsGetCtx = captured.find((c) => c.method === "GET" && c.selector?.includes("posts"))
		expect(usersGetCtx?.isStale).toBe(true)
		expect(postsGetCtx?.isStale).toBe(true)
	})

	it("after a read completes with isStale: true, a subsequent read sees isStale: false", async () => {
		const captured: Array<{ isStale?: boolean; method: string }> = []
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<UserSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => { captured.push({ isStale: ctx.isStale, method: ctx.method }) }],
		})

		const p1 = sdk.users.update({ json: {}, params: { id: "3" } })
		await tick()
		resolveCall(calls, 0, jsonOk({}))
		await p1

		const get1 = sdk.users.get({ params: { id: "3" } })
		await tick()
		resolveCall(calls, 1, jsonOk({}))
		await get1

		const get2 = sdk.users.get({ params: { id: "3" } })
		await tick()
		resolveCall(calls, 2, jsonOk({}))
		await get2

		const getContexts = captured.filter((c) => c.method === "GET")
		expect(getContexts[0]?.isStale).toBe(true)
		expect(getContexts[1]?.isStale).toBeFalsy()
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-3 — Layer B bug witness (runs when PHASE_F_FIXED is unset)
   Documents the snapshot/mark race and the parse-error invalidation gap.
   ═══════════════════════════════════════════════════════════════════ */

describe.skipIf(PHASE_F_FIXED)("#R6-3 — Layer B bug witness (pre-fix)", () => {
	it("lost-invalidation scenario: R fires before M marks stale — R's onRequest sees isStale: false", async () => {
		/*
		 * Deterministic interleaving:
		 * 1. R (GET) starts → tick so fetch is called → calls[0] pending, onRequest fires with isStale: false
		 * 2. M (PATCH) starts → tick so fetch is called → calls[1] pending
		 * 3. Resolve M first → marks stale
		 * 4. Resolve R → R's requestMeta was captured pre-M so isStale was false,
		 *    therefore clearStale is not called — M's mark correctly survives.
		 */
		const captured: Array<{ isStale?: boolean; method: string }> = []
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<UserSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => { captured.push({ isStale: ctx.isStale, method: ctx.method }) }],
		})

		const rPromise = sdk.users.get({ params: { id: "4" } })
		await tick()
		const mPromise = sdk.users.update({ json: {}, params: { id: "4" } })
		await tick()

		resolveCall(calls, 1, jsonOk({}))
		await mPromise

		resolveCall(calls, 0, jsonOk({}))
		await rPromise

		const rCtx = captured.find((c) => c.method === "GET")
		expect(rCtx?.isStale).toBe(false)

		const get3 = sdk.users.get({ params: { id: "4" } })
		await tick()
		resolveCall(calls, 2, jsonOk({}))
		await get3

		const thirdGetCtx = captured.filter((c) => c.method === "GET")[1]
		expect(thirdGetCtx?.isStale).toBe(true)
	})

	it("wiped-mutation scenario: R's clearStale runs without seqSnapshot and deletes M1's entry (CORRUPTION)", async () => {
		/*
		 * 1. M0 mutates users/5 → marks stale
		 * 2. R (GET users/5) starts → snapshots isStale:true from M0 (calls[1] pending)
		 * 3. M1 (PATCH users/5) starts → calls[2] pending
		 * 4. Resolve M1 → marks stale again (same target pattern)
		 * 5. Resolve R → clearStale runs WITHOUT seqSnapshot gate → deletes the
		 *    stale entry M1 just wrote (BUG: silent corruption)
		 * 6. Fourth GET sees isStale: false — M1's mark was wiped.
		 */
		const captured: Array<{ invalidatedBy?: string[]; isStale?: boolean; method: string }> = []
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<UserSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => {
				captured.push({ invalidatedBy: ctx.invalidatedBy, isStale: ctx.isStale, method: ctx.method })
			}],
		})

		const m0 = sdk.users.update({ json: {}, params: { id: "5" } })
		await tick()
		resolveCall(calls, 0, jsonOk({}))
		await m0

		const rPromise = sdk.users.get({ params: { id: "5" } })
		await tick()

		const m1Promise = sdk.users.update({ json: {}, params: { id: "5" } })
		await tick()

		resolveCall(calls, 2, jsonOk({}))
		await m1Promise

		resolveCall(calls, 1, jsonOk({}))
		await rPromise

		const get4 = sdk.users.get({ params: { id: "5" } })
		await tick()
		resolveCall(calls, 3, jsonOk({}))
		await get4

		const getContexts = captured.filter((c) => c.method === "GET")
		/* second GET arrives after M1 was wiped — sees isStale: false (the bug) */
		expect(getContexts[1]?.isStale).toBeFalsy()
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-3 — Layer B' regression (runs when PHASE_F_FIXED=1)
   Asserts the FIXED behavior — skipped today, green after cleaner.
   ═══════════════════════════════════════════════════════════════════ */

describe.runIf(PHASE_F_FIXED)("#R6-3 — Layer B' regression (post-fix)", () => {
	it("wiped-mutation scenario post-fix: R's seqSnapshot < M1's seq → clearStale skips M1's entry", async () => {
		const captured: Array<{ invalidatedBy?: string[]; isStale?: boolean; method: string }> = []
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<UserSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => {
				captured.push({ invalidatedBy: ctx.invalidatedBy, isStale: ctx.isStale, method: ctx.method })
			}],
		})

		const m0 = sdk.users.update({ json: {}, params: { id: "6" } })
		await tick()
		resolveCall(calls, 0, jsonOk({}))
		await m0

		const rPromise = sdk.users.get({ params: { id: "6" } })
		await tick()

		const m1Promise = sdk.users.update({ json: {}, params: { id: "6" } })
		await tick()

		resolveCall(calls, 2, jsonOk({}))
		await m1Promise

		resolveCall(calls, 1, jsonOk({}))
		await rPromise

		const get4 = sdk.users.get({ params: { id: "6" } })
		await tick()
		resolveCall(calls, 3, jsonOk({}))
		await get4

		const getContexts = captured.filter((c) => c.method === "GET")
		expect(getContexts[1]?.isStale).toBe(true)
		expect((getContexts[1]?.invalidatedBy ?? []).length).toBeGreaterThan(0)
	})

	it("lost-invalidation cross-target post-fix: R completes after M but M's entry survives because seq > R's seqSnapshot", async () => {
		const captured: Array<{ isStale?: boolean; method: string }> = []
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<UserSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => { captured.push({ isStale: ctx.isStale, method: ctx.method }) }],
		})

		const rPromise = sdk.users.get({ params: { id: "7" } })
		await tick()

		const mPromise = sdk.users.update({ json: {}, params: { id: "7" } })
		await tick()
		resolveCall(calls, 1, jsonOk({}))
		await mPromise

		resolveCall(calls, 0, jsonOk({}))
		await rPromise

		const get2 = sdk.users.get({ params: { id: "7" } })
		await tick()
		resolveCall(calls, 2, jsonOk({}))
		await get2

		const getContexts = captured.filter((c) => c.method === "GET")
		expect(getContexts[0]?.isStale).toBeFalsy()
		expect(getContexts[1]?.isStale).toBe(true)
	})

	it("R4 #12 resolution: safe-mode parse error on 200 still fires markStale (response.ok gate, not r.error===null)", async () => {
		const captured: Array<{ isStale?: boolean; method: string }> = []

		const sm = {
			users: {
				get: { method: "GET", path: "/v1/users/malformed" },
				update: {
					invalidate: ["GET /v1/users/malformed"],
					method: "PATCH",
					path: "/v1/users/malformed",
				},
			},
		}

		type SafeSDK = {
			users: {
				get: () => Promise<{ data: unknown; error: unknown; response: Response; status: number }>
				update: (input?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown; response: Response; status: number }>
			}
		}

		let callIdx = 0
		const responses = [
			/* PATCH: 200 with invalid JSON — safe mode returns {data:null, error:SyntaxError}, but response.ok=true */
			new Response("{not valid json", { headers: { "content-type": "application/json" }, status: 200 }),
			/* GET: clean 200 */
			new Response(JSON.stringify({}), { headers: { "content-type": "application/json" }, status: 200 }),
		]

		const mockFetch = (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
			const r = responses[callIdx]
			callIdx++
			if (!r) throw new Error("no response available")
			return Promise.resolve(r)
		}

		const sdk = createSDK<SafeSDK>(sm, {
			baseURL: "http://api.example.com",
			fetch: mockFetch as typeof fetch,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => { captured.push({ isStale: ctx.isStale, method: ctx.method }) }],
		})

		const patchResult = await sdk.users.update({ json: {} })
		expect(patchResult.data).toBeNull()
		expect(patchResult.error).toBeDefined()

		await sdk.users.get()

		const getCtx = captured.find((c) => c.method === "GET")
		expect(getCtx?.isStale).toBe(true)
	})

	it("sequence counter monotonicity: after 5 mutations, a GET against any target sees isStale: true with non-empty invalidatedBy", async () => {
		const captured: Array<{ invalidatedBy?: string[]; isStale?: boolean; method: string }> = []
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<UserSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx) => {
				captured.push({ invalidatedBy: ctx.invalidatedBy, isStale: ctx.isStale, method: ctx.method })
			}],
		})

		for (let i = 0; i < 5; i++) {
			const p = sdk.users.update({ json: {}, params: { id: String(i) } })
			await tick()
			resolveCall(calls, i, jsonOk({}))
			await p
		}

		const getP = sdk.users.get({ params: { id: "0" } })
		await tick()
		resolveCall(calls, 5, jsonOk({}))
		await getP

		const getCtx = captured.find((c) => c.method === "GET")
		expect(getCtx?.isStale).toBe(true)
		expect((getCtx?.invalidatedBy ?? []).length).toBeGreaterThan(0)
	})
})
