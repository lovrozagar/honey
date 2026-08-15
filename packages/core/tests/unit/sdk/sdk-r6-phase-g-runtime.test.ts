import { describe, expect, it } from "vitest"
import { ClientError } from "../../../src/client/error.ts"
import { createSDK } from "../../../src/client/sdk.ts"
import { deferredFetch, tick } from "./_helpers/phase-f.ts"

const PHASE_G_FIXED = process.env["PHASE_G_FIXED"] === "1"

/* ── service map fixture ── */

const serviceMap = {
	items: {
		get: { method: "GET", params: ["id"], path: "/v1/items/:id" },
		list: { method: "GET", params: [], path: "/v1/items" },
		update: {
			invalidate: ["GET /v1/items/:id"],
			method: "POST",
			params: ["id"],
			path: "/v1/items/:id",
		},
	},
}

type ItemSDK = {
	items: {
		get: (input: { params: { id: string } }) => Promise<{ data: unknown; error: unknown; response: Response; status: number }>
		list: (input?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown; response: Response; status: number }>
		update: (input: { json?: unknown; params: { id: string } }) => Promise<{ data: unknown; error: unknown; response: Response; status: number }>
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
		status,
	})
}

function ctResponse(body: string | ArrayBuffer, ct: string, status = 200): Response {
	return new Response(body, {
		headers: { "content-type": ct },
		status,
	})
}

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
   #R6-7 runtime — non-string message coercion
   ═══════════════════════════════════════════════════════════════════ */

describe.skipIf(PHASE_G_FIXED)("#R6-7 parseErrorAsClientError — Layer B bug witness (pre-fix)", () => {
	it("pre-fix: nested object message coerces to [object Object]", async () => {
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(jsonResponse({ message: { detail: "x" } }, 500)),
			throwOnError: true,
		})

		let caught: unknown
		try {
			await sdk.items.get({ params: { id: "1" } })
		} catch (e) {
			caught = e
		}

		expect(caught).toBeInstanceOf(ClientError)
		expect((caught as ClientError).message).toBe("[object Object]")
	})
})

describe.runIf(PHASE_G_FIXED)("#R6-7 parseErrorAsClientError — Layer B' regression (post-fix)", () => {
	it("post-fix: nested object message falls back to HTTP 500", async () => {
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(jsonResponse({ message: { detail: "x" } }, 500)),
			throwOnError: true,
		})

		let caught: unknown
		try {
			await sdk.items.get({ params: { id: "1" } })
		} catch (e) {
			caught = e
		}

		expect(caught).toBeInstanceOf(ClientError)
		const err = caught as ClientError<{ message: { detail: string } }>
		expect(err.message).toBe("HTTP 500")
		expect(err.body).not.toBeNull()
		expect((err.body as { message: { detail: string } }).message.detail).toBe("x")
	})

	it("post-fix: 1000-char message with control chars is truncated to 512 and stripped", async () => {
		const longMsg = `${"x".repeat(1000)}\u0001\u0002junk`
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(jsonResponse({ message: longMsg }, 500)),
			throwOnError: true,
		})

		let caught: unknown
		try {
			await sdk.items.get({ params: { id: "1" } })
		} catch (e) {
			caught = e
		}

		expect(caught).toBeInstanceOf(ClientError)
		const err = caught as ClientError
		expect(err.message.length).toBeLessThanOrEqual(512)
		/* verify control chars stripped: no codepoints in range 0x00–0x1F remain */
		const hasControlChar = [...err.message].some((c) => (c.codePointAt(0) ?? 32) < 32)
		expect(hasControlChar).toBe(false)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-8 / #R6-30 runtime — content-type parsing
   Layer A invariants (always GREEN) — existing correct behavior
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-8 parseBody MIME parsing — Layer A invariants", () => {
	it("text/html body resolves to string", async () => {
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(ctResponse("<html>error</html>", "text/html")),
		})

		const result = await sdk.items.list()
		expect(typeof result.data).toBe("string")
		expect(result.data).toBe("<html>error</html>")
	})

	it("application/octet-stream body resolves to ArrayBuffer", async () => {
		const binary = new Uint8Array([1, 2, 3]).buffer
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(ctResponse(binary, "application/octet-stream")),
		})

		const result = await sdk.items.list()
		expect(result.data).toBeInstanceOf(ArrayBuffer)
	})
})

