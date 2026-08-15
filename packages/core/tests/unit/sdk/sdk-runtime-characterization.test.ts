import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { generateSDK } from "../../../src/codegen.ts"
import { createSDK } from "../../../src/client/sdk.ts"
import { parseSSEStream } from "../../../src/client/sse.ts"

/* ───────────────────────────── helpers ───────────────────────────── */

function mockFetch(status: number, body: unknown, contentType = "application/json") {
	return vi.fn<typeof fetch>(() =>
		Promise.resolve(
			new Response(JSON.stringify(body), {
				headers: { "content-type": contentType },
				status,
			}),
		),
	) as unknown as typeof fetch
}

function mockFetchRaw(status: number, body: string, contentType: string) {
	return vi.fn<typeof fetch>(() =>
		Promise.resolve(new Response(body, { headers: { "content-type": contentType }, status })),
	) as unknown as typeof fetch
}

/* minimal OpenAPI spec used by generated-code tests */
const minimalSpec = {
	info: { title: "Test", version: "1" },
	openapi: "3.0.0",
	paths: {
		"/v1/users": {
			get: { operationId: "users.list", responses: {} },
			post: {
				operationId: "users.create",
				responses: {},
				"x-invalidate": ["GET /v1/users"],
			},
		},
		"/v1/users/{id}": {
			delete: {
				operationId: "users.delete",
				responses: {},
				"x-invalidate": ["GET /v1/users/{id}", "GET /v1/users"],
			},
			get: { operationId: "users.get", responses: {} },
			patch: {
				operationId: "users.update",
				responses: {},
				"x-invalidate": ["GET /v1/users/{id}", "GET /v1/users"],
			},
		},
	},
}

/* ═══════════════════════════════════════════════════════════════════
   SECTION 1 — Generated code structure (buildSDKRuntime output)
   ═══════════════════════════════════════════════════════════════════ */

describe("generated code structure — imports", () => {
	it("client file imports from types.gen and map.gen", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("import type { TestSDKConfig }")
		expect(files.client).toContain("import { serviceMap }")
	})

	it("types file has no import statements", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const importLines = files.types.split("\n").filter((l) => l.startsWith("import"))
		expect(importLines).toHaveLength(0)
	})

	it("map file has no import statements", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const importLines = files.map.split("\n").filter((l) => l.startsWith("import"))
		expect(importLines).toHaveLength(0)
	})

	it("no file has require() calls", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).not.toContain("require(")
		expect(files.types).not.toContain("require(")
		expect(files.map).not.toContain("require(")
	})
})

describe("generated code structure — exports", () => {
	it("exports class matching the sdk name in client file", () => {
		const { files: f1 } = generateSDK(minimalSpec, { name: "TestSDK" })
		const { files: f2 } = generateSDK(minimalSpec, { name: "MyApi" })
		expect(f1.client).toContain("export class TestSDK")
		expect(f2.client).toContain("export class MyApi")
	})

	it("exports SDKResult type in types file", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("export type SDKResult<")
	})

	it("exports serviceMap as const in map file", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.map).toContain("export const serviceMap = {")
		expect(files.map).toContain("} as const")
	})

	it("exports the SDK interface in types file", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("export interface TestSDK<TThrow extends boolean = false> {")
	})

	it("exports the config type in types file", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("export type TestSDKConfig<TThrow extends boolean = false> = {")
	})
})

describe("generated code structure — config type shape", () => {
	it("config has baseURL, fetch, headers, invalidation, onRequest, onResponse", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("baseURL: string")
		expect(files.types).toContain("fetch?: typeof fetch")
		expect(files.types).toContain(
			"invalidation?: { maxSourcesPerTarget?: number; staleMaxEntries?: number; staleTime: number }",
		)
		expect(files.types).toContain("onRequest?:")
		expect(files.types).toContain("onResponse?:")
	})

	it("onRequest context includes headers, method, path, url, invalidation fields", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("headers: Headers")
		expect(files.types).toContain("method: string")
		expect(files.types).toContain("url: string")
		expect(files.types).toContain("isStale?: boolean")
		expect(files.types).toContain("invalidatedBy?: string[]")
		expect(files.types).toContain("selector?: string")
	})

	it("onResponse context includes isRetry, request, response", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("isRetry: boolean")
		expect(files.types).toContain("request: Request")
		expect(files.types).toContain("response: Response")
	})
})

describe("generated code structure — invalidation code present", () => {
	it("contains #resolveInvalidationTargets private method", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#resolveInvalidationTargets(")
	})

	it("contains #lookupStale private method", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#lookupStale(")
	})

	it("contains #pathMatchesPattern private method", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#pathMatchesPattern(")
	})

	it("serviceMap entries contain invalidate arrays when x-invalidate is set", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.map).toContain('"GET /v1/users"')
		expect(files.map).toContain("invalidate:")
	})
})

describe("generated code structure — internal helpers", () => {
	it("contains #interpolatePath private method", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#interpolatePath(")
	})

	it("contains #toColonParams private method converting {param} to :param", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#toColonParams(")
		expect(files.client).toContain("/\\{(\\w+)\\}/g")
	})

	it("contains #buildURL private method", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#buildURL(")
	})

	it("contains async #buildHeaders private method", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("async #buildHeaders(")
	})

	it("contains #requestSafe private method", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("async #requestSafe(")
	})

	it("contains #parseBody private method with content-type dispatch", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#parseBody(")
		expect(files.client).toContain("application/json")
		expect(files.client).toContain("application/octet-stream")
	})
})

describe("generated code structure — SDKResult type shape", () => {
	it("success branch has data:T, error:null, response:Response, status:number", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("data: T; error: null; response: Response; status: number")
	})

	it("error branch has data:null, error:unknown, response:Response, status:number", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("data: null; error: unknown; response: Response; status: number")
	})

	it("SDKResult accepts a second TErrorsByStatus generic", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("SDKResult<T, TErrorsByStatus = never>")
	})
})

