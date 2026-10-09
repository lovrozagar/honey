import { describe, expect, it } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"

type Client = Record<string, unknown> & { dispose(): void; state: Record<string, unknown> }
type ClientCtor = new (config: Record<string, unknown>) => Client

async function load(spec: Record<string, unknown>): Promise<ClientCtor> {
	const { files } = generateSDK(spec as never, { name: "FixSDK", stem: "sdk" })
	const clientBody = files.client.replace(/^import type \{[^\n]+\n/, "").replace(/^import \{[^\n]+\n/, "")
	const { transform } = await import("esbuild")
	const { code } = await transform(`${files.map}\n${clientBody}`, { format: "esm", loader: "ts", target: "esnext" })
	const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
		FixSDK: ClientCtor
	}
	return mod.FixSDK
}

function doc(paths: Record<string, unknown>, components?: Record<string, unknown>): Record<string, unknown> {
	return { components, info: { title: "t", version: "1" }, openapi: "3.1.0", paths }
}

const OK = { "200": { content: { "application/json": { schema: { type: "object" } } }, description: "ok" } }
const SSE = { "200": { content: { "text/event-stream": { schema: { type: "string" } } }, description: "ok" } }

function recorder(make: () => Response = () => Response.json({ ok: true })) {
	const calls: Array<{ init: RequestInit; url: string }> = []
	return {
		calls,
		fetch: async (url: string, init: RequestInit) => {
			if (init.body instanceof ReadableStream) await new Response(init.body).arrayBuffer()
			calls.push({ init, url })
			return make()
		},
	}
}

describe("streamed operations send their request (H37b)", () => {
	it("a POST SSE operation sends its JSON body and runs onRequest/onResponse hooks", async () => {
		const SDK = await load(
			doc({
				"/chat": {
					post: {
						operationId: "chat",
						requestBody: { content: { "application/json": { schema: { type: "object" } } }, required: true },
						responses: SSE,
					},
				},
			}),
		)
		const seen: string[] = []
		const { calls, fetch } = recorder(
			() => new Response("data: hi\n\n", { headers: { "content-type": "text/event-stream" } }),
		)
		const sdk = new SDK({
			baseURL: "https://api.example.com",
			fetch,
			onRequest: [(ctx: { headers: Headers }) => void ctx.headers.set("authorization", "Bearer t")],
			onResponse: [() => void seen.push("response")],
		})
		const events: unknown[] = []
		for await (const e of (sdk.chat as (i: unknown) => AsyncIterable<unknown>)({ json: { q: "hello" } })) events.push(e)
		expect(events).toEqual([{ data: "hi" }])
		expect(calls[0].init.method).toBe("POST")
		expect(calls[0].init.body).toBe('{"q":"hello"}')
		expect(new Headers(calls[0].init.headers).get("content-type")).toBe("application/json")
		expect(new Headers(calls[0].init.headers).get("authorization")).toBe("Bearer t")
		expect(seen).toEqual(["response"])
	})
})

describe("stream request bodies", () => {
	it("send with duplex: half, and an onResponse hook still gets a Request", async () => {
		const SDK = await load(
			doc({
				"/upload": {
					post: {
						operationId: "upload",
						requestBody: { content: { "application/octet-stream": { schema: { format: "binary", type: "string" } } } },
						responses: OK,
					},
				},
			}),
		)
		let hookRequest: Request | undefined
		const { calls, fetch } = recorder()
		const sdk = new SDK({
			baseURL: "https://api.example.com",
			fetch,
			onResponse: [(ctx: { request: Request }) => void (hookRequest = ctx.request)],
			throwOnError: true,
		})
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(new Uint8Array([1, 2, 3]))
				c.close()
			},
		})
		await (sdk.upload as (i: unknown) => Promise<unknown>)({ body })
		expect((calls[0].init as RequestInit & { duplex?: string }).duplex).toBe("half")
		expect(hookRequest).toBeInstanceOf(Request)
	})
})

describe("idempotency keys", () => {
	it("are never written into the caller's input, so a reused input gets a fresh key", async () => {
		const SDK = await load(doc({ "/pay": { post: { operationId: "pay", responses: OK, "x-idempotency-key": true } } }))
		const { calls, fetch } = recorder()
		const sdk = new SDK({ baseURL: "https://api.example.com", fetch })
		const input: Record<string, unknown> = {}
		await (sdk.pay as (i: unknown) => Promise<unknown>)(input)
		await (sdk.pay as (i: unknown) => Promise<unknown>)(input)
		expect(input).toEqual({})
		const keys = calls.map((c) => new Headers(c.init.headers).get("idempotency-key"))
		expect(keys[0]).toBeTruthy()
		expect(keys[0]).not.toBe(keys[1])
	})
})

