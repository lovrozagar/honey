import { readFileSync } from "node:fs"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

/* ── fixture ── */

function loadFixture(name: string): Record<string, unknown> {
	const url = new URL(`./fixtures/python/${name}.json`, import.meta.url)
	return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>
}

/* ── SDK loader ──
 * Merges generated files into one self-contained ESM module:
 *   map (exports serviceMap) + client (with relative imports stripped)
 * esbuild strips TS types, then we load via base64 data URL.
 */

type SDKModule = {
	ClientError: new (...args: unknown[]) => { body: unknown; message: string; status: number }
	MatrixSDK: new (config: Record<string, unknown>) => Record<string, Record<string, (input?: Record<string, unknown>) => unknown>>
	isClientError: (e: unknown) => boolean
}

async function loadSDK(spec: Record<string, unknown>): Promise<SDKModule> {
	const { files } = generateSDK(spec, { name: "MatrixSDK", stem: "sdk" })

	/* strip the 2 relative import lines; map is inlined before the client body */
	const clientBody = files.client
		.replace(/^import type \{[^\n]+\n/, "")
		.replace(/^import \{[^\n]+\n/, "")

	const merged = `${files.map}\n${clientBody}`

	const { transform } = await import("esbuild")
	const { code: js } = await transform(merged, {
		format: "esm",
		loader: "ts",
		target: "esnext",
	})

	const dataUrl = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
	return (await import(dataUrl)) as SDKModule
}

/* ── shared state ── */

const SPEC = loadFixture("runtime-matrix")

let mod: SDKModule
let stub: ReturnType<typeof vi.fn>

beforeAll(async () => {
	mod = await loadSDK(SPEC)
})

beforeEach(() => {
	stub = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockResolvedValue(
		new Response(JSON.stringify({ email: "a@b.com", id: "u1" }), {
			headers: { "content-type": "application/json" },
			status: 200,
		}),
	)
})

/*
 * Track calls via stub.mock.calls — vitest records all invocations regardless
 * of which implementation/mock value is active. A manual push inside the impl
 * body is unreliable because mockResolvedValueOnce bypasses that body entirely.
 *
 * Pass fetch explicitly via config — the SDK module loads in a data-URL ESM
 * context whose globalThis may not share identity with the test's globalThis,
 * making vi.stubGlobal ineffective for the SDK's captured #fetchFn.
 */
function fetchCalls(): Array<{ init: RequestInit; url: string }> {
	return stub.mock.calls.map(([url, init]: [string, RequestInit]) => ({ init, url }))
}

function makeSdk(config: Record<string, unknown> = {}) {
	return new mod.MatrixSDK({ baseURL: "https://api.example.com", fetch: stub, throwOnError: true, ...config })
}

function makeSafeSdk(config: Record<string, unknown> = {}) {
	return new mod.MatrixSDK({ baseURL: "https://api.example.com", fetch: stub, throwOnError: false, ...config })
}

/* ══════════════════════════════════════════════════════════════
   #1 — happy HTTP POST: correct URL + method + body + content-type
   ══════════════════════════════════════════════════════════════ */

describe("#1 happy HTTP POST", () => {
	it("calls fetch with correct URL, method, body, and content-type header", async () => {
		const sdk = makeSdk()
		const result = await sdk.users.create({ json: { email: "test@example.com" } })

		const calls = fetchCalls()
		expect(calls).toHaveLength(1)
		expect(calls[0].url).toBe("https://api.example.com/users")
		expect(calls[0].init.method).toBe("POST")
		expect(calls[0].init.body).toBe(JSON.stringify({ email: "test@example.com" }))
		const headers = calls[0].init.headers as Headers
		expect(headers.get("content-type")).toBe("application/json")
		expect(result).toMatchObject({ email: "a@b.com", id: "u1" })
	})
})

/* ══════════════════════════════════════════════════════════════
   #2 — per-status error 404 → throws ClientError with right status
   ══════════════════════════════════════════════════════════════ */

describe("#2 per-status error 404", () => {
	it("throws ClientError with status 404", async () => {
		stub.mockResolvedValueOnce(
			new Response(JSON.stringify({ message: "not found" }), {
				headers: { "content-type": "application/json" },
				status: 404,
			}),
		)
		const sdk = makeSdk()
		await expect(sdk.users.get({ params: { id: "missing" } })).rejects.toSatisfy(
			(e: unknown) => mod.isClientError(e) && (e as { status: number }).status === 404,
		)
	})
})

/* ══════════════════════════════════════════════════════════════
   #3 — error status variants: 401 / 422 / 500
   ══════════════════════════════════════════════════════════════ */

describe("#3 error status variants", () => {
	for (const status of [401, 422, 500] as const) {
		it(`throws ClientError with status ${status}`, async () => {
			stub.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: `error ${status}` }), {
					headers: { "content-type": "application/json" },
					status,
				}),
			)
			const sdk = makeSdk()
			await expect(sdk.users.create({ json: { email: "x@y.com" } })).rejects.toSatisfy(
				(e: unknown) => mod.isClientError(e) && (e as { status: number }).status === status,
			)
		})
	}
})

