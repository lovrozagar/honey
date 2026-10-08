import { describe, expect, it, vi } from "vitest"
import { createClient, PathParamError, UnauthorizedError } from "../../../src/client/index.ts"
import { ClientError } from "../../../src/client/error.ts"
import { HTTPClient } from "../../../src/client/http.ts"
import { createSDK } from "../../../src/client/sdk.ts"

type Call = { init: RequestInit; url: string }

function recorder(respond: (call: Call, n: number) => Response | Promise<Response>) {
	const calls: Call[] = []
	const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const call = { init: init ?? {}, url: String(input) }
		calls.push(call)
		return respond(call, calls.length - 1)
	}) as unknown as typeof globalThis.fetch
	return { calls, fetch }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, status })

const sse = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } })

const headersOf = (call: Call | undefined) => new Headers(call?.init.headers)

describe("URL building (H35)", () => {
	it("refuses dot-segment and empty params instead of retargeting the request", async () => {
		const { calls, fetch } = recorder(() => json({}))
		const api = createClient({ baseURL: "https://api.example.com", fetch, headers: { authorization: "Bearer t" } })
		const del = api.delete as unknown as (p: string, i: unknown) => Promise<{ error: unknown }>
		await expect(
			del("/orgs/:org/projects/:pid/files/:fid", { params: { fid: "..", org: "acme", pid: "p1" } }),
		).rejects.toThrow(PathParamError)
		const get = api.get as unknown as (p: string, i: unknown) => Promise<unknown>
		await expect(get("/:org/:repo", { params: { org: "", repo: "evil.example" } })).rejects.toThrow(PathParamError)
		expect(calls).toHaveLength(0)
	})

	it("$url and $path agree and keep the base path", () => {
		const api = createClient({ baseURL: "https://api.example.com/v1", fetch: vi.fn() as unknown as typeof fetch })
		const url = (api.$url as (p: string, i: unknown) => string)("/users/:id", { params: { id: "a/b" } })
		const path = (api.$path as (p: string, i: unknown) => string)("/users/:id", { params: { id: "a/b" } })
		expect(url).toBe("https://api.example.com/v1/users/a%2Fb")
		expect(path).toBe("/users/a%2Fb")
	})
})

describe("Headers", () => {
	it("skips undefined per-call headers and keeps one Authorization", async () => {
		const { calls, fetch } = recorder(() => json({}))
		const api = createClient({ baseURL: "https://x", fetch, headers: { Authorization: "Bearer a" } })
		await (api.get as unknown as (p: string, i: unknown) => Promise<unknown>)("/p", {
			headers: { authorization: "Bearer b", "x-maybe": undefined },
		})
		const h = headersOf(calls[0])
		expect(h.get("authorization")).toBe("Bearer b")
		expect(h.has("x-maybe")).toBe(false)
	})

	it("requestId: false sends no x-request-id (no CORS preflight)", async () => {
		const { calls, fetch } = recorder(() => json({}))
		const api = createClient({ baseURL: "https://x", fetch, requestId: false })
		await (api.get as unknown as (p: string) => Promise<unknown>)("/p")
		expect(headersOf(calls[0]).has("x-request-id")).toBe(false)
	})
})

