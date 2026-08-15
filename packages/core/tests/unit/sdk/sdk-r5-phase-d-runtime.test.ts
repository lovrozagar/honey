import { describe, expect, it, vi } from "vitest"
import { createSDK } from "../../../src/client/sdk.ts"

/* ── helpers ── */

/**
 * Returns a single-call fetch mock that yields one malformed JSON body with the
 * supplied status and content-type. Used to validate that safe-mode handles
 * parse failures without throwing.
 */
function mockFetchMalformedJson(
	status: number,
	body: string,
	contentType: string,
): typeof fetch {
	return vi.fn<typeof fetch>(() =>
		Promise.resolve(
			new Response(body, {
				headers: { "content-type": contentType },
				status,
			}),
		),
	) as unknown as typeof fetch
}

/**
 * Returns a fetch that captures every call's URL + init for later assertion.
 * Each call yields a 200 text/event-stream response (body can be overridden).
 */
function mockFetchCapture(
	responseFactory: () => Response = () =>
		new Response("data: hello\n\n", {
			headers: { "content-type": "text/event-stream" },
			status: 200,
		}),
): { calls: Array<{ init: RequestInit | undefined; url: string }>; fetcher: typeof fetch } {
	const calls: Array<{ init: RequestInit | undefined; url: string }> = []
	const fetcher = vi.fn<typeof fetch>((input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ init, url: String(input) })
		return Promise.resolve(responseFactory())
	}) as unknown as typeof fetch
	return { calls, fetcher }
}

/* ═══════════════════════════════════════════════════════════════════
   R5-4 — `#requestSafe` never throws on parse errors
   ═══════════════════════════════════════════════════════════════════ */

describe("R5-4 safe-mode parse failure — resolves, does not throw", () => {
	type SafeSDK = {
		items: {
			list: () => Promise<{
				data: unknown
				error: unknown
				response: Response
				status: number
			}>
		}
	}

	const safeServiceMap = {
		items: {
			list: { method: "GET", path: "/v1/items" },
		},
	}

	it("R5-4: safe-mode call with malformed JSON body resolves with {data: null, error: <Error>, status: 200}", async () => {
		const fetcher = mockFetchMalformedJson(200, "{not json", "application/json")
		const sdk = createSDK<SafeSDK>(safeServiceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			/* throwOnError omitted → defaults to false (safe mode) */
		})

		/*
		 * The promise MUST resolve, never reject. Against the current buggy code
		 * (both codegen.ts #requestSafe AND http.ts HTTPClient.requestSafe at L388)
		 * the parseBody throws and the rejection propagates → this `await` throws
		 * and vitest marks the test as failing with an uncaught SyntaxError.
		 */
		const result = await sdk.items.list()

		expect(result.data).toBeNull()
		expect(result.error).toBeDefined()
		expect(result.error).not.toBeNull()
		expect(result.status).toBe(200)
		expect(result.response).toBeInstanceOf(Response)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   R5-5 — SSE runtime respects cookies opt passed via input
   ═══════════════════════════════════════════════════════════════════ */

describe("R5-5 SSE cookies passthrough — request cookie header set from input.cookies", () => {
	type StreamSDK = {
		events: {
			stream: (input: Record<string, unknown>) => AsyncIterable<{
				data: string
				event?: string
				id?: string
				retry?: number
			}>
		}
	}

	const streamServiceMap = {
		events: {
			stream: { method: "GET", path: "/v1/stream", sse: true },
		},
	}

	it("R5-5: SSE subscribe with {cookies: {session: 'abc'}} yields a request whose cookie header contains session=abc", async () => {
		const { calls, fetcher } = mockFetchCapture()
		const sdk = createSDK<StreamSDK>(streamServiceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
		})

		/*
		 * The generated SSE input type currently does NOT expose `cookies?` (bug #R5-5)
		 * so a properly-typed call site cannot pass cookies. Our runtime goes through
		 * `http.requestStream` → `buildHeaders` → `opts.cookies` which IS read today —
		 * meaning this test passes iff the emitter fix exposes `cookies?` AND the
		 * sdk.ts proxy passes `input` through (it already does). The test bypasses
		 * the generated type by casting the input to any.
		 */
		const iter = sdk.events.stream({ cookies: { session: "abc" } })
		/* kick off at least one network round-trip by starting iteration */
		const it_ = iter[Symbol.asyncIterator]()
		await it_.next()

		expect(calls.length).toBeGreaterThanOrEqual(1)
		const first = calls[0]
		if (!first) throw new Error("no fetch calls captured")
		const headers = new Headers(first.init?.headers)
		const cookieHeader = headers.get("cookie")
		expect(cookieHeader).not.toBeNull()
		expect(cookieHeader ?? "").toContain("session=abc")
	})
})
