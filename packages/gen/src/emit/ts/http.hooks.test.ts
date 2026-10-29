import { describe, expect, it } from "vitest"
import { emittedApp, emittedSdk, recordingFetch } from "./__fixtures__/emitted.ts"

type Json = Record<string, unknown>
/** What a safe call resolves to. */
type Result = { data?: unknown; error?: any; ok: boolean; response: Response }
type Verb = "delete" | "get" | "patch" | "post" | "put"
type Api = Record<Verb, (path: string, input?: Json) => Promise<unknown>> & {
	safe: Record<Verb, (path: string, input?: Json) => Promise<Result>>
}
/** The SDK's `items` operations, and their safe twins. */
type Items = Record<"get" | "update", (input: Json) => Promise<unknown>>
type Answer = (request: Request) => Response | Promise<Response>
/** The onRequest context these cases touch. */
type RequestCtx = { body?: BodyInit; headers: Headers; method: string; path: string; url: string }
/** The onResponse context these cases touch. */
type ResponseCtx = {
	isRetry: boolean
	method: string
	path: string
	response: Response
	retry: () => Promise<Response>
	url: string
}

const OK = { 200: { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }

/** `createClient` from the emitted app client, over a recording fetch answering `answer`. */
async function appClient(config: Json, answer?: Answer): Promise<{ api: Api; calls: Request[] }> {
	const { createClient } = (await emittedApp()) as unknown as { createClient: (config: Json) => Api }
	const { calls, fetch } = recordingFetch(answer)
	return { api: createClient({ baseURL: "https://api.test.com", fetch, ...config }), calls }
}

/** The emitted SDK with `items.get` (`GET /items/{id}`) and `items.update` (`PATCH /items/{id}`). */
async function itemsSdk(
	config: Json,
	answer?: Answer,
): Promise<{ calls: Request[]; items: Items; safe: Record<"get", (input: Json) => Promise<Result>> }> {
	const parameters = [{ in: "path", name: "id", required: true, schema: { type: "string" } }]
	const requestBody = { content: { "application/json": { schema: { type: "object" } } } }
	const document = {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/items/{id}": {
				get: { operationId: "items.get", parameters, responses: OK },
				patch: { operationId: "items.update", parameters, requestBody, responses: OK },
			},
		},
	}
	const { TestSDK } = (await emittedSdk(document)) as unknown as {
		TestSDK: new (config: Json) => { items: Items; safe: { items: Record<"get", (input: Json) => Promise<Result>> } }
	}
	const { calls, fetch } = recordingFetch(answer)
	const sdk = new TestSDK({ baseURL: "https://api.test.com", fetch, ...config })
	return { calls, items: sdk.items, safe: sdk.safe.items }
}

/** Answers each request with the next of `responses`, repeating the last. */
function sequence(...responses: Array<() => Response>): Answer {
	let n = 0
	return () => (responses[Math.min(n++, responses.length - 1)] as () => Response)()
}

const unauthorized = () => Response.json({ message: "expired" }, { status: 401 })
const ok = () => Response.json({ ok: true })

/** Retries a 401 that is not itself a retry. */
const retry401 = (ctx: ResponseCtx) => (ctx.response.status === 401 && !ctx.isRetry ? ctx.retry() : undefined)

describe("onRequest: runs before fetch, in order, on the built request", () => {
	// v0: e7defd032f
	// v0: b6d080af0a
	it("sends a header the hook sets", async () => {
		const { api, calls } = await appClient({
			onRequest: [(ctx: RequestCtx) => void ctx.headers.set("x-injected", "from-interceptor")],
		})
		await api.get("/test")
		expect(calls[0]?.headers.get("x-injected")).toBe("from-interceptor")
	})

	// v0: db1957d863
	// v0: 10fa479b86
	it("runs several hooks in order, each one's changes sent", async () => {
		const order: string[] = []
		const hook = (name: string) => (ctx: RequestCtx) => {
			order.push(name)
			ctx.headers.set(`x-${name}`, name)
		}
		const { api, calls } = await appClient({ onRequest: [hook("first"), hook("second")] })
		await api.get("/test")
		expect([order, calls[0]?.headers.get("x-first"), calls[0]?.headers.get("x-second")]).toEqual([
			["first", "second"],
			"first",
			"second",
		])
	})

	// v0: b0bdcc27d8
	it("gives the hook the method, the path template and the built url", async () => {
		const seen: Json[] = []
		const { api } = await appClient({
			onRequest: [(ctx: RequestCtx) => void seen.push({ method: ctx.method, path: ctx.path, url: ctx.url })],
		})
		await api.post("/users/:id", { params: { id: "42" } })
		expect(seen).toEqual([{ method: "POST", path: "/users/:id", url: "https://api.test.com/users/42" }])
	})
})