/* ══════════════════════════════════════════════════════════════
   #4 — path params: substituted in URL + URL-encoded for special chars
   ══════════════════════════════════════════════════════════════ */

describe("#4 path params", () => {
	it("substitutes {id} in URL", async () => {
		const sdk = makeSdk()
		await sdk.users.get({ params: { id: "abc123" } })
		expect(fetchCalls()[0].url).toBe("https://api.example.com/users/abc123")
	})

	it("URL-encodes special characters in path params", async () => {
		const sdk = makeSdk()
		await sdk.users.get({ params: { id: "user@domain/path" } })
		expect(fetchCalls()[0].url).toBe("https://api.example.com/users/user%40domain%2Fpath")
	})
})

/* ══════════════════════════════════════════════════════════════
   #5 — query params: optional omitted when undefined, required sent
   ══════════════════════════════════════════════════════════════ */

describe("#5 query params", () => {
	it("sends provided query params in URL", async () => {
		const sdk = makeSdk()
		await sdk.users.list({ search: { page: 2, q: "alice" } })
		const url = new URL(fetchCalls()[0].url)
		expect(url.searchParams.get("page")).toBe("2")
		expect(url.searchParams.get("q")).toBe("alice")
	})

	it("omits undefined query params", async () => {
		const sdk = makeSdk()
		await sdk.users.list({ search: { page: undefined } })
		const url = new URL(fetchCalls()[0].url)
		expect(url.searchParams.has("page")).toBe(false)
	})

	it("sends no query string when search is omitted", async () => {
		const sdk = makeSdk()
		await sdk.users.list({})
		const url = new URL(fetchCalls()[0].url)
		expect(url.search).toBe("")
	})
})

/* ══════════════════════════════════════════════════════════════
   #6 — auth bearer: config headers → Authorization: Bearer …
   ══════════════════════════════════════════════════════════════ */

describe("#6 auth bearer via config headers", () => {
	it("sends Authorization header from static config headers", async () => {
		const sdk = makeSdk({ headers: { Authorization: "Bearer tok123" } })
		await sdk.users.list({})
		const headers = fetchCalls()[0].init.headers as Headers
		expect(headers.get("authorization")).toBe("Bearer tok123")
	})

	it("sends Authorization header from dynamic config headers function", async () => {
		const sdk = makeSdk({
			headers: async () => ({ Authorization: "Bearer dynamic456" }),
		})
		await sdk.users.list({})
		const headers = fetchCalls()[0].init.headers as Headers
		expect(headers.get("authorization")).toBe("Bearer dynamic456")
	})
})

/* ══════════════════════════════════════════════════════════════
   #7 — 401 retry: onResponse hook → second fetch with refreshed state
   ══════════════════════════════════════════════════════════════ */

describe("#7 401 retry via onResponse hook", () => {
	it("retries once when onResponse hook calls ctx.retry() on 401", async () => {
		stub
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ message: "unauthorized" }), {
					headers: { "content-type": "application/json" },
					status: 401,
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ email: "a@b.com", id: "u1" }), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
			)

		const sdk = makeSdk({
			onResponse: [
				async (ctx: { response: { status: number }; retry: () => Promise<unknown> }) => {
					if (ctx.response.status === 401) {
						return ctx.retry()
					}
					return undefined
				},
			],
		})

		const result = await sdk.users.list({})
		expect(fetchCalls()).toHaveLength(2)
		expect(result).toMatchObject({ id: "u1" })
	})
})

/* ══════════════════════════════════════════════════════════════
   #8 — SDKResult mode (throwOnError: false): returns shape on non-2xx
   ══════════════════════════════════════════════════════════════ */

describe("#8 SDKResult mode (throwOnError: false)", () => {
	it("returns { data, error, status, response } on 404 without throwing", async () => {
		stub.mockResolvedValueOnce(
			new Response(JSON.stringify({ message: "not found" }), {
				headers: { "content-type": "application/json" },
				status: 404,
			}),
		)
		const sdk = makeSafeSdk()
		const result = (await sdk.users.get({ params: { id: "x" } })) as {
			data: unknown
			error: unknown
			response: unknown
			status: number
		}
		expect(result.data).toBeNull()
		expect(result.status).toBe(404)
		expect(result.error).toBeDefined()
		expect(result.response).toBeDefined()
	})

	it("returns { data, error: null, status } on 2xx success", async () => {
		const sdk = makeSafeSdk()
		const result = (await sdk.users.list({})) as {
			data: unknown
			error: unknown
			status: number
		}
		expect(result.error).toBeNull()
		expect(result.status).toBe(200)
		expect(result.data).toMatchObject({ id: "u1" })
	})
})

/* ══════════════════════════════════════════════════════════════
   #9 — SSE: generated method returns AsyncIterable → yields parsed events
   ══════════════════════════════════════════════════════════════ */

