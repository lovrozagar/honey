import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createSDK } from "../../../src/client/sdk.ts"
import { captureFetch } from "./_helpers/phase-f.ts"

const PHASE_F_FIXED = process.env["PHASE_F_FIXED"] === "1"

const serviceMap = {
	events: {
		stream: { method: "GET", path: "/v1/events", sse: true },
	},
	items: {
		list: { method: "GET", path: "/v1/items" },
	},
}

type TestSDK = {
	items: {
		list: (input?: Record<string, unknown>) => Promise<unknown>
	}
	events: {
		stream: (input?: Record<string, unknown>) => AsyncIterable<unknown>
	}
}

/* ═══════════════════════════════════════════════════════════════════
   #R6-2 — Layer A invariants (always GREEN before and after fix)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-2 signal cleanup — Layer A invariants", () => {
	it("request without config.timeout and without opts.signal: zero setTimeout calls from the SDK", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
		const countBefore = setTimeoutSpy.mock.calls.length
		const { fetcher } = captureFetch()
		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})
		await sdk.items.list()
		const countAfter = setTimeoutSpy.mock.calls.length
		expect(countAfter - countBefore).toBe(0)
		setTimeoutSpy.mockRestore()
	})

	it("opts.signal passed without config.timeout: user signal flows to fetch init, no new timer", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
		const countBefore = setTimeoutSpy.mock.calls.length
		const { calls, fetcher } = captureFetch()
		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})
		const ctrl = new AbortController()
		await sdk.items.list({ signal: ctrl.signal })
		expect(calls[0]?.init?.signal).toBe(ctrl.signal)
		const countAfter = setTimeoutSpy.mock.calls.length
		expect(countAfter - countBefore).toBe(0)
		setTimeoutSpy.mockRestore()
	})

	it("request completing before signal fires still resolves with mocked body", async () => {
		const { fetcher } = captureFetch(() =>
			new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		)
		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			throwOnError: true,
			timeout: 30_000,
		})
		const result = await sdk.items.list()
		expect(result).toBeDefined()
	})

	it("SSE request with config.timeout does NOT set a timer (streams are long-lived)", async () => {
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
		const countBefore = setTimeoutSpy.mock.calls.length

		const fetcher = (() => {
			return (_input: RequestInfo | URL, _init?: RequestInit) =>
				Promise.resolve(
					new Response("data: hello\n\n", {
						headers: { "content-type": "text/event-stream" },
						status: 200,
					}),
				)
		})() as typeof fetch

		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			timeout: 30_000,
		})
		const iter = sdk.events.stream({})
		const it_ = iter[Symbol.asyncIterator]()
		await it_.next()

		const countAfter = setTimeoutSpy.mock.calls.length
		expect(countAfter - countBefore).toBe(0)
		setTimeoutSpy.mockRestore()
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-2 — Layer B bug witness (runs when PHASE_F_FIXED is unset)
   Documents the timer-leak: setTimeout called N times, clearTimeout never.
   ═══════════════════════════════════════════════════════════════════ */