describe("onRequest: async hooks and hook errors", () => {
	// v0: e52cbce038
	it("awaits an async hook before sending", async () => {
		const onRequest = [
			async (ctx: RequestCtx) => {
				await new Promise((resolve) => setTimeout(resolve, 5))
				ctx.headers.set("x-async", "resolved")
			},
		]
		const { api, calls } = await appClient({ onRequest })
		await api.get("/test")
		expect(calls[0]?.headers.get("x-async")).toBe("resolved")
	})

	// v0: 8e11f42991
	it("runs after async config headers are resolved", async () => {
		const onRequest = [
			(ctx: RequestCtx) => void ctx.headers.set("x-saw-auth", ctx.headers.get("authorization") ?? "none"),
		]
		const { api, calls } = await appClient({
			headers: async () => ({ authorization: "Bearer token" }),
			onRequest,
		})
		await api.get("/test")
		expect(calls[0]?.headers.get("x-saw-auth")).toBe("Bearer token")
	})

	// v0: c11d515486
	it("rejects with the hook's error, sending nothing", async () => {
		const { api, calls } = await appClient({
			onRequest: [
				() => {
					throw new Error("interceptor broke")
				},
			],
		})
		await expect(api.get("/test")).rejects.toThrow("interceptor broke")
		expect(calls).toHaveLength(0)
	})

	// v0: 1b62d834f2
	it("rejects with the hook's error from the safe twin too", async () => {
		const { api } = await appClient({
			onRequest: [
				() => {
					throw new Error("onRequest exploded")
				},
			],
		})
		await expect(api.safe.get("/api/health")).rejects.toThrow("onRequest exploded")
	})
})

describe("onRequest ctx.body: the encoded body, which the hook may replace (generated SDK)", () => {
	// v0: ff27717585
	it("is undefined for a request without json or form", async () => {
		const bodies: unknown[] = []
		const { items } = await itemsSdk({ onRequest: [(ctx: RequestCtx) => void bodies.push(ctx.body)] })
		await items.get({ params: { id: "1" } })
		expect(bodies).toEqual([undefined])
	})

	// v0: 93b01cc495
	it("is the JSON text of a json body", async () => {
		const bodies: unknown[] = []
		const { items } = await itemsSdk({ onRequest: [(ctx: RequestCtx) => void bodies.push(ctx.body)] })
		await items.update({ json: { a: 1 }, params: { id: "1" } })
		expect(bodies).toEqual([JSON.stringify({ a: 1 })])
	})

	// v0: c4c642230f
	it("sends the body the hook wrote", async () => {
		const { calls, items } = await itemsSdk({
			onRequest: [(ctx: RequestCtx) => void (ctx.body = JSON.stringify({ a: 2 }))],
		})
		await items.update({ json: { a: 1 }, params: { id: "1" } })
		expect(await calls[0]?.text()).toBe(JSON.stringify({ a: 2 }))
	})
})