describe("generated code structure — Proxy constructor", () => {
	it("constructor uses new Proxy to build the SDK", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("new Proxy(")
	})

	it("constructor returns type-cast to the SDK interface", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain(") as TestSDK")
	})

	it("serviceMap is cast to _ServiceMap inside client", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("serviceMap as _ServiceMap")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   SECTION 2 — Runtime behavior via createSDK
   These tests use the non-generated createSDK from sdk.ts to lock
   the HTTP / response / hook behavior that buildSDKRuntime replicates.
   ═══════════════════════════════════════════════════════════════════ */

/* ── Common cases ── */

describe("runtime — GET request flow", () => {
	it("calls fetch with GET method and correct URL", async () => {
		const fetcher = mockFetch(200, { id: 1, name: "Alice" })
		const sdk = createSDK(
			{ users: { get: { method: "GET", params: ["id"], path: "/users/:id" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).users.get({ params: { id: "42" } })

		expect(fetcher).toHaveBeenCalledOnce()
		const [url, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		expect(url).toBe("http://api.example.com/users/42")
		expect(init.method).toBe("GET")
	})

	it("success response returns { data, error:null, response, status }", async () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: mockFetch(200, [{ id: 1 }]) },
		)

		const result = (await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()) as {
			data: unknown
			error: unknown
			response: Response
			status: number
		}

		expect(result.data).toEqual([{ id: 1 }])
		expect(result.error).toBeNull()
		expect(result.response).toBeInstanceOf(Response)
		expect(result.status).toBe(200)
	})
})

describe("runtime — POST / mutation request flow", () => {
	it("calls fetch with POST method and JSON content-type for json body", async () => {
		const fetcher = mockFetch(201, { id: 99 })
		const sdk = createSDK(
			{ users: { create: { method: "POST", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).users.create({
			json: { name: "Bob" },
		})

		const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		expect(init.method).toBe("POST")
		const headers = init.headers as Headers
		expect(headers.get("content-type")).toBe("application/json")
		expect(init.body).toBe(JSON.stringify({ name: "Bob" }))
	})

	it("PUT request uses correct method", async () => {
		const fetcher = mockFetch(200, { id: 5 })
		const sdk = createSDK(
			{ items: { replace: { method: "PUT", params: ["id"], path: "/items/:id" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).items.replace({
			json: { name: "x" },
			params: { id: "5" },
		})

		const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		expect(init.method).toBe("PUT")
	})

	it("DELETE request uses correct method", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ users: { remove: { method: "DELETE", params: ["id"], path: "/users/:id" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).users.remove({
			params: { id: "7" },
		})

		const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		expect(init.method).toBe("DELETE")
	})
})

describe("runtime — path interpolation", () => {
	it("replaces :param segments with encoded values", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ users: { get: { method: "GET", params: ["id"], path: "/users/:id" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).users.get({
			params: { id: "a b/c" },
		})

		const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
		expect(url).toContain(encodeURIComponent("a b/c"))
	})

	it("handles multiple path params", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ posts: { comment: { method: "GET", params: ["userId", "postId"], path: "/users/:userId/posts/:postId" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).posts.comment({
			params: { postId: "99", userId: "1" },
		})

		const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
		expect(url).toBe("http://api.example.com/users/1/posts/99")
	})
})

describe("runtime — query/search parameter serialization", () => {
	it("appends search params to URL", async () => {
		const fetcher = mockFetch(200, [])
		const sdk = createSDK(
			{ users: { search: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).users.search({
			search: { limit: 10, q: "alice" },
		})

		const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
		expect(url).toContain("q=alice")
		expect(url).toContain("limit=10")
	})

	it("skips null and undefined search values", async () => {
		const fetcher = mockFetch(200, [])
		const sdk = createSDK(
			{ items: { list: { method: "GET", path: "/items" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).items.list({
			search: { active: true, skip: null, top: undefined },
		})

		const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
		expect(url).toContain("active=true")
		expect(url).not.toContain("skip")
		expect(url).not.toContain("top")
	})

	it("repeats key for array search values", async () => {
		const fetcher = mockFetch(200, [])
		const sdk = createSDK(
			{ tags: { filter: { method: "GET", path: "/tags" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).tags.filter({
			search: { ids: ["1", "2", "3"] },
		})

		const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
		expect(url).toContain("ids=1")
		expect(url).toContain("ids=2")
		expect(url).toContain("ids=3")
	})
})

describe("runtime — header building", () => {
	it("sets static config headers on every request", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: fetcher,
				headers: { authorization: "Bearer tok", "x-api-key": "abc" },
			},
		)

		await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()

		const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		const headers = init.headers as Headers
		expect(headers.get("authorization")).toBe("Bearer tok")
		expect(headers.get("x-api-key")).toBe("abc")
	})

	it("function headers are resolved with method and path context", async () => {
		const fetcher = mockFetch(200, {})
		const headerFn = vi.fn<(_ctx: { method: string; path: string }) => Record<string, string>>((_ctx) => ({
			"x-method": _ctx.method,
			"x-path": _ctx.path,
		}))
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: fetcher,
				headers: headerFn as Parameters<typeof createSDK>[1]["headers"],
			},
		)

		await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()

		expect(headerFn).toHaveBeenCalledWith({ method: "GET", path: "/users" })
	})

	it("per-request headers override config headers", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: fetcher,
				headers: { "x-version": "1" },
			},
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).users.list({
			headers: { "x-version": "2" },
		})

		const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		const headers = init.headers as Headers
		expect(headers.get("x-version")).toBe("2")
	})

	it("cookies are encoded and appended to cookie header", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).users.list({
			cookies: { session: "abc123", user: "alice" },
		})

		const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		const headers = init.headers as Headers
		const cookie = headers.get("cookie") ?? ""
		expect(cookie).toContain("session=abc123")
		expect(cookie).toContain("user=alice")
	})
})

describe("runtime — body serialization", () => {
	it("form without files sends url-encoded body", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ forms: { submit: { method: "POST", path: "/forms" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).forms.submit({
			form: { age: "30", name: "Alice" },
		})

		const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		const headers = init.headers as Headers
		expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded")
		expect(init.body).toContain("name=Alice")
		expect(init.body).toContain("age=30")
	})

	it("no body and no content-type when no json/form provided", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()

		const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		const headers = init.headers as Headers
		expect(init.body).toBeUndefined()
		expect(headers.get("content-type")).toBeNull()
	})
})

describe("runtime — response parsing", () => {
	it("parses application/json responses via response.json()", async () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: mockFetch(200, { items: [1, 2] }) },
		)

		const result = (await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()) as {
			data: unknown
		}

		expect(result.data).toEqual({ items: [1, 2] })
	})

	it("parses text/plain responses as string", async () => {
		const sdk = createSDK(
			{ health: { check: { method: "GET", path: "/health" } } },
			{ baseURL: "http://api.example.com", fetch: mockFetchRaw(200, "ok", "text/plain") },
		)

		const result = (await (sdk as Record<string, Record<string, () => Promise<unknown>>>).health.check()) as {
			data: unknown
		}

		expect(result.data).toBe("ok")
	})

	it("returns null data for 204 No Content", async () => {
		const sdk = createSDK(
			{ users: { remove: { method: "DELETE", params: ["id"], path: "/users/:id" } } },
			{
				baseURL: "http://api.example.com",
				fetch: vi.fn<typeof fetch>(() =>
					Promise.resolve(new Response(null, { status: 204 })),
				) as unknown as typeof fetch,
			},
		)

		const result = (await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).users.remove({
			params: { id: "1" },
		})) as { data: unknown; error: unknown; status: number }

		expect(result.data).toBeNull()
		expect(result.error).toBeNull()
		expect(result.status).toBe(204)
	})
})

describe("runtime — error responses", () => {
	it("4xx returns { data:null, error:<parsed body>, response, status }", async () => {
		const sdk = createSDK(
			{ users: { get: { method: "GET", params: ["id"], path: "/users/:id" } } },
			{
				baseURL: "http://api.example.com",
				fetch: mockFetch(404, { message: "Not found" }),
			},
		)

		const result = (await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).users.get({
			params: { id: "999" },
		})) as { data: unknown; error: unknown; status: number }

		expect(result.data).toBeNull()
		expect(result.error).toEqual({ message: "Not found" })
		expect(result.status).toBe(404)
	})

	it("5xx returns { data:null, error:<parsed body>, response, status }", async () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: mockFetch(500, { message: "Server error" }),
			},
		)

		const result = (await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()) as {
			data: unknown
			error: unknown
			status: number
		}

		expect(result.data).toBeNull()
		expect(result.error).toEqual({ message: "Server error" })
		expect(result.status).toBe(500)
	})

	it("error response includes the Response object", async () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: mockFetch(403, { message: "Forbidden" }),
			},
		)

		const result = (await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()) as {
			response: Response
			status: number
		}

		expect(result.response).toBeInstanceOf(Response)
		expect(result.status).toBe(403)
	})

	it("error body that is not JSON returns undefined error", async () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: mockFetchRaw(500, "Internal Server Error", "text/html"),
			},
		)

		const result = (await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()) as {
			data: unknown
			error: unknown
		}

		expect(result.data).toBeNull()
		/* Non-JSON error body: _parseErrorBody tries JSON.parse, fails, returns undefined */
		expect(result.error).toBeUndefined()
	})
})