describe.skipIf(PHASE_G_FIXED)("#R6-8 parseBody MIME parsing — Layer B bug witness (pre-fix)", () => {
	it("pre-fix: application/vnd.api+json resolves to raw string (not parsed JSON)", async () => {
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(ctResponse('{"ok":true}', "application/vnd.api+json; charset=utf-8")),
		})

		const result = await sdk.items.list()
		expect(typeof result.data).toBe("string")
	})

	it("pre-fix: application/problem+json resolves to raw string (not parsed JSON)", async () => {
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(ctResponse('{"type":"about:blank"}', "application/problem+json")),
		})

		const result = await sdk.items.list()
		expect(typeof result.data).toBe("string")
	})

	it("pre-fix: application/jsonp triggers .json() via substring match — data is null, error is SyntaxError", async () => {
		/* application/jsonp contains the substring "application/json", so current ct.includes()
		   incorrectly calls response.json() on non-JSON content. In safe mode the parse error
		   propagates as a rejected promise from _parseBody up through requestSafe's _doRequest,
		   but requestSafe wraps the whole call so the promise rejects with the SyntaxError. */
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(ctResponse("callback({});", "application/jsonp")),
		})

		const result = await sdk.items.list()
		expect(result.data).toBeNull()
		expect(result.error).toBeInstanceOf(SyntaxError)
	})
})

describe.runIf(PHASE_G_FIXED)("#R6-8 parseBody MIME parsing — Layer B' regression (post-fix)", () => {
	it("post-fix: application/vnd.api+json; charset=utf-8 resolves to parsed JSON object", async () => {
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(ctResponse('{"ok":true}', "application/vnd.api+json; charset=utf-8")),
		})

		const result = await sdk.items.list()
		expect(result.data).toEqual({ ok: true })
	})

	it("post-fix: application/problem+json resolves to parsed JSON object", async () => {
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(ctResponse('{"type":"about:blank"}', "application/problem+json")),
		})

		const result = await sdk.items.list()
		expect(result.data).toEqual({ type: "about:blank" })
	})

	it("post-fix: application/jsonp resolves to ArrayBuffer (binary fallback)", async () => {
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(ctResponse("callback({});", "application/jsonp")),
		})

		const result = await sdk.items.list()
		expect(result.data).toBeInstanceOf(ArrayBuffer)
	})

	it("post-fix: application/pdf resolves to ArrayBuffer", async () => {
		const binary = new Uint8Array([37, 80, 68, 70]).buffer
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(ctResponse(binary, "application/pdf")),
		})

		const result = await sdk.items.list()
		expect(result.data).toBeInstanceOf(ArrayBuffer)
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-11 runtime — onRequest ctx.body read and mutate
   Layer A invariant: GET without json/form has ctx.body === undefined (always GREEN)
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-11 onRequest ctx.body — Layer A invariants", () => {
	it("GET request without json/form — ctx.body is undefined", async () => {
		let capturedBody: unknown = "NOT_SET"
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: () => Promise.resolve(jsonResponse({})),
			onRequest: [(ctx) => { capturedBody = ctx.body }],
		})

		await sdk.items.get({ params: { id: "1" } })
		expect(capturedBody).toBeUndefined()
	})
})

describe.skipIf(PHASE_G_FIXED)("#R6-11 onRequest ctx.body — Layer B bug witness (pre-fix)", () => {
	it("pre-fix: POST with json body — ctx.body is undefined (body not exposed)", async () => {
		let capturedBody: unknown = "NOT_SET"
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			onRequest: [(ctx) => { capturedBody = ctx.body }],
		})

		const p = sdk.items.update({ json: { a: 1 }, params: { id: "1" } })
		await tick()
		resolveCall(calls, 0, jsonResponse({}))
		await p

		expect(capturedBody).toBeUndefined()
	})
})