describe("onResponse: runs after fetch, in order, and may retry once", () => {
	// v0: ccc8efb398
	// v0: f76a9f3485
	it("gives the hook the method, the path, the url and the response", async () => {
		const seen: Json[] = []
		const onResponse = [
			(ctx: ResponseCtx) =>
				void seen.push({ method: ctx.method, path: ctx.path, status: ctx.response.status, url: ctx.url }),
		]
		const { api } = await appClient({ onResponse }, () => Response.json({ id: "1" }))
		await api.get("/users")
		expect(seen).toEqual([{ method: "GET", path: "/users", status: 200, url: "https://api.test.com/users" }])
	})

	// v0: e81418fe22
	it("runs several hooks in order", async () => {
		const seen: number[] = []
		const onResponse = [
			(ctx: ResponseCtx) => void seen.push(ctx.response.status),
			(ctx: ResponseCtx) => void seen.push(ctx.response.status + 1000),
		]
		const { api } = await appClient({ onResponse })
		await api.get("/api/health")
		expect(seen).toEqual([200, 1200])
	})

	// v0: ae5ce16d4b
	it("runs for the safe twin, leaving its Ok's data as parsed", async () => {
		const seen: number[] = []
		const { api } = await appClient({ onResponse: [(ctx: ResponseCtx) => void seen.push(ctx.response.status)] }, () =>
			Response.json({ value: 42 }),
		)
		const result = await api.safe.get("/test")
		expect([result.ok, result.data, seen]).toEqual([true, { value: 42 }, [200]])
	})
})

describe("onResponse: error responses and hook errors", () => {
	// v0: fc0c80c72f
	it("sees error responses before the caller does", async () => {
		const seen: Json[] = []
		const onResponse = [
			(ctx: ResponseCtx) =>
				void (ctx.response.ok ? undefined : seen.push({ path: ctx.path, status: ctx.response.status })),
		]
		const { api } = await appClient({ onResponse }, (request) =>
			Response.json({ message: "no" }, { status: request.url.endsWith("/nonexistent") ? 404 : 500 }),
		)
		await api.safe.get("/api/nonexistent")
		await api.safe.get("/api/boundary/default")
		expect(seen).toEqual([
			{ path: "/api/nonexistent", status: 404 },
			{ path: "/api/boundary/default", status: 500 },
		])
	})

	// v0: 9e566f857c
	it("rejects with the hook's error from the safe twin", async () => {
		const { api } = await appClient({
			onResponse: [
				() => {
					throw new Error("onResponse exploded")
				},
			],
		})
		await expect(api.safe.get("/api/health")).rejects.toThrow("onResponse exploded")
	})

	// v0: 0a068156a1
	it("runs onRequest then onResponse around one request", async () => {
		const log: string[] = []
		const { api, calls } = await appClient({
			onRequest: [
				(ctx: RequestCtx) => {
					ctx.headers.set("x-correlation-id", "corr-123")
					log.push("req:corr-123")
				},
			],
			onResponse: [(ctx: ResponseCtx) => void log.push(`res:${ctx.response.status}`)],
		})
		await api.get("/test")
		expect([log, calls[0]?.headers.get("x-correlation-id")]).toEqual([["req:corr-123", "res:200"], "corr-123"])
	})
})

describe("onResponse ctx.retry(): sends the request once more and resolves with that response", () => {
	// v0: 8aa7cffa7b
	it("re-executes the request, resolving the call with the retried response", async () => {
		const { api, calls } = await appClient({ onResponse: [retry401] }, sequence(unauthorized, ok))
		expect([await api.get("/protected"), calls.length]).toEqual([{ ok: true }, 2])
	})

	// v0: 93914e46dc
	it("marks the retried response's hook run with isRetry", async () => {
		const flags: boolean[] = []
		const onResponse = [(ctx: ResponseCtx) => void flags.push(ctx.isRetry), retry401]
		const { api } = await appClient({ onResponse }, sequence(unauthorized, ok))
		await api.get("/test")
		expect(flags).toEqual([false, true])
	})

	// v0: 172daa7492
	it("retries at most once: a persistent 401 ends as the 401", async () => {
		const { UnauthorizedError } = (await emittedApp()) as unknown as { UnauthorizedError: new () => Error }
		const onResponse = [(ctx: ResponseCtx) => (ctx.response.status === 401 ? ctx.retry() : undefined)]
		const { api, calls } = await appClient({ onResponse }, unauthorized)
		const error = await api.get("/test").catch((e: unknown) => e)
		expect([error instanceof UnauthorizedError, calls.length]).toEqual([true, 2])
	})

	// v0: 0166027e04
	it("resolves config headers again for the retry", async () => {
		let attempt = 0
		const headers = () => (++attempt === 1 ? {} : { authorization: "Bearer test" })
		const { api, calls } = await appClient({ headers, onResponse: [retry401] }, (request) =>
			request.headers.get("authorization") === "Bearer test" ? Response.json({ total: 1 }) : unauthorized(),
		)
		expect([await api.get("/api/v1/organizations"), attempt, calls.length]).toEqual([{ total: 1 }, 2, 2])
	})
})