describe("Timeouts and abort", () => {
	function slowBody(ms: number): Response {
		return new Response(
			new ReadableStream({
				async start(c) {
					c.enqueue(new TextEncoder().encode('{"a":'))
					await new Promise((r) => setTimeout(r, ms))
					c.enqueue(new TextEncoder().encode("1}"))
					c.close()
				},
			}),
			{ headers: { "content-type": "application/json" } },
		)
	}

	/* A fetch that honors the signal while the body is read, like the platform fetch. */
	function signalAwareFetch(make: () => Response) {
		return (async (_url: RequestInfo | URL, init?: RequestInit) => {
			const res = make()
			const reader = res.body!.getReader()
			const signal = init?.signal
			const body = new ReadableStream({
				async pull(c) {
					if (signal?.aborted) {
						c.error(signal.reason)
						return
					}
					const abort = new Promise<never>((_, reject) =>
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
					)
					try {
						const { done, value } = await Promise.race([reader.read(), abort])
						if (done) c.close()
						else c.enqueue(value)
					} catch (e) {
						c.error(e)
					}
				},
			})
			return new Response(body, { headers: res.headers, status: res.status })
		}) as typeof fetch
	}

	it("the timeout covers reading the body", async () => {
		const api = createClient({ baseURL: "https://x", fetch: signalAwareFetch(() => slowBody(2000)), timeout: 50 })
		const started = Date.now()
		const result = (await (api.get as unknown as (p: string) => Promise<{ error: unknown }>)("/slow")) as {
			error: unknown
		}
		expect(result.error).toBeTruthy()
		expect(Date.now() - started).toBeLessThan(1000)
	})

	it("per-call timeout overrides the config", async () => {
		const api = createClient({
			baseURL: "https://x",
			fetch: signalAwareFetch(() => slowBody(2000)),
			throwOnError: true,
		})
		await expect(
			(api.get as unknown as (p: string, i: unknown) => Promise<unknown>)("/slow", { timeout: 30 }),
		).rejects.toMatchObject({ name: "TimeoutError" })
	})

	it("a user abort after headers still cancels the body read when a timeout is set", async () => {
		const api = createClient({
			baseURL: "https://x",
			fetch: signalAwareFetch(() => slowBody(2000)),
			throwOnError: true,
			timeout: 10_000,
		})
		const ctrl = new AbortController()
		const p = (api.get as unknown as (p: string, i: unknown) => Promise<unknown>)("/slow", { signal: ctrl.signal })
		setTimeout(() => ctrl.abort(new Error("user")), 30)
		const started = Date.now()
		await expect(p).rejects.toThrow("user")
		expect(Date.now() - started).toBeLessThan(1000)
	})
})

describe("Auth refresh (H38)", () => {
	it("refreshes once on 401, retries with the new token and keeps it for later calls", async () => {
		const { calls, fetch } = recorder((call) =>
			headersOf(call).get("authorization") === "Bearer fresh" ? json({ ok: true }) : json({ message: "no" }, 401),
		)
		const onAuthExpired = vi.fn(async () => "fresh")
		const api = createClient({ baseURL: "https://x", fetch, headers: { authorization: "Bearer stale" }, onAuthExpired })
		const get = api.get as unknown as (p: string) => Promise<{ data: unknown }>
		expect((await get("/a")).data).toEqual({ ok: true })
		expect((await get("/b")).data).toEqual({ ok: true })
		expect(onAuthExpired).toHaveBeenCalledTimes(1)
		expect(onAuthExpired).toHaveBeenCalledWith({ rejectedToken: "stale" })
		expect(calls.map((c) => headersOf(c).get("authorization"))).toEqual([
			"Bearer stale",
			"Bearer fresh",
			"Bearer fresh",
		])
	})

	it("concurrent 401s share one refresh", async () => {
		const { fetch } = recorder((call) =>
			headersOf(call).get("authorization") === "Bearer fresh" ? json({}) : json({}, 401),
		)
		let resolveToken!: (t: string) => void
		const onAuthExpired = vi.fn(() => new Promise<string>((r) => (resolveToken = r)))
		const api = createClient({ baseURL: "https://x", fetch, headers: { authorization: "Bearer stale" }, onAuthExpired })
		const get = api.get as unknown as (p: string) => Promise<{ status: number }>
		const all = Promise.all([get("/1"), get("/2"), get("/3")])
		await vi.waitFor(() => expect(onAuthExpired).toHaveBeenCalled())
		resolveToken("fresh")
		expect((await all).map((r) => r.status)).toEqual([200, 200, 200])
		expect(onAuthExpired).toHaveBeenCalledTimes(1)
	})

	it("null or empty token gives up without an unauthenticated retry", async () => {
		const { calls, fetch } = recorder(() => json({}, 401))
		const api = createClient({ baseURL: "https://x", fetch, onAuthExpired: async () => "", throwOnError: true })
		await expect((api.get as unknown as (p: string) => Promise<unknown>)("/a")).rejects.toBeInstanceOf(
			UnauthorizedError,
		)
		expect(calls).toHaveLength(1)
	})

	it("a stream body is not retried", async () => {
		const { calls, fetch } = recorder(() => json({}, 401))
		const http = new HTTPClient({ baseURL: "https://x", fetch, onAuthExpired: async () => "fresh" })
		const result = await http.requestSafe("POST", "/up", {
			json: undefined,
			headers: {},
			form: undefined,
		} as never)
		expect(result.status).toBe(401)
		expect(calls).toHaveLength(2)
		const { calls: c2, fetch: f2 } = recorder(() => json({}, 401))
		const streaming = new HTTPClient({
			baseURL: "https://x",
			fetch: f2,
			onAuthExpired: async () => "fresh",
			onRequest: [
				(ctx) => {
					ctx.body = new ReadableStream({ start: (c) => c.close() })
				},
			],
		})
		const r2 = await streaming.requestSafe("POST", "/up", {})
		expect(r2.status).toBe(401)
		expect(c2).toHaveLength(1)
	})
})