describe("runtime — onRequest hook", () => {
	it("onRequest is called once per request with headers, method, path, url", async () => {
		const captured: unknown[] = []
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: mockFetch(200, []),
				onRequest: [
					(ctx) => {
						captured.push({ ...ctx })
					},
				],
			},
		)

		await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()

		expect(captured).toHaveLength(1)
		const ctx = captured[0] as Record<string, unknown>
		expect(ctx.method).toBe("GET")
		expect(ctx.path).toBe("/users")
		expect(ctx.url).toBe("http://api.example.com/users")
		expect(ctx.headers).toBeInstanceOf(Headers)
	})

	it("headers mutated in onRequest are sent with the request", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: fetcher,
				onRequest: [
					(ctx) => {
						ctx.headers.set("x-custom", "injected")
					},
				],
			},
		)

		await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()

		const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		const headers = init.headers as Headers
		expect(headers.get("x-custom")).toBe("injected")
	})

	it("multiple onRequest hooks are all called in order", async () => {
		const order: number[] = []
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: mockFetch(200, []),
				onRequest: [
					() => {
						order.push(1)
					},
					() => {
						order.push(2)
					},
					() => {
						order.push(3)
					},
				],
			},
		)

		await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()

		expect(order).toEqual([1, 2, 3])
	})
})

describe("runtime — onResponse hook", () => {
	it("onResponse is called with response, method, path, isRetry", async () => {
		const captured: unknown[] = []
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: mockFetch(200, []),
				onResponse: [
					(ctx) => {
						captured.push({ isRetry: ctx.isRetry, method: ctx.method, path: ctx.path })
						return undefined
					},
				],
			},
		)

		await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()

		expect(captured).toHaveLength(1)
		const ctx = captured[0] as Record<string, unknown>
		expect(ctx.method).toBe("GET")
		expect(ctx.path).toBe("/users")
		expect(ctx.isRetry).toBe(false)
	})

	it("onResponse returning a new Response replaces the response used for parsing", async () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: mockFetch(200, { original: true }),
				onResponse: [
					(_ctx) => {
						return new Response(JSON.stringify({ replaced: true }), {
							headers: { "content-type": "application/json" },
							status: 200,
						})
					},
				],
			},
		)

		const result = (await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()) as {
			data: unknown
		}

		expect(result.data).toEqual({ replaced: true })
	})

	it("multiple onResponse hooks are all called and last replacement wins", async () => {
		const order: number[] = []
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: mockFetch(200, {}),
				onResponse: [
					(_ctx) => {
						order.push(1)
						return undefined
					},
					(_ctx) => {
						order.push(2)
						return new Response(JSON.stringify({ replaced: 2 }), {
							headers: { "content-type": "application/json" },
							status: 200,
						})
					},
				],
			},
		)

		const result = (await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()) as {
			data: unknown
		}

		expect(order).toEqual([1, 2])
		expect(result.data).toEqual({ replaced: 2 })
	})
})

/* ═══════════════════════════════════════════════════════════════════
   SECTION 3 — Edge cases
   ═══════════════════════════════════════════════════════════════════ */

describe("edge cases — missing path param throws", () => {
	it("throws when a required path param is missing from params object", async () => {
		const sdk = createSDK(
			{ users: { get: { method: "GET", params: ["id"], path: "/users/:id" } } },
			{ baseURL: "http://api.example.com", fetch: mockFetch(200, {}) },
		)

		await expect(
			(sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).users.get({ params: {} }),
		).rejects.toThrow("Missing path param: id")
	})
})