describe("onResponse ctx.retry(): the retried response, whatever its status", () => {
	// v0: 8431234181
	it("answers a retried error response as the safe twin's Err instead of throwing", async () => {
		const onResponse = [(ctx: ResponseCtx) => (ctx.response.status === 429 ? ctx.retry() : undefined)]
		const { api } = await appClient(
			{ onResponse },
			sequence(
				() => Response.json({}, { status: 429 }),
				() => Response.json({ message: "down" }, { status: 500 }),
			),
		)
		const result = await api.safe.get("/x")
		expect([result.ok, result.response.status, result.error.message]).toEqual([false, 500, "HTTP 500: down"])
	})

	// v0: f4ef77abba
	it("resolves retry() with the retried 200 in a generated SDK", async () => {
		const retried: Response[] = []
		const onResponse = [
			async (ctx: ResponseCtx) => void (ctx.response.status === 429 ? retried.push(await ctx.retry()) : undefined),
		]
		const { calls, safe } = await itemsSdk(
			{ onResponse },
			sequence(
				() => new Response(null, { status: 429 }),
				() => Response.json({ id: "1" }),
			),
		)
		/* the hook keeps the 429 it was given, so the call answers it: the safe twin's Err */
		const result = await safe.get({ params: { id: "1" } })
		expect([retried.map((response) => response.status), calls.length, result.response.status]).toEqual([[200], 2, 429])
	})

	// v0: 069d6deb4e
	it("resolves retry() with the retried response whatever its status, and the safe twin answers it as its Err", async () => {
		const retried: number[] = []
		const onResponse = [
			async (ctx: ResponseCtx) => {
				if (ctx.response.status !== 429) return undefined
				const again = await ctx.retry()
				retried.push(again.status)
				return again
			},
		]
		const { safe } = await itemsSdk(
			{ onResponse },
			sequence(
				() => Response.json({ message: "rate limited" }, { status: 429 }),
				() => Response.json({ message: "upstream failed" }, { status: 500 }),
			),
		)
		const result = await safe.get({ params: { id: "1" } })
		expect([retried, result.ok, result.response.status, result.error.body]).toEqual([
			[500],
			false,
			500,
			{ message: "upstream failed" },
		])
	})
})

/** An onLog entry's fields for `GET path`, its duration read as a type. */
const op = (path: string) => ({ duration_ms: "number", operation: `GET ${path}` })

describe("onLog (Q1): an entry at each exchange's start, answer and failure", () => {
	it("logs the start, the answer by level and status, and a failed send with its error", async () => {
		const entries: Json[] = []
		const onLog = (entry: Json) => void entries.push({ ...entry, duration_ms: typeof entry.duration_ms })
		const { api } = await appClient({ onLog }, (request) =>
			request.url.endsWith("/missing") ? Response.json({}, { status: 404 }) : Response.json({}),
		)
		await api.get("/ok")
		await api.safe.get("/missing")
		const broken = await appClient({ onLog }, () => Promise.reject(new TypeError("offline")))
		await broken.api.get("/down").catch(() => {})
		expect(entries).toEqual([
			{ ...op("/ok"), event: "request_start", level: "debug" },
			{ ...op("/ok"), event: "response_received", level: "info", status: 200 },
			{ ...op("/missing"), event: "request_start", level: "debug" },
			{ ...op("/missing"), event: "response_received", level: "warn", status: 404 },
			{ ...op("/down"), event: "request_start", level: "debug" },
			{
				...op("/down"),
				error: expect.objectContaining({ cause: new TypeError("offline"), name: "APIConnectionError" }),
				event: "error",
				level: "error",
			},
		])
	})
})