describe("Errors (H36)", () => {
	it("safe mode: every non-2xx has a truthy error with the status", async () => {
		for (const response of [
			() => new Response("<html>bad gateway</html>", { headers: { "content-type": "text/html" }, status: 502 }),
			() => new Response(null, { status: 503 }),
			() => json(null, 500),
		]) {
			const api = createClient({ baseURL: "https://x", fetch: (async () => response()) as typeof fetch })
			const result = (await (api.get as unknown as (p: string) => Promise<unknown>)("/x")) as {
				error: { status: number }
				status: number
			}
			expect(result.error).toBeTruthy()
			expect(result.error.status).toBe(result.status)
		}
	})

	it("throw mode: per-status subclasses", async () => {
		const api = createClient({
			baseURL: "https://x",
			fetch: (async () => json({ message: "who\u0007" }, 401)) as typeof fetch,
			throwOnError: true,
		})
		const error = await (api.get as unknown as (p: string) => Promise<unknown>)("/x").catch((e: unknown) => e)
		expect(error).toBeInstanceOf(UnauthorizedError)
		expect(error).toBeInstanceOf(ClientError)
		expect((error as Error).message).toBe("who")
	})

	it("empty or invalid 2xx bodies keep the status", async () => {
		const empty = createClient({
			baseURL: "https://x",
			fetch: (async () =>
				new Response("", { headers: { "content-type": "application/json" }, status: 201 })) as typeof fetch,
			throwOnError: true,
		})
		expect(await (empty.post as unknown as (p: string) => Promise<unknown>)("/x")).toBeNull()

		const invalid = createClient({
			baseURL: "https://x",
			fetch: (async () => new Response("{oops", { headers: { "content-type": "application/json" } })) as typeof fetch,
			throwOnError: true,
		})
		await expect((invalid.get as unknown as (p: string) => Promise<unknown>)("/x")).rejects.toMatchObject({
			status: 200,
		})

		const untyped = createClient({
			baseURL: "https://x",
			fetch: (async () => new Response(null, { status: 200 })) as typeof fetch,
			throwOnError: true,
		})
		expect(await (untyped.get as unknown as (p: string) => Promise<unknown>)("/x")).toBeNull()

		const xml = createClient({
			baseURL: "https://x",
			fetch: (async () => new Response("<a/>", { headers: { "content-type": "application/xml" } })) as typeof fetch,
			throwOnError: true,
		})
		expect(await (xml.get as unknown as (p: string) => Promise<unknown>)("/x")).toBe("<a/>")
	})
})

describe("ctx.retry()", () => {
	it("an unguarded hook on a persistent 401 ends with the 401, not 'Max 1 retry'", async () => {
		const { calls, fetch } = recorder(() => json({ message: "nope" }, 401))
		const api = createClient({
			baseURL: "https://x",
			fetch,
			onResponse: [(ctx) => (ctx.response.status === 401 ? ctx.retry() : undefined)],
			throwOnError: true,
		})
		await expect((api.get as unknown as (p: string) => Promise<unknown>)("/x")).rejects.toBeInstanceOf(
			UnauthorizedError,
		)
		expect(calls).toHaveLength(2)
	})

	it("a guarded hook in safe mode returns { error } instead of throwing", async () => {
		const { fetch } = recorder((_, n) => (n === 0 ? json({}, 429) : json({ message: "down" }, 500)))
		const api = createClient({
			baseURL: "https://x",
			fetch,
			onResponse: [(ctx) => (ctx.response.status === 429 ? ctx.retry() : undefined)],
		})
		const result = (await (api.get as unknown as (p: string) => Promise<unknown>)("/x")) as {
			error: { message: string }
			status: number
		}
		expect(result.status).toBe(500)
		expect(result.error.message).toBe("down")
	})
})