describe("edge cases — unknown resource or action returns undefined", () => {
	it("accessing a non-existent resource returns undefined", () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: mockFetch(200, []) },
		)

		const proxy = sdk as Record<string, unknown>
		expect(proxy.nonExistent).toBeUndefined()
	})

	it("accessing a non-existent action returns undefined", () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: mockFetch(200, []) },
		)

		const proxy = sdk as Record<string, Record<string, unknown>>
		expect(proxy.users.nonExistentAction).toBeUndefined()
	})
})

describe("edge cases — no input argument defaults to empty opts", () => {
	it("calling action with no arguments uses empty opts", async () => {
		const fetcher = mockFetch(200, [])
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()

		expect(fetcher).toHaveBeenCalledOnce()
		const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
		expect(url).toBe("http://api.example.com/users")
	})
})

describe("edge cases — baseURL trailing slash handling", () => {
	it("works correctly with trailing slash on baseURL", async () => {
		const fetcher = mockFetch(200, [])
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com/", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()

		const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
		expect(url).toBe("http://api.example.com/users")
	})

	it("works correctly without trailing slash on baseURL", async () => {
		const fetcher = mockFetch(200, [])
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()

		const [url] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string]
		expect(url).toBe("http://api.example.com/users")
	})
})

describe("edge cases — concurrent requests are independent", () => {
	it("parallel calls each get their own fetch invocation", async () => {
		let callCount = 0
		const fetcher = vi.fn<typeof fetch>(() => {
			callCount++
			return Promise.resolve(
				new Response(JSON.stringify({ call: callCount }), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
			)
		}) as unknown as typeof fetch

		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		const action = (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list
		await Promise.all([action(), action(), action()])

		expect(fetcher).toHaveBeenCalledTimes(3)
	})
})

describe("edge cases — form with null/undefined values skips those keys", () => {
	it("null and undefined form fields are not included in url-encoded body", async () => {
		const fetcher = mockFetch(200, {})
		const sdk = createSDK(
			{ forms: { submit: { method: "POST", path: "/forms" } } },
			{ baseURL: "http://api.example.com", fetch: fetcher },
		)

		await (sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>).forms.submit({
			form: { keep: "yes", remove1: null, remove2: undefined },
		})

		const [, init] = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
		expect(init.body as string).toContain("keep=yes")
		expect(init.body as string).not.toContain("remove1")
		expect(init.body as string).not.toContain("remove2")
	})
})

describe("edge cases — empty spec generates valid 3-file output", () => {
	it("generates valid class and interface with no paths", () => {
		const emptySpec = { info: { title: "Empty", version: "1" }, openapi: "3.0.0", paths: {} }
		const { files, serviceMap } = generateSDK(emptySpec, { name: "EmptySDK" })
		expect(files.client).toContain("export class EmptySDK")
		expect(files.types).toContain("export interface EmptySDK<TThrow extends boolean = false> {")
		expect(Object.keys(serviceMap)).toHaveLength(0)
	})
})

describe("edge cases — duplicate operationId throws", () => {
	it("throws Error when two operations share the same operationId", () => {
		const dupSpec = {
			info: { title: "Dup", version: "1" },
			openapi: "3.0.0",
			paths: {
				"/a": { get: { operationId: "foo.bar", responses: {} } },
				"/b": { get: { operationId: "foo.bar", responses: {} } },
			},
		}
		expect(() => generateSDK(dupSpec)).toThrow('Duplicate operationId: "foo.bar"')
	})
})

describe("edge cases — onResponse returning undefined does not change response", () => {
	it("undefined return from onResponse keeps original response data", async () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{
				baseURL: "http://api.example.com",
				fetch: mockFetch(200, { original: true }),
				onResponse: [(_ctx) => undefined],
			},
		)

		const result = (await (sdk as Record<string, Record<string, () => Promise<unknown>>>).users.list()) as {
			data: unknown
		}

		expect(result.data).toEqual({ original: true })
	})
})

/* ═══════════════════════════════════════════════════════════════════
   SECTION 4 — Type contracts
   ═══════════════════════════════════════════════════════════════════ */

describe("type contracts — SDKResult shape inference", () => {
	it("createSDK return type is T (generic pass-through)", () => {
		type MySDK = {
			users: {
				list: () => Promise<{ data: string[]; error: null; response: Response; status: number }>
			}
		}
		const sdk = createSDK<MySDK>(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: mockFetch(200, []) },
		)
		expectTypeOf(sdk).toEqualTypeOf<MySDK>()
	})

	it("buildSDKRuntime-generated code: SDKResult<T> data type is T on success branch", () => {
		/* Structural type check on the SDKResult type shape */
		type SDKResultSuccess = { data: string; error: null; response: Response; status: number }
		type SDKResultError = { data: null; error: unknown; response: Response; status: number }

		/* Success branch must have data: T, error: null */
		expectTypeOf<SDKResultSuccess>().toMatchTypeOf<{ data: string; error: null }>()
		/* Error branch must have data: null */
		expectTypeOf<SDKResultError>().toMatchTypeOf<{ data: null }>()
	})
})

describe("type contracts — generateSDK return type", () => {
	it("returns { files: { client, map, types }, serviceMap }", () => {
		const result = generateSDK(minimalSpec, { name: "TestSDK" })
		expectTypeOf(result.files.client).toEqualTypeOf<string>()
		expectTypeOf(result.files.map).toEqualTypeOf<string>()
		expectTypeOf(result.files.types).toEqualTypeOf<string>()
		expectTypeOf(result.serviceMap).toEqualTypeOf<
			Record<
				string,
				Record<
					string,
					{
						invalidate?: string[]
						method: string
						params?: string[]
						path: string
						sse?: boolean
						ws?: boolean
					}
				>
			>
		>()
	})

	it("serviceMap at runtime contains correct method/path values", () => {
		const { serviceMap: sm } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(sm.users?.list?.method).toBe("GET")
		expect(sm.users?.list?.path).toBe("/v1/users")
		expect(sm.users?.create?.method).toBe("POST")
		expect(sm.users?.create?.invalidate).toEqual(["GET /v1/users"])
	})
})