describe("resource names never shadow the client or Object.prototype", () => {
	const spec = doc({
		"/d": { post: { operationId: "dispose", responses: OK } },
		"/s": { get: { operationId: "state.get", responses: OK } },
		"/t": { get: { operationId: "then.run", responses: OK } },
		"/u": { get: { operationId: "toString", responses: OK } },
	})

	it("renames colliding resources consistently in the types and the map", () => {
		const { files } = generateSDK(spec as never, { name: "FixSDK" })
		expect(files.types).toContain("state_: {")
		expect(files.types).toContain("dispose_(")
		expect(files.types).toContain("then_: {")
		expect(files.types).toContain("toString_(")
		expect(files.map).toContain("state_:")
		expect(files.map).not.toMatch(/^\tthen:/m)
	})

	it("keeps state, dispose and String(sdk) working, and the client is not a thenable", async () => {
		const SDK = await load(spec)
		const { calls, fetch } = recorder()
		const sdk = new SDK({ baseURL: "https://api.example.com", fetch, state: { a: 1 } })
		expect(sdk.state).toEqual({ a: 1 })
		expect(typeof sdk.dispose).toBe("function")
		expect(String(sdk)).toBe("[object Object]")
		expect((sdk as { then?: unknown }).then).toBeUndefined()
		await (sdk.state_ as { get: (i?: unknown) => Promise<unknown> }).get()
		expect(calls[0].url).toBe("https://api.example.com/s")
		/* a namespace proxy stringifies too */
		expect(String(sdk.then_)).toBe("[object Object]")
	})

	it("an operationId of __proto__.x never reaches Object.prototype during generation", () => {
		generateSDK(doc({ "/p": { get: { operationId: "__proto__.polluted", responses: OK } } }) as never)
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
	})
})

describe("generation inputs", () => {
	it("rejects an SDK name or stem that is not safe in source", () => {
		const spec = doc({ "/a": { get: { operationId: "a", responses: OK } } })
		expect(() => generateSDK(spec as never, { name: "My SDK" })).toThrow(/identifier/)
		expect(() => generateSDK(spec as never, { stem: '../x"' })).toThrow(/file name/)
	})

	it("a `default` response is neither a success type nor an error status", () => {
		const { files } = generateSDK(
			doc({
				"/a": {
					get: {
						operationId: "a",
						responses: {
							"200": { content: { "application/json": { schema: { type: "string" } } }, description: "ok" },
							default: { content: { "application/json": { schema: { type: "number" } } }, description: "err" },
						},
					},
				},
			}) as never,
		)
		expect(files.types).not.toContain("NaN")
		expect(files.types).toContain("Promise<string>")
	})

	it("header and cookie params reach the input type, hyphenated names quoted", () => {
		const { files } = generateSDK(
			doc({
				"/a/{user-id}": {
					get: {
						operationId: "a",
						parameters: [
							{ in: "path", name: "user-id", required: true, schema: { type: "string" } },
							{ in: "header", name: "x-tenant", required: true, schema: { type: "string" } },
							{ in: "cookie", name: "session", schema: { type: "string" } },
						],
						responses: OK,
					},
				},
			}) as never,
		)
		expect(files.types).toContain('params: { "user-id": string }')
		expect(files.types).toContain('headers: { "x-tenant": string }')
		expect(files.types).toContain("cookies: { session?: string }")
	})

	it("an operation without an operationId gets a derived one instead of vanishing", () => {
		const { files } = generateSDK(doc({ "/users/{id}": { get: { responses: OK } } }) as never)
		expect(files.map).toContain("getUsersById")
	})
})