describe("Streams (H37) and the lazy call", () => {
	it("a streamed POST carries its body and runs onRequest/onResponse", async () => {
		const { calls, fetch } = recorder(() => sse("data: 1\n\n"))
		const seen: string[] = []
		const api = createClient({
			baseURL: "https://x",
			fetch,
			onRequest: [(ctx) => void ctx.headers.set("authorization", "Bearer hook")],
			onResponse: [(ctx) => void seen.push(ctx.response.headers.get("content-type") ?? "")],
		})
		const events: unknown[] = []
		const call = (api.post as unknown as (p: string, i: unknown) => AsyncIterable<{ data: string }>)("/chat", {
			json: { q: "hi" },
		})
		for await (const e of call) events.push(e.data)
		expect(events).toEqual(["1"])
		expect(calls[0]?.init.body).toBe('{"q":"hi"}')
		expect(headersOf(calls[0]).get("authorization")).toBe("Bearer hook")
		expect(headersOf(calls[0]).get("accept")).toBe("text/event-stream")
		expect(seen).toEqual(["text/event-stream"])
	})

	it("awaiting an SSE call resolves to an iterable instead of buffering the stream", async () => {
		const { calls, fetch } = recorder(
			() =>
				new Response(
					new ReadableStream({
						start(c) {
							c.enqueue(new TextEncoder().encode("data: a\n\n"))
							/* never closes: buffering it as text would hang */
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				),
		)
		const api = createClient({ baseURL: "https://x", fetch, timeout: 50 })
		async function open() {
			return (api.get as unknown as (p: string) => Promise<AsyncIterable<{ data: string }>>)("/events")
		}
		const stream = await open()
		for await (const e of stream) {
			expect(e.data).toBe("a")
			break
		}
		expect(calls).toHaveLength(1)
	})

	it("await then for-await reuses the one request", async () => {
		const { calls, fetch } = recorder(() => sse("data: a\n\ndata: b\n\n"))
		const api = createClient({ baseURL: "https://x", fetch })
		const call = (api.get as unknown as (p: string) => Promise<unknown> & AsyncIterable<{ data: string }>)("/events")
		await call
		const seen: string[] = []
		for await (const e of call) seen.push(e.data)
		expect(seen).toEqual(["a", "b"])
		expect(calls).toHaveLength(1)
	})
})

describe("Redirects", () => {
	it("follows same-origin redirects and refuses cross-origin ones by default", async () => {
		const { calls, fetch } = recorder((call) => {
			if (call.url.endsWith("/old")) return new Response(null, { headers: { location: "/v1/new" }, status: 308 })
			if (call.url.endsWith("/leave"))
				return new Response(null, { headers: { location: "https://evil.example/x" }, status: 307 })
			return json({ ok: 1 })
		})
		const api = createClient({ baseURL: "https://api.example.com/v1", fetch, headers: { "x-api-key": "k" } })
		const get = api.get as unknown as (p: string) => Promise<{ data: unknown; status: number }>
		expect((await get("/old")).data).toEqual({ ok: 1 })
		expect(calls[1]?.url).toBe("https://api.example.com/v1/new")
		expect(calls[0]?.init.redirect).toBe("manual")
		const leave = await get("/leave")
		expect(leave.status).toBe(307)
		expect(calls.some((c) => c.url.startsWith("https://evil.example"))).toBe(false)
	})

	it("`follow` strips credentials and configured headers on a cross-origin hop", async () => {
		const { calls, fetch } = recorder((call) =>
			call.url.startsWith("https://api.example.com")
				? new Response(null, { headers: { location: "https://cdn.example/f" }, status: 302 })
				: json({}),
		)
		const api = createClient({
			baseURL: "https://api.example.com",
			fetch,
			headers: { authorization: "Bearer t", "x-api-key": "k" },
			redirect: "follow",
		})
		await (api.get as unknown as (p: string) => Promise<unknown>)("/file")
		const h = headersOf(calls[1])
		expect(calls[1]?.url).toBe("https://cdn.example/f")
		expect(h.has("authorization")).toBe(false)
		expect(h.has("x-api-key")).toBe(false)
	})
})

describe("Form encoding", () => {
	it("arrays repeat the key in both encodings; nested objects are rejected", async () => {
		const { calls, fetch } = recorder(() => json({}))
		const api = createClient({ baseURL: "https://x", fetch })
		const post = api.post as unknown as (p: string, i: unknown) => Promise<unknown>
		await post("/f", { form: { tags: ["a", "b"] } })
		expect(calls[0]?.init.body).toBe("tags=a&tags=b")
		await post("/f", { form: { file: new Blob(["x"]), tags: ["a", "b"] } })
		const multipart = calls[1]?.init.body
		expect(multipart).toBeInstanceOf(FormData)
		expect((multipart as FormData).getAll("tags")).toEqual(["a", "b"])
		await expect(post("/f", { form: { nested: { a: 1 } } })).rejects.toThrow(/nested objects/)
	})
})

describe("Client and SDK objects", () => {
	it("are printable and not thenable", async () => {
		const api = createClient({ baseURL: "https://x", fetch: vi.fn() as unknown as typeof fetch })
		expect(String(api)).toBe("[object HoneyClient]")
		const sdk = createSDK({ users: { list: { method: "GET", path: "/users" } } }, { baseURL: "https://x" })
		expect(String(sdk)).toBe("[object HoneySDK]")
		expect((sdk as Record<string, unknown>).constructor).toBeUndefined()
		expect(await Promise.resolve(sdk)).toBe(sdk)
	})

	it("SDK paths: hyphenated braces and `{id}:action` interpolate", async () => {
		const { calls, fetch } = recorder(() => json({}))
		const sdk = createSDK(
			{
				ops: { cancel: { method: "POST", path: "/ops/{id}:cancel" } },
				users: { get: { method: "GET", path: "/users/{user-id}" } },
			},
			{ baseURL: "https://x", fetch },
		) as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>
		await sdk.users!.get!({ params: { "user-id": "7" } })
		await sdk.ops!.cancel!({ params: { id: "9" } })
		expect(calls.map((c) => c.url)).toEqual(["https://x/users/7", "https://x/ops/9:cancel"])
	})

	it("partially resolvable invalidation targets mark the narrower pattern", async () => {
		const seen: Array<boolean | undefined> = []
		const sdk = createSDK(
			{
				members: { get: { method: "GET", path: "/orgs/{org}/members/{id}" } },
				orgs: { update: { invalidate: ["GET /orgs/:org/members/:id"], method: "PUT", path: "/orgs/{org}" } },
			},
			{
				baseURL: "https://x",
				fetch: (async () => json({})) as typeof fetch,
				invalidation: { staleTime: 5000 },
				onRequest: [(ctx) => void seen.push(ctx.isStale)],
			},
		) as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>
		await sdk.orgs!.update!({ params: { org: "acme" } })
		await sdk.members!.get!({ params: { id: "1", org: "acme" } })
		await sdk.members!.get!({ params: { id: "1", org: "other" } })
		expect(seen).toEqual([false, true, false])
	})

	it("a concrete key containing ':' is not treated as a pattern", async () => {
		const seen: Array<boolean | undefined> = []
		const sdk = createSDK(
			{
				ops: {
					cancel: { invalidate: ["GET /ops/1:cancel"], method: "POST", path: "/ops/{id}:cancel" },
					get: { method: "GET", path: "/ops/{id}:cancel" },
				},
			},
			{
				baseURL: "https://x",
				fetch: (async () => json({})) as typeof fetch,
				invalidation: { staleTime: 5000 },
				onRequest: [(ctx) => void seen.push(ctx.isStale)],
			},
		) as unknown as Record<string, Record<string, (i: unknown) => Promise<unknown>>>
		await sdk.ops!.cancel!({ params: { id: "1" } })
		await sdk.ops!.get!({ params: { id: "2" } })
		await sdk.ops!.get!({ params: { id: "1" } })
		expect(seen).toEqual([false, false, true])
	})
})