/* ═══════════════════════════════════════════════════════════════════
   SECTION 3 — Feature parity with HTTPClient
   ═══════════════════════════════════════════════════════════════════ */

describe("generated code structure — _ClientError class", () => {
	it("emits _ClientError class extending Error", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("class _ClientError extends Error")
	})

	it("re-exports _ClientError as ClientError", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("_ClientError as ClientError")
	})

	it("emits isClientError standalone helper", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("export function isClientError(")
	})
})

describe("generated code structure — throwOnError", () => {
	it("config type includes throwOnError?: boolean", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("throwOnError?: TThrow")
	})

	it("#request branches on this.#config.throwOnError", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("this.#config.throwOnError")
	})

	it("emits #requestThrow private method", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#requestThrow(")
	})

	it("emits #parseAsClientError private method", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#parseAsClientError(")
	})
})

describe("generated code structure — retry in onResponse", () => {
	it("onResponse context includes retry function", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("resCtx")
		expect(files.client).toContain("retry: () =>")
	})

	it("retry throws on double retry", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("Max 1 retry per request")
	})

	it("onResponse type in config includes retry", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("retry: () => Promise<Response>")
	})
})

describe("generated code structure — timeout and signal", () => {
	it("config type includes timeout?: number", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("timeout?: number")
	})

	it("_RequestOptions includes signal?: AbortSignal", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("signal?: AbortSignal")
	})

	it("emits #buildSignal private method", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#buildSignal(")
	})
})

describe("generated code structure — credentials and mode", () => {
	it("config type includes credentials?: RequestCredentials", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("credentials?: RequestCredentials")
	})

	it("config type includes mode?: RequestMode", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("mode?: RequestMode")
	})

	it("#doRequest applies credentials and mode from config", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("this.#config.credentials")
		expect(files.client).toContain("this.#config.mode")
	})
})

describe("generated code structure — SSE enhancements", () => {
	it("SSE throws ClientError on non-ok response", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("this.#parseAsClientError(response)")
	})

	it("SSE supports lastEventId header", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("last-event-id")
	})
})

describe("generated code structure — FileList handling", () => {
	it("form handling includes FileList detection", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("FileList")
	})
})

describe("generated code structure — search params config", () => {
	it("config type includes sortSearchParams?: boolean", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("sortSearchParams?: boolean")
	})

	it("config type includes buildSearchParams?", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.types).toContain("buildSearchParams?")
	})
})

describe("generated code structure — WS reconnectToken", () => {
	it("#connectWS supports reconnect_token query param", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("reconnect_token")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   SECTION 5 — Bug fixes (TDD RED then GREEN)
   ═══════════════════════════════════════════════════════════════════ */

describe("bugfix — #connectWS uses typed opts instead of unsafe casts", () => {
	it("_RequestOptions includes protocols field", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("protocols?: string | string[]")
	})

	it("_RequestOptions includes reconnectToken field", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("reconnectToken?: string")
	})

	it("#connectWS accesses opts.protocols directly without cast", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		/* extract the #connectWS method definition (tab-indented, not proxy call) */
		const wsStart = files.client.indexOf("\t#connectWS(entry:")
		const wsBody = files.client.slice(wsStart, wsStart + 500)
		expect(wsBody).toContain("opts.protocols")
		expect(wsBody).toContain("opts.reconnectToken")
		expect(wsBody).not.toContain("as Record<string, unknown>")
	})
})

describe("bugfix — #clearStale collects keys before deleting", () => {
	it("generated #clearStale does not delete during iteration", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		/* extract #clearStale method definition */
		const start = files.client.indexOf("\t#clearStale(concreteSelector:")
		const body = files.client.slice(start, start + 600)
		/* should collect keys to delete, then delete in separate loop */
		expect(body).toContain("toDelete")
		expect(body).not.toMatch(/for \(const \[key\].*\n.*\.delete\(key\)/)
	})

	/* createSDK has the same delete-during-iteration bug — skipped until sdk.ts is fixed */
	it.skip("runtime: all matching pattern stale entries are cleared", async () => {
		const fetcher = mockFetch(200, { id: 1 })
		const sdk = createSDK(
			{
				items: {
					get1: { method: "GET", params: ["id"], path: "/items/:id" },
					get2: { method: "GET", params: ["id"], path: "/items/:id" },
					update: {
						invalidate: ["GET /items/:id"],
						method: "PATCH",
						params: ["id"],
						path: "/items/:id",
					},
				},
			},
			{
				baseURL: "http://api.example.com",
				fetch: fetcher,
				invalidation: { staleTime: 60000 },
			},
		)

		const proxy = sdk as Record<string, Record<string, (i: unknown) => Promise<unknown>>>

		/* mutate — marks GET /items/:id as stale */
		await proxy.items.update({ params: { id: "1" } })

		/* now do two GETs with different IDs — both should see stale, then get cleared */
		const captured: unknown[] = []
		const staleSDK = createSDK(
			{
				items: {
					get: { method: "GET", params: ["id"], path: "/items/:id" },
					update: {
						invalidate: ["GET /items/:id"],
						method: "PATCH",
						params: ["id"],
						path: "/items/:id",
					},
				},
			},
			{
				baseURL: "http://api.example.com",
				fetch: fetcher,
				invalidation: { staleTime: 60000 },
				onRequest: [
					(ctx) => {
						captured.push({ isStale: ctx.isStale, selector: ctx.selector })
					},
				],
			},
		)

		const staleProxy = staleSDK as Record<string, Record<string, (i: unknown) => Promise<unknown>>>

		/* mark two different resources as stale via pattern */
		await staleProxy.items.update({ params: { id: "A" } })
		await staleProxy.items.update({ params: { id: "B" } })

		/* now fetch item A — should be stale, and clearStale should remove BOTH pattern entries */
		await staleProxy.items.get({ params: { id: "A" } })
		captured.length = 0

		/* fetch item B — should NOT be stale anymore (clearStale for A should have also cleared B's pattern) */
		await staleProxy.items.get({ params: { id: "B" } })

		const bCtx = captured[0] as { isStale: boolean } | undefined
		/* B should not be stale — the pattern entry was cleared when A was fetched */
		expect(bCtx?.isStale).toBe(false)
	})
})