describe("#9 SSE returns AsyncIterable with parsed events", () => {
	it("yields SSE events from streamed response body", async () => {
		const sseBody = "data: hello\n\ndata: world\n\n"
		const encoder = new TextEncoder()
		const bytes = encoder.encode(sseBody)
		let offset = 0
		const readable = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (offset >= bytes.length) {
					controller.close()
					return
				}
				const chunk = bytes.slice(offset, offset + 6)
				offset += 6
				controller.enqueue(chunk)
			},
		})

		stub.mockResolvedValueOnce(
			new Response(readable, {
				headers: { "content-type": "text/event-stream" },
				status: 200,
			}),
		)

		const sdk = makeSdk()
		const iterable = sdk.events.stream({}) as AsyncIterable<{ data: string; event?: string }>
		const events: Array<{ data: string; event?: string }> = []
		for await (const evt of iterable) {
			events.push(evt)
		}
		expect(events).toHaveLength(2)
		expect(events[0].data).toBe("hello")
		expect(events[1].data).toBe("world")
	})
})

/* ══════════════════════════════════════════════════════════════
   #10 — WS: skipped — jsdom/happy-dom has no WebSocket global; mocking
   native WebSocket constructor is possible but the test would exercise
   stub wiring rather than actual generated logic. The #connectWS path is
   covered by string-assert tests in sdk-r6-phase-j.test.ts.
   ══════════════════════════════════════════════════════════════ */

describe("#10 WebSocket", () => {
	it.skip("skipped: no native WebSocket in vitest jsdom; covered by sdk-r6-phase-j string tests", () => {
		/* intentionally empty */
	})
})

/* ══════════════════════════════════════════════════════════════
   #11 — invalidation: mutation with x-invalidate marks matching query stale
   ══════════════════════════════════════════════════════════════ */

describe("#11 invalidation: mutation marks stale targets", () => {
	it("marks GET /users stale after POST /users with x-invalidate", async () => {
		/*
		 * We capture isStale via onRequest on a fresh sdk that has performed a
		 * create (which carries x-invalidate: ["GET /users", "GET /users/:id"]).
		 * After the create, the next list call should see isStale: true.
		 */
		let capturedIsStale: boolean | undefined
		const sdk = makeSdk({
			invalidation: { staleTime: 60_000 },
			onRequest: [
				(ctx: Record<string, unknown>) => {
					capturedIsStale = ctx.isStale as boolean | undefined
				},
			],
		})

		/* prime: create triggers #markStale for GET /users */
		stub.mockResolvedValueOnce(
			new Response(JSON.stringify({ email: "b@c.com", id: "u2" }), {
				headers: { "content-type": "application/json" },
				status: 201,
			}),
		)
		await sdk.users.create({ json: { email: "b@c.com" } })

		/* list — should be stale because create invalidated it */
		stub.mockResolvedValueOnce(
			new Response(JSON.stringify([{ id: "u1" }]), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		)
		await sdk.users.list({})
		expect(capturedIsStale).toBe(true)
	})
})

/* ══════════════════════════════════════════════════════════════
   #12 — reserved words: operationId "class.from" is callable at runtime
   ══════════════════════════════════════════════════════════════ */

describe("#12 reserved words: class.from is callable", () => {
	it("sdk.class.from() dispatches correct GET /class/from request", async () => {
		const sdk = makeSdk()
		/*
		 * "class" and "from" are JS reserved words but property access via Proxy
		 * works fine — they are just string keys at runtime.
		 */
		const classResource = (sdk as unknown as Record<string, Record<string, (input?: unknown) => unknown>>)["class"]
		expect(typeof classResource.from).toBe("function")
		await classResource.from({})
		const calls = fetchCalls()
		expect(calls[0].url).toBe("https://api.example.com/class/from")
		expect(calls[0].init.method).toBe("GET")
	})
})

/* ══════════════════════════════════════════════════════════════
   #13 — headers merge: per-call headers + config headers, per-call wins
   ══════════════════════════════════════════════════════════════ */

describe("#13 headers merge: per-call wins over config", () => {
	it("merges config and per-call headers, per-call taking precedence", async () => {
		const sdk = makeSdk({
			headers: { "x-tenant": "global", "x-version": "1" },
		})
		await sdk.users.list({ headers: { "x-extra": "yes", "x-tenant": "override" } })
		const headers = fetchCalls()[0].init.headers as Headers
		expect(headers.get("x-tenant")).toBe("override")
		expect(headers.get("x-version")).toBe("1")
		expect(headers.get("x-extra")).toBe("yes")
	})
})

/* ══════════════════════════════════════════════════════════════
   #14 — timeout: per-call timeout passed to fetch signal
   ══════════════════════════════════════════════════════════════ */

describe("#14 timeout: config timeout wired to AbortSignal", () => {
	it("aborts fetch when timeout fires before response resolves", async () => {
		/* fetch that never resolves — SDK should abort it via signal */
		stub.mockImplementationOnce((_url: string, init: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")))
			})
		})

		const sdk = makeSdk({ timeout: 1 }) /* 1 ms — fires immediately */
		await expect(sdk.users.list({})).rejects.toThrow()
	})

	it("does not abort when response arrives within timeout", async () => {
		const sdk = makeSdk({ timeout: 5_000 })
		const result = await sdk.users.list({})
		expect(result).toMatchObject({ id: "u1" })
	})
})