describe.runIf(PHASE_G_FIXED)("#R6-11 onRequest ctx.body — Layer B' regression (post-fix)", () => {
	it("post-fix: POST with json body — ctx.body equals JSON.stringify({a: 1})", async () => {
		let capturedBody: unknown = "NOT_SET"
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			onRequest: [(ctx) => { capturedBody = ctx.body }],
		})

		const p = sdk.items.update({ json: { a: 1 }, params: { id: "1" } })
		await tick()
		resolveCall(calls, 0, jsonResponse({}))
		await p

		expect(capturedBody).toBe(JSON.stringify({ a: 1 }))
	})

	it("post-fix: hook mutation of ctx.body rewrites the outgoing fetch body", async () => {
		const { calls, fetcher } = deferredFetch()

		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			onRequest: [(ctx) => { ctx.body = JSON.stringify({ a: 2 }) }],
		})

		const p = sdk.items.update({ json: { a: 1 }, params: { id: "1" } })
		await tick()
		const sentInit = calls[0]?.init
		resolveCall(calls, 0, jsonResponse({}))
		await p

		expect(sentInit?.body).toBe(JSON.stringify({ a: 2 }))
	})
})

/* ═══════════════════════════════════════════════════════════════════
   #R6-13 runtime — retry() rejects with parsed ClientError on non-ok
   ═══════════════════════════════════════════════════════════════════ */

describe("#R6-13 onResponse retry — Layer A invariants", () => {
	it("successful retry (429 → 200) resolves with the 200 Response", async () => {
		const { calls, fetcher } = deferredFetch()

		let retryResult: Response | undefined
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			onResponse: [async (ctx) => {
				if (ctx.response.status === 429) {
					retryResult = await ctx.retry()
				}
				return undefined
			}],
		})

		const p = sdk.items.get({ params: { id: "1" } })
		await tick()
		resolveCall(calls, 0, new Response(null, { status: 429 }))
		await tick()
		await tick()
		resolveCall(calls, 1, jsonResponse({ id: "1" }))
		await p

		expect(retryResult).toBeInstanceOf(Response)
		expect(retryResult?.status).toBe(200)
	})
})

describe.skipIf(PHASE_G_FIXED)("#R6-13 onResponse retry — Layer B bug witness (pre-fix)", () => {
	it("pre-fix: retry on 500 resolves silently — no ClientError thrown, retryError stays undefined", async () => {
		const { calls, fetcher } = deferredFetch()

		let retryError: unknown
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			onResponse: [async (ctx) => {
				if (ctx.response.status === 429) {
					try {
						await ctx.retry()
					} catch (e) {
						retryError = e
					}
				}
				return undefined
			}],
		})

		const p = sdk.items.get({ params: { id: "1" } })
		await tick()
		resolveCall(calls, 0, new Response(JSON.stringify({ message: "rate limited" }), { headers: { "content-type": "application/json" }, status: 429 }))
		await tick()
		await tick()
		resolveCall(calls, 1, new Response(JSON.stringify({ message: "upstream failed" }), { headers: { "content-type": "application/json" }, status: 500 }))
		await p.catch(() => {})

		expect(retryError).toBeUndefined()
	})
})

describe.runIf(PHASE_G_FIXED)("#R6-13 onResponse retry — Layer B' regression (post-fix)", () => {
	it("post-fix: retry on 500 rejects with parsed ClientError (status 500, correct message)", async () => {
		const { calls, fetcher } = deferredFetch()

		let retryError: unknown
		const sdk = createSDK<ItemSDK>(serviceMap, {
			baseURL: "http://api.example.com",
			fetch: fetcher,
			onResponse: [async (ctx) => {
				if (ctx.response.status === 429) {
					try {
						await ctx.retry()
					} catch (e) {
						retryError = e
					}
				}
				return undefined
			}],
		})

		const p = sdk.items.get({ params: { id: "1" } })
		await tick()
		resolveCall(calls, 0, new Response(JSON.stringify({ message: "rate limited" }), { headers: { "content-type": "application/json" }, status: 429 }))
		await tick()
		await tick()
		resolveCall(calls, 1, new Response(JSON.stringify({ message: "upstream failed" }), { headers: { "content-type": "application/json" }, status: 500 }))
		await p.catch(() => {})

		expect(retryError).toBeInstanceOf(ClientError)
		expect((retryError as ClientError).status).toBe(500)
		expect((retryError as ClientError).message).toBe("upstream failed")
	})
})