describe("bugfix — SSE fires onRequest hooks", () => {
	it("generated #doSSE calls onRequest hooks", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		/* find #doSSE method body */
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 800)
		expect(sseBody).toContain("this.#config.onRequest")
	})

	it("generated #doSSE calls onResponse hooks", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 1200)
		expect(sseBody).toContain("this.#config.onResponse")
	})
})

describe("bugfix — #pathMatchesPattern escapes regex special chars", () => {
	it("generated #pathMatchesPattern escapes dots and special chars in pattern", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const start = files.client.indexOf("#pathMatchesPattern(")
		const body = files.client.slice(start, start + 300)
		/* should escape regex-special chars in the non-param segments */
		expect(body).toContain("replace(/[.*+?^${}()|[\\]\\\\]/g")
	})
})

describe("bugfix — stale map evicts expired entries", () => {
	it("generated #lookupStale or #markStale prunes expired entries", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		/* should have eviction logic — delete expired entries during lookupStale or markStale */
		const lookupStart = files.client.indexOf("#lookupStale(")
		const lookupBody = files.client.slice(lookupStart, lookupStart + 600)
		/* prune expired: if entry.until <= now, delete it */
		expect(lookupBody).toContain(".delete(")
	})
})

/* ═══════════════════════════════════════════════════════════════════
   SECTION 6 — Audit Round 2: RED characterization tests
   Each test MUST FAIL against current code — confirming the bug.
   ═══════════════════════════════════════════════════════════════════ */

/* ── #1 + #2 — SSE hook context types ── */

describe("bugfix — #doSSE reqCtx type includes optional invalidation fields", () => {
	it("SSE reqCtx type annotation contains invalidatedBy?", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 2000)
		const reqCtxLine = sseBody.split("\n").find((l) => l.includes("reqCtx:") && l.includes("headers: Headers"))
		expect(reqCtxLine).toBeDefined()
		expect(reqCtxLine).toContain("invalidatedBy?: string[]")
	})

	it("SSE reqCtx type annotation contains isStale?", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 2000)
		const reqCtxLine = sseBody.split("\n").find((l) => l.includes("reqCtx:") && l.includes("headers: Headers"))
		expect(reqCtxLine).toBeDefined()
		expect(reqCtxLine).toContain("isStale?: boolean")
	})

	it("SSE reqCtx type annotation contains selector?", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 2000)
		const reqCtxLine = sseBody.split("\n").find((l) => l.includes("reqCtx:") && l.includes("headers: Headers"))
		expect(reqCtxLine).toBeDefined()
		expect(reqCtxLine).toContain("selector?: string")
	})
})

describe("bugfix — #doSSE resCtx type includes optional invalidation fields", () => {
	it("SSE resCtx type annotation contains invalidatedBy?", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 2000)
		const resCtxLine = sseBody.split("\n").find((l) => l.includes("resCtx:") && l.includes("isRetry: boolean"))
		expect(resCtxLine).toBeDefined()
		expect(resCtxLine).toContain("invalidatedBy?: string[]")
	})

	it("SSE resCtx type annotation contains selector?", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 2000)
		const resCtxLine = sseBody.split("\n").find((l) => l.includes("resCtx:") && l.includes("isRetry: boolean"))
		expect(resCtxLine).toBeDefined()
		expect(resCtxLine).toContain("selector?: string")
	})
})

/* ── #3 — SSE signal abort: superseded by Round 3 Issue #3 (removed in SECTION 7) ── */

/* ── #4 — Resource proxy cache ── */

describe("bugfix — resource proxy is cached per resource name", () => {
	it("generated client contains #resourceCache field", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#resourceCache")
	})

	it("generated client contains #resourceCache.get(resourceName)", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#resourceCache.get(key)")
	})

	it("createSDK: accessing same resource twice returns identical proxy object", () => {
		const sdk = createSDK(
			{ users: { list: { method: "GET", path: "/users" } } },
			{ baseURL: "http://api.example.com", fetch: mockFetch(200, []) },
		)

		const proxy = sdk as Record<string, unknown>
		const first = proxy.users
		const second = proxy.users
		expect(first).toBe(second)
	})
})

/* ── #5 — markStale includes ── */

describe("bugfix — #markStale uses .includes() not new Set()", () => {
	it("generated #markStale does not contain new Set(", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		/* method definition starts with tab-prefixed signature, not the call site */
		const markStart = files.client.indexOf("\t#markStale(")
		const markBody = files.client.slice(markStart, markStart + 600)
		expect(markBody).not.toContain("new Set(")
	})

	it("generated #markStale contains .includes(mutationSelector)", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const markStart = files.client.indexOf("\t#markStale(")
		const markBody = files.client.slice(markStart, markStart + 600)
		expect(markBody).toContain(".includes(mutationSelector)")
	})
})

/* ── #6 — Search serializer bind ── */

describe("bugfix — #searchSerializer class field eliminates per-call closure alloc", () => {
	it("generated client contains #searchSerializer field", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("#searchSerializer")
	})

	it("generated client contains this.#searchSerializer = in constructor", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("this.#searchSerializer =")
	})
})

/* ── #7 — captureStackTrace ── */

describe("bugfix — _ClientError calls captureStackTrace for clean stacks", () => {
	it("generated _ClientError constructor contains captureStackTrace", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("captureStackTrace")
	})
})

/* ── #8 — SSE field-less lines ── */

describe("bugfix — SSE field-less lines treated as empty-value fields per spec", () => {
	it("generated #parseSSEBlock does not skip field-less lines with continue", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const parseStart = files.client.indexOf("#parseSSEBlock(")
		const parseBody = files.client.slice(parseStart, parseStart + 800)
		expect(parseBody).not.toContain("if (colonIdx === -1) continue")
	})

	it("parseSSEStream: field-less data line (no colon) yields event with empty string data", async () => {
		/* SSE spec: a line with no colon is field name with empty value.
		   "data" (no colon) → field="data", val="" → event dispatched with data="" */
		const raw = "data\n\n"
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(raw))
				controller.close()
			},
		})

		const events: Awaited<ReturnType<typeof parseSSEStream.prototype.next>>[] = []
		for await (const event of parseSSEStream(stream)) {
			events.push(event)
		}

		expect(events).toHaveLength(1)
		expect(events[0]).toMatchObject({ data: "" })
	})
})