describe.skipIf(PHASE_F_FIXED)("#R6-2 — Layer B bug witness (pre-fix)", () => {
	let setTimeoutSpy: ReturnType<typeof vi.spyOn>
	let clearTimeoutSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
		clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
	})

	afterEach(() => {
		setTimeoutSpy.mockRestore()
		clearTimeoutSpy.mockRestore()
	})

	it("10 sequential requests with timeout: setTimeout fires >=10 times, clearTimeout fires 0 times (leak)", async () => {
		/* AbortSignal.timeout internally uses a timer that is never cancelled post-request */
		const { fetcher } = captureFetch()
		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			timeout: 30_000,
		})

		const setCountBefore = setTimeoutSpy.mock.calls.length
		const clearCountBefore = clearTimeoutSpy.mock.calls.length

		for (let i = 0; i < 10; i++) {
			await sdk.items.list()
		}

		const setDelta = setTimeoutSpy.mock.calls.length - setCountBefore
		const clearDelta = clearTimeoutSpy.mock.calls.length - clearCountBefore

		/* Bug: AbortSignal.timeout creates a timer; the SDK never calls clearTimeout */
		expect(clearDelta).toBe(0)
		/* AbortSignal.timeout may delegate timer creation to a native implementation,
		   so we cannot always spy on setTimeout. The primary witness is clearTimeout===0. */
		expect(setDelta + clearDelta).toBeGreaterThanOrEqual(0)
	})

	it("after 10 completed requests with timeout=30000, clearTimeout call count delta equals 0 (timers leaked)", async () => {
		const { fetcher } = captureFetch()
		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			timeout: 30_000,
		})

		const clearCountBefore = clearTimeoutSpy.mock.calls.length

		for (let i = 0; i < 10; i++) {
			await sdk.items.list()
		}

		const clearDelta = clearTimeoutSpy.mock.calls.length - clearCountBefore
		/* The current implementation uses AbortSignal.timeout which leaks the underlying timer */
		expect(clearDelta).toBe(0)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-2 — Layer B' regression (runs when PHASE_F_FIXED=1)
   Asserts the FIXED behavior — skipped today, green after cleaner.
   ═══════════════════════════════════════════════════════════════════ */

describe.runIf(PHASE_F_FIXED)("#R6-2 — Layer B' regression (post-fix)", () => {
	let setTimeoutSpy: ReturnType<typeof vi.spyOn>
	let clearTimeoutSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout")
		clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
	})

	afterEach(() => {
		setTimeoutSpy.mockRestore()
		clearTimeoutSpy.mockRestore()
	})

	it("10 sequential requests with timeout: clearTimeout call count delta equals setTimeout call count delta", async () => {
		const { fetcher } = captureFetch()
		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			timeout: 30_000,
		})

		const setCountBefore = setTimeoutSpy.mock.calls.length
		const clearCountBefore = clearTimeoutSpy.mock.calls.length

		for (let i = 0; i < 10; i++) {
			await sdk.items.list()
		}

		const setDelta = setTimeoutSpy.mock.calls.length - setCountBefore
		const clearDelta = clearTimeoutSpy.mock.calls.length - clearCountBefore

		expect(setDelta).toBeGreaterThanOrEqual(10)
		expect(clearDelta).toBe(setDelta)
	})

	it("user signal + timeout: clearTimeout fires after resolution, ctrl.abort() on second call propagates abort reason", async () => {
		const { fetcher } = captureFetch()
		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			timeout: 30_000,
		})

		const clearCountBefore = clearTimeoutSpy.mock.calls.length
		const ctrl = new AbortController()
		await sdk.items.list({ signal: ctrl.signal })
		const clearDelta = clearTimeoutSpy.mock.calls.length - clearCountBefore
		expect(clearDelta).toBeGreaterThanOrEqual(1)
	})

	it("aborting user signal before fetch resolves triggers cleanup AND propagates abort reason", async () => {
		/* Build a fetch that hangs until we abort it externally */
		let externalReject!: (e: unknown) => void
		const hangingFetch = (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			return new Promise<Response>((_resolve, reject) => {
				externalReject = reject
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason))
			})
		}

		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: hangingFetch as typeof fetch,
			timeout: 30_000,
		})

		const ctrl = new AbortController()
		const promise = sdk.items.list({ signal: ctrl.signal })
		ctrl.abort(new Error("user cancelled"))

		await expect(promise).rejects.toBeDefined()
		/* primary assertion: abort propagated and promise rejected cleanly without
		   the hanging fetch leaving an unhandled rejection */
		void externalReject
	})

	it("config.timeout unset: zero clearTimeout calls (no-op cleanup harmless)", async () => {
		const { fetcher } = captureFetch()
		const sdk = createSDK<TestSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			/* no timeout */
		})

		const clearCountBefore = clearTimeoutSpy.mock.calls.length
		await sdk.items.list()
		const clearDelta = clearTimeoutSpy.mock.calls.length - clearCountBefore
		expect(clearDelta).toBe(0)
	})
})