describe("invalidation", () => {
	const spec = doc({
		"/orgs/{org}": {
			put: { operationId: "orgs.update", responses: OK, "x-invalidate": ["GET /orgs/:org/members/:id"] },
		},
		"/orgs/{org}/members/{id}": { get: { operationId: "members.get", responses: OK } },
	})

	it("a partially resolvable target still marks the narrower pattern stale", async () => {
		const SDK = await load(spec)
		const { calls, fetch } = recorder()
		const marks: boolean[] = []
		const sdk = new SDK({
			baseURL: "https://api.example.com",
			fetch,
			invalidation: { staleTime: 60_000 },
			onRequest: [(ctx: { isStale?: boolean }) => void marks.push(ctx.isStale === true)],
		})
		const orgs = sdk.orgs as { update: (i: unknown) => Promise<unknown> }
		const members = sdk.members as { get: (i: unknown) => Promise<unknown> }
		await orgs.update({ params: { org: "acme" } })
		await members.get({ params: { id: "1", org: "acme" } })
		await members.get({ params: { id: "1", org: "other" } })
		expect(calls).toHaveLength(3)
		/* acme's members are stale; another org's are not */
		expect(marks).toEqual([false, true, false])
	})

	it("one concrete read clears its own share of a pattern mark, not every instance's", async () => {
		const SDK = await load(spec)
		const { fetch } = recorder()
		const marks: Array<[string, boolean]> = []
		const sdk = new SDK({
			baseURL: "https://api.example.com",
			fetch,
			invalidation: { staleTime: 60_000 },
			onRequest: [
				(ctx: { isStale?: boolean; path: string; url: string }) => void marks.push([ctx.url, ctx.isStale === true]),
			],
		})
		const orgs = sdk.orgs as { update: (i: unknown) => Promise<unknown> }
		const members = sdk.members as { get: (i: unknown) => Promise<unknown> }
		await orgs.update({ params: { org: "acme" } })
		await members.get({ params: { id: "1", org: "acme" } })
		await members.get({ params: { id: "1", org: "acme" } })
		await members.get({ params: { id: "2", org: "acme" } })
		expect(marks.slice(1).map(([, stale]) => stale)).toEqual([true, false, true])
	})
})

describe("behavior spec: errors, timeouts, auth refresh, redirects", () => {
	const spec = doc({
		"/a": { get: { operationId: "a", responses: OK } },
		"/b": { post: { operationId: "b", responses: OK } },
	})

	it("safe mode always returns a truthy error for a failed request, whatever the body", async () => {
		const SDK = await load(spec)
		const sdk = new SDK({
			baseURL: "https://api.example.com",
			fetch: async () =>
				new Response("<html>bad gateway</html>", { headers: { "content-type": "text/html" }, status: 502 }),
		})
		const r = (await (sdk.a as () => Promise<{ error: { status?: number } | null; status: number }>)()) as {
			error: { status?: number } | null
			status: number
		}
		expect(r.status).toBe(502)
		expect(r.error).toBeTruthy()
		expect(r.error?.status).toBe(502)
	})

	it("the request timeout covers reading the body", async () => {
		const SDK = await load(spec)
		const sdk = new SDK({
			baseURL: "https://api.example.com",
			fetch: async (_url: string, init: RequestInit) =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"a":'))
							init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason))
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
			throwOnError: true,
			timeout: 50,
		})
		const started = Date.now()
		await expect((sdk.a as () => Promise<unknown>)()).rejects.toBeTruthy()
		expect(Date.now() - started).toBeLessThan(2000)
	})

	it("concurrent 401s share one refresh, and the new token is used afterwards", async () => {
		const SDK = await load(spec)
		let refreshes = 0
		const seen: Array<string | null> = []
		const sdk = new SDK({
			baseURL: "https://api.example.com",
			fetch: async (_url: string, init: RequestInit) => {
				const auth = new Headers(init.headers).get("authorization")
				seen.push(auth)
				return auth === "Bearer fresh" ? Response.json({ ok: true }) : new Response(null, { status: 401 })
			},
			headers: { authorization: "Bearer stale" },
			onAuthExpired: async () => {
				refreshes++
				await new Promise((r) => setTimeout(r, 10))
				return "fresh"
			},
		})
		const call = sdk.a as () => Promise<{ status: number }>
		const results = await Promise.all([call(), call(), call()])
		expect(results.map((r) => r.status)).toEqual([200, 200, 200])
		expect(refreshes).toBe(1)
		const before = seen.length
		await call()
		/* the stored token goes out first: no 401 round trip */
		expect(seen.slice(before)).toEqual(["Bearer fresh"])
	})

	it("redirects: same-origin by default, cross-origin returned unfollowed", async () => {
		const SDK = await load(spec)
		const urls: string[] = []
		const sdk = new SDK({
			baseURL: "https://api.example.com",
			fetch: async (url: string) => {
				urls.push(url)
				if (url.endsWith("/a")) return new Response(null, { headers: { location: "/a2" }, status: 302 })
				if (url.endsWith("/a2"))
					return new Response(null, { headers: { location: "https://evil.example/x" }, status: 302 })
				return Response.json({})
			},
			headers: { "x-api-key": "secret" },
		})
		const r = (await (sdk.a as () => Promise<{ status: number }>)()) as { status: number }
		expect(urls).toEqual(["https://api.example.com/a", "https://api.example.com/a2"])
		expect(r.status).toBe(302)
	})
})