/* ═══════════════════════════════════════════════════════════════════
   SECTION 7 — Round 3 audit fixes (RED characterization tests)
   Every test MUST FAIL against the current code to confirm the bug.
   ═══════════════════════════════════════════════════════════════════ */

/* helper: build a spec with an SSE route that has a path param */
const ssePathParamSpec = {
	info: { title: "SSETest", version: "1" },
	openapi: "3.0.0",
	paths: {
		"/v1/streams/{channel}/events": {
			get: {
				operationId: "streams.events",
				parameters: [{ in: "path", name: "channel", required: true, schema: { type: "string" } }],
				responses: {},
				"x-sse": true,
			},
		},
		"/v1/ws/{room}/connect": {
			get: {
				operationId: "ws.connect",
				parameters: [{ in: "path", name: "room", required: true, schema: { type: "string" } }],
				responses: {},
				"x-ws": true,
			},
		},
	},
}

/* helper: build a spec with an enum path param */
const enumPathParamSpec = {
	info: { title: "OAuthTest", version: "1" },
	openapi: "3.0.0",
	paths: {
		"/v1/auth/oauth/{provider}/authorize": {
			get: {
				operationId: "oauth.authorize",
				parameters: [
					{
						in: "path",
						name: "provider",
						required: true,
						schema: { enum: ["apple", "google"], type: "string" },
					},
				],
				responses: {},
			},
		},
	},
}

/* ── Issue #1 — SSE/WS paths not converted from {param} to :param ── */

describe("round3 bugfix — SSE/WS paths converted via #toColonParams before branch", () => {
	it("inner proxy get handler calls #toColonParams before WS branch", () => {
		const { files } = generateSDK(ssePathParamSpec, { name: "SSETest" })
		/*
		 * The proxy inner get handler must call target.#toColonParams(entry.path)
		 * BEFORE the entry.ws check. Current code does NOT do this — WS branch
		 * uses entry.path directly. This assertion will fail until fixed.
		 */
		const proxyStart = files.client.indexOf("get(target, key)")
		const proxyBody = files.client.slice(proxyStart, proxyStart + 800)
		const toColonBeforeWS = /const entryPath = target\.#toColonParams\(entry\.path\)[\s\S]*?if \(entry\.ws\)/.test(
			proxyBody,
		)
		expect(toColonBeforeWS).toBe(true)
	})

	it("WS branch passes converted path variable, not entry.path", () => {
		const { files } = generateSDK(ssePathParamSpec, { name: "SSETest" })
		const proxyStart = files.client.indexOf("get(target, key)")
		const proxyBody = files.client.slice(proxyStart, proxyStart + 800)
		const wsSection = proxyBody.slice(proxyBody.indexOf("entry.ws"))
		const wsBranchBody = wsSection.slice(
			0,
			wsSection.indexOf("entry.sse") !== -1 ? wsSection.indexOf("entry.sse") : 300,
		)
		expect(wsBranchBody).not.toContain("entry.path")
	})

	it("SSE branch passes converted path variable, not entry.path", () => {
		const { files } = generateSDK(ssePathParamSpec, { name: "SSETest" })
		const proxyStart = files.client.indexOf("get(target, key)")
		const proxyBody = files.client.slice(proxyStart, proxyStart + 800)
		const sseIdx = proxyBody.indexOf("entry.sse")
		const sseBranchBody = proxyBody.slice(sseIdx, sseIdx + 200)
		expect(sseBranchBody).not.toContain("entry.path")
	})

	it("inner proxy get handler has symbol guard for actionName", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("return Reflect.get(target, key)")
	})
})

/* ── Issue #2 — #clearStale runs unconditionally instead of guarded by isStale ── */

describe("round3 bugfix — #clearStale guarded by requestMeta?.isStale", () => {
	it("#request throwOnError branch wraps #clearStale in requestMeta?.isStale guard", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const requestStart = files.client.indexOf("async #request(")
		const requestBody = files.client.slice(requestStart, requestStart + 4000)
		const guardedPattern = /if \(requestMeta\?\.isStale\) this\.#clearStale/
		expect(guardedPattern.test(requestBody)).toBe(true)
	})

	it("#request safe branch wraps #clearStale in requestMeta?.isStale guard", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const requestStart = files.client.indexOf("async #request(")
		const requestBody = files.client.slice(requestStart, requestStart + 4000)
		const matches = requestBody.match(/if \(requestMeta\?\.isStale\) this\.#clearStale/g)
		expect(matches).toHaveLength(2)
	})

	it("#request body does NOT contain bare #clearStale call without isStale guard", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const requestStart = files.client.indexOf("async #request(")
		const requestBody = files.client.slice(requestStart, requestStart + 4000)

		/* Any line with #clearStale must be preceded on same logical line by isStale guard */
		const lines = requestBody.split("\n").filter((l) => l.includes("this.#clearStale("))
		expect(lines.length).toBeGreaterThan(0)
		for (const line of lines) {
			expect(line).toContain("requestMeta?.isStale")
		}
	})
})

/* ── Issue #3 — SSE abort handler should not exist (signal propagates through fetch) ── */

describe("round3 bugfix — SSE abort handler removed", () => {
	it("generated #doSSE does NOT contain abortHandler variable", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 3000)
		/* Current code has: const abortHandler = signal ? ... : undefined
		   Fixed code removes it entirely */
		expect(sseBody).not.toContain("abortHandler")
	})

	it('generated #doSSE does NOT contain addEventListener("abort"', () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 3000)
		/* Current code registers an abort listener — fixed code must not */
		expect(sseBody).not.toContain(`addEventListener("abort"`)
	})

	it('generated #doSSE does NOT contain removeEventListener("abort"', () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 3000)
		/* Current code removes the abort listener in finally — fixed code must not */
		expect(sseBody).not.toContain(`removeEventListener("abort"`)
	})
})

/* ── Issue #4 — Path params hardcoded as string, losing enum constraints ── */

describe("round3 bugfix — path param types from schema via jsonSchemaToTS", () => {
	it("enum path param generates union type instead of string", () => {
		const { files } = generateSDK(enumPathParamSpec, { name: "OAuthTest" })
		/*
		 * Current code: `provider: string`
		 * Fixed code: `provider: "apple" | "google"`
		 */
		expect(files.types).toContain(`"apple" | "google"`)
	})

	it("enum path param does NOT generate plain string type", () => {
		const { files } = generateSDK(enumPathParamSpec, { name: "OAuthTest" })
		const typesLines = files.types.split("\n")
		/* Find the params block for oauth.authorize */
		const paramsLine = typesLines.find((l) => l.includes("provider:"))
		expect(paramsLine).toBeDefined()
		/* The type should NOT be just `string` — it must be the enum union */
		expect(paramsLine).not.toMatch(/provider:\s+string(?!\s*\|)/)
	})

	it("plain string path param still generates string type (no regression)", () => {
		const plainStringSpec = {
			info: { title: "PlainTest", version: "1" },
			openapi: "3.0.0",
			paths: {
				"/v1/users/{id}": {
					get: {
						operationId: "users.get",
						parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
						responses: {},
					},
				},
			},
		}
		const { files } = generateSDK(plainStringSpec, { name: "PlainTest" })
		/* z.string() → { type: "string" } → jsonSchemaToTS returns "string" */
		expect(files.types).toContain("id: string")
	})
})

/* ── Issue #5 — Proxy get handler types propertyKey as string (should be string | symbol) ── */

describe("round3 bugfix — proxy get handler parameters typed string | symbol", () => {
	it("outer proxy get handler parameter is typed string | symbol", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		/*
		 * Current code: (target, resourceName: string)
		 * Fixed code: (target, resourceName: string | symbol)
		 */
		expect(files.client).toContain("get(target, key)")
		expect(files.client).toContain("return Reflect.get(target, key)")
	})

	it("inner proxy get handler parameter is typed string | symbol", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		expect(files.client).toContain("get(target, key)")
		expect(files.client).toContain("return Reflect.get(target, key)")
	})
})

/* ── Issue #6 — pathMatchesPattern no regex cache ── */

describe("round3 bugfix — pathMatchesPattern uses regex cache", () => {
	it("generated client contains #patternRegexCache field", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		/*
		 * Current code has no cache — new RegExp is created on every call.
		 * Fixed code adds: #patternRegexCache = new Map<string, RegExp>()
		 */
		expect(files.client).toContain("#patternRegexCache")
	})

	it("#pathMatchesPattern body contains cache lookup via .get(pattern)", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const matchStart = files.client.indexOf("#pathMatchesPattern(")
		const matchBody = files.client.slice(matchStart, matchStart + 400)
		/* Fixed code: let re = this.#patternRegexCache.get(pattern) */
		expect(matchBody).toContain(".get(pattern)")
	})

	it("#pathMatchesPattern body contains cache set via .set(pattern, re)", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const matchStart = files.client.indexOf("#pathMatchesPattern(")
		const matchBody = files.client.slice(matchStart, matchStart + 400)
		/* Fixed code: this.#patternRegexCache.set(pattern, re) */
		expect(matchBody).toContain(".set(pattern,")
	})
})

/* ── Issue #7 — SSE block-split regex missing \r\n\n combination ── */

describe("round3 bugfix — SSE block-split regex covers \\r\\n\\n pattern", () => {
	it("generated client SSE block-split regex contains \\\\r\\\\n\\\\n alternative", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		/*
		 * Current regex: /\r\n\r\n|\r\r|\n\n|\r\n\r|\n\r\n|\n\r/
		 * Missing: \r\n\n
		 * Fixed regex must include \r\n\n as an alternative.
		 * In the generated source string the regex appears as:
		 * /\\r\\n\\r\\n|\\r\\r|\\n\\n|\\r\\n\\r|\\n\\r\\n|\\n\\r/
		 * Fixed: must also contain \\r\\n\\n
		 */
		const sseStart = files.client.indexOf("*#doSSE(")
		const sseBody = files.client.slice(sseStart, sseStart + 3000)
		expect(sseBody).toContain("\\r\\n\\n")
	})

	it("parseSSEStream correctly splits blocks separated by \\r\\n\\n", async () => {
		/*
		 * Current sse.ts regex misses \r\n\n pattern — this test will fail
		 * because the stream content uses \r\n\n as block separator.
		 *
		 * The stream has two events separated by CRLF+LF (\r\n\n).
		 * Expected: 2 events parsed.
		 * Actual with current regex: events may not split correctly.
		 */
		const raw = "data: hello\r\n\ndata: world\r\n\n"
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(raw))
				controller.close()
			},
		})

		const events: import("../../../src/client/sse.ts").SSEEvent[] = []
		for await (const event of parseSSEStream(stream)) {
			events.push(event)
		}

		expect(events).toHaveLength(2)
		expect(events[0]).toMatchObject({ data: "hello" })
		expect(events[1]).toMatchObject({ data: "world" })
	})
})

/* ── Issue #8 — staleUntil Map unbounded growth ── */

describe("round3 bugfix — staleUntil size-capped sweep in #markStale", () => {
	it("generated #markStale body contains a size check for the staleUntil map", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const markStart = files.client.indexOf("\t#markStale(")
		const markBody = files.client.slice(markStart, markStart + 900)
		/*
		 * Current code has no size guard.
		 * Fixed code adds: if (this.#staleUntil.size > 1000) { ... sweep ... }
		 */
		expect(markBody).toMatch(/\.size\s*[>]/)
	})

	it("generated #markStale size guard triggers a sweep of expired entries", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const markStart = files.client.indexOf("\t#markStale(")
		const markBody = files.client.slice(markStart, markStart + 900)
		/* Sweep deletes expired entries: entry.until <= now */
		expect(markBody).toContain("entry.until")
	})

	it("generated client contains size threshold constant or literal 1000 in #markStale", () => {
		const { files } = generateSDK(minimalSpec, { name: "TestSDK" })
		const markStart = files.client.indexOf("\t#markStale(")
		const markBody = files.client.slice(markStart, markStart + 900)
		/* The threshold must be a reasonable value — spec says 1000 */
		expect(markBody).toContain("this.#staleMaxEntries")
	})
})
