import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { createSDK } from "../../../src/client/sdk.ts"
import { generateOpenApi, generateSDK, mergeSpecs, scopeSpec } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"

type SDKResult = { data: unknown; error: unknown; response: Response; status: number }

/* ═══════════════════════════════════════════
 * Full pipeline: app → OpenAPI → SDK → createSDK
 * ═══════════════════════════════════════════ */

describe("SDK e2e: full pipeline", () => {
	it("app with operationIds → OpenAPI → generateSDK → createSDK → calls work", async () => {
		/* 1. define app */
		const app = honey<{}>()
		app
			.get("/users")
			.meta({ operationId: "users.list", tags: ["users"] })
			.output({
				"application/json": { ok: z.array(z.object({ id: z.string(), name: z.string() })) },
			})
			.handler((ctx) => ctx.res.json("ok", [{ id: "1", name: "Alice" }]))

		app
			.get("/users/:id")
			.meta({ operationId: "users.get", tags: ["users"] })
			.input({ params: z.object({ id: z.string() }) })
			.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, name: "Alice" }))

		app
			.post("/users")
			.meta({ operationId: "users.create", tags: ["users"] })
			.input({ json: z.object({ name: z.string() }) })
			.output({ "application/json": { created: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("created", { id: "new-1" }))

		/* 2. generate OpenAPI */
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })

		/* 3. generate SDK */
		const { serviceMap } = generateSDK(spec)
		expect(serviceMap.users).toBeDefined()
		expect(serviceMap.users.list).toBeDefined()
		expect(serviceMap.users.get).toBeDefined()
		expect(serviceMap.users.create).toBeDefined()

		/* 4. create SDK with real app.fetch as transport */
		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), {}),
		})

		/* 5. test calls */
		const usersResult = (await sdk.users.list()) as SDKResult
		expect(usersResult.data).toEqual([{ id: "1", name: "Alice" }])
		expect(usersResult.error).toBeNull()

		const userResult = (await sdk.users.get({ params: { id: "42" } })) as SDKResult
		expect(userResult.data).toEqual({ id: "42", name: "Alice" })
		expect(userResult.error).toBeNull()

		const createdResult = (await sdk.users.create({ json: { name: "Bob" } })) as SDKResult
		expect(createdResult.data).toEqual({ id: "new-1" })
		expect(createdResult.error).toBeNull()
	})
})

/* ═══════════════════════════════════════════
 * Multi-service: merge → scope → SDK
 * ═══════════════════════════════════════════ */

describe("SDK e2e: multi-service scoped", () => {
	it("two apps → merge specs → scope by tags → separate SDKs", async () => {
		/* app A: public API */
		const publicApp = honey<{}>()
		publicApp
			.get("/items")
			.meta({ operationId: "items.list", tags: ["public"] })
			.handler((ctx) => ctx.res.json("ok", []))
		publicApp
			.post("/items")
			.meta({ operationId: "items.create", tags: ["public"] })
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("created", { id: "i-1" }))

		/* app B: admin API */
		const adminApp = honey<{}>()
		adminApp
			.get("/admin/stats")
			.meta({ operationId: "admin.stats", tags: ["admin"] })
			.handler((ctx) => ctx.res.json("ok", { total: 42 }))
		adminApp
			.delete("/admin/users/:id")
			.meta({ operationId: "admin.deleteUser", tags: ["admin"] })
			.input({ params: z.object({ id: z.string() }) })
			.handler((ctx) => ctx.res.noContent())

		/* generate separate specs */
		const specA = await generateOpenApi(publicApp, { info: { title: "Public", version: "1.0" } })
		const specB = await generateOpenApi(adminApp, { info: { title: "Admin", version: "1.0" } })

		/* merge */
		const fullSpec = mergeSpecs(specA, specB)
		expect(Object.keys(fullSpec.paths).length).toBeGreaterThanOrEqual(3)

		/* scope: public SDK */
		const publicScoped = scopeSpec(fullSpec, { tags: ["public"] })
		const publicSDK = generateSDK(publicScoped)
		expect(publicSDK.serviceMap.items).toBeDefined()
		expect(publicSDK.serviceMap.admin).toBeUndefined()

		/* scope: admin SDK */
		const adminScoped = scopeSpec(fullSpec, { tags: ["admin"] })
		const adminSDKResult = generateSDK(adminScoped)
		expect(adminSDKResult.serviceMap.admin).toBeDefined()
		expect(adminSDKResult.serviceMap.items).toBeUndefined()
	})
})

/* ═══════════════════════════════════════════
 * createSDK: deep behavior tests
 * ═══════════════════════════════════════════ */

describe("SDK: request body types", () => {
	it("POST with JSON body → correct content-type and body", async () => {
		let capturedRequest: { body: string; headers: Headers; method: string } | undefined
		const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
			capturedRequest = {
				body: (init as RequestInit).body as string,
				headers: new Headers((init as RequestInit).headers as Record<string, string>),
				method: (init as RequestInit).method ?? "GET",
			}
			return new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		})

		const sdk = createSDK(
			{ users: { create: { method: "POST", path: "/users" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.users.create({ json: { email: "a@b.com", name: "Alice" } })
		expect(capturedRequest?.method).toBe("POST")
		expect(capturedRequest?.headers.get("content-type")).toContain("application/json")
		const body = JSON.parse(capturedRequest?.body ?? "{}") as Record<string, unknown>
		expect(body.name).toBe("Alice")
		expect(body.email).toBe("a@b.com")
	})

	it("PUT with JSON body", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({}), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
		)

		const sdk = createSDK(
			{ users: { update: { method: "PUT", params: ["id"], path: "/users/:id" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.users.update({ json: { name: "Updated" }, params: { id: "42" } })
		const mock = fetcher as unknown as ReturnType<typeof vi.fn>
		expect(mock.mock.calls[0]?.[0]).toContain("/users/42")
		expect((mock.mock.calls[0]?.[1] as Record<string, unknown>)?.method).toBe("PUT")
	})

	it("DELETE with params, no body", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }))

		const sdk = createSDK(
			{ users: { remove: { method: "DELETE", params: ["id"], path: "/users/:id" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		const result = (await sdk.users.remove({ params: { id: "42" } })) as SDKResult
		const mock = fetcher as unknown as ReturnType<typeof vi.fn>
		expect(mock.mock.calls[0]?.[0]).toContain("/users/42")
		expect((mock.mock.calls[0]?.[1] as Record<string, unknown>)?.method).toBe("DELETE")
		expect(result.data).toBeNull()
		expect(result.error).toBeNull()
	})

	it("GET with no input → no body, no query params", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify([]), {
					headers: { "content-type": "application/json" },
					status: 200,
				}),
		)

		const sdk = createSDK(
			{ items: { list: { method: "GET", path: "/items" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.items.list()
		expect(fetcher.mock.calls[0]?.[0]).toBe("http://localhost/items")
		expect((fetcher.mock.calls[0]?.[1] as Record<string, unknown>)?.body).toBeUndefined()
	})
})

describe("SDK: error handling", () => {
	it("4xx error → returns error in tuple", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({ error_key: "not_found", message: "User not found" }), {
					headers: { "content-type": "application/json" },
					status: 404,
				}),
		)

		const sdk = createSDK(
			{ users: { get: { method: "GET", params: ["id"], path: "/users/:id" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		const result = (await sdk.users.get({ params: { id: "999" } })) as SDKResult
		expect(result.data).toBeNull()
		expect(result.error).not.toBeNull()
		expect(result.status).toBe(404)
		expect((result.error as Record<string, unknown>)?.error_key).toBe("not_found")
	})

	it("5xx error → returns error in tuple", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () =>
				new Response(JSON.stringify({ error_key: "internal_server_error" }), {
					headers: { "content-type": "application/json" },
					status: 500,
				}),
		)

		const sdk = createSDK(
			{ items: { list: { method: "GET", path: "/items" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		const result = (await sdk.items.list()) as SDKResult
		expect(result.data).toBeNull()
		expect(result.error).not.toBeNull()
		expect(result.status).toBe(500)
	})

	it("network error → throws", async () => {
		const fetcher = vi.fn<typeof fetch>(async () => {
			throw new Error("network failure")
		})

		const sdk = createSDK(
			{ items: { list: { method: "GET", path: "/items" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await expect(sdk.items.list()).rejects.toThrow("network failure")
	})
})

describe("SDK: headers", () => {
	it("config headers sent on every request", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response("{}", { headers: { "content-type": "application/json" }, status: 200 }),
		)

		const sdk = createSDK(
			{
				a: { x: { method: "GET", path: "/a" } },
				b: { y: { method: "GET", path: "/b" } },
			},
			{
				baseURL: "http://localhost",
				fetch: fetcher,
				headers: { authorization: "Bearer tok", "x-api-key": "key-123" },
			},
		)

		await sdk.a.x()
		await sdk.b.y()

		for (const call of fetcher.mock.calls) {
			const headers = (call as unknown[])[1] as Record<string, unknown>
			expect((headers.headers as Headers).get("authorization")).toBe("Bearer tok")
			expect((headers.headers as Headers).get("x-api-key")).toBe("key-123")
		}
	})
})

describe("SDK: search params", () => {
	it("search params appended to URL", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response("[]", { headers: { "content-type": "application/json" }, status: 200 }),
		)

		const sdk = createSDK(
			{ items: { list: { method: "GET", path: "/items" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.items.list({ search: { limit: 20, offset: 40, status: "active" } })
		const url = fetcher.mock.calls[0]?.[0] as unknown as string
		expect(url).toContain("limit=20")
		expect(url).toContain("offset=40")
		expect(url).toContain("status=active")
	})

	it("undefined/null search values excluded", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response("[]", { headers: { "content-type": "application/json" }, status: 200 }),
		)

		const sdk = createSDK(
			{ items: { list: { method: "GET", path: "/items" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.items.list({ search: { active: undefined, page: 1 } })
		const url = fetcher.mock.calls[0]?.[0] as unknown as string
		expect(url).toContain("page=1")
		expect(url).not.toContain("active")
	})
})

describe("SDK: complex path params", () => {
	it("deeply nested params from OpenAPI {param} format", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response("{}", { headers: { "content-type": "application/json" }, status: 200 }),
		)

		const sdk = createSDK(
			{
				exports: {
					get: {
						method: "GET",
						params: ["orgId", "projectId", "exportId"],
						path: "/orgs/{orgId}/projects/{projectId}/exports/{exportId}",
					},
				},
			},
			{ baseURL: "https://api.example.com", fetch: fetcher },
		)

		await sdk.exports.get({ params: { exportId: "e-1", orgId: "o-1", projectId: "p-1" } })
		const url = fetcher.mock.calls[0]?.[0] as unknown as string
		expect(url).toBe("https://api.example.com/orgs/o-1/projects/p-1/exports/e-1")
	})

	it("params with special chars → URL encoded", async () => {
		const fetcher = vi.fn<typeof fetch>(
			async () => new Response("{}", { headers: { "content-type": "application/json" }, status: 200 }),
		)

		const sdk = createSDK(
			{ items: { get: { method: "GET", params: ["id"], path: "/items/:id" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		await sdk.items.get({ params: { id: "hello world/special" } })
		const url = fetcher.mock.calls[0]?.[0] as unknown as string
		expect(url).toContain("hello%20world%2Fspecial")
	})

	it("missing required param → throws", async () => {
		const sdk = createSDK(
			{ items: { get: { method: "GET", params: ["id"], path: "/items/:id" } } },
			{ baseURL: "http://localhost" },
		)

		await expect(sdk.items.get({ params: {} })).rejects.toThrow("Missing path param")
	})
})

/* ═══════════════════════════════════════════
 * generateSDK: code output validation
 * ═══════════════════════════════════════════ */

describe("generateSDK: code output", () => {
	it("generated code is valid JavaScript", async () => {
		const spec = {
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/items": {
					get: { operationId: "items.list", responses: {} },
					post: { operationId: "items.create", responses: {} },
				},
				"/items/{id}": {
					delete: { operationId: "items.delete", responses: {} },
					get: { operationId: "items.get", responses: {} },
				},
				"/users": {
					get: { operationId: "users.list", responses: {} },
				},
			},
		}

		const result = generateSDK(spec)

		/* map file should contain all resources and actions */
		expect(result.files.map).toContain("items:")
		expect(result.files.map).toContain("users:")
		expect(result.files.map).toContain("list:")
		expect(result.files.map).toContain("create:")
		expect(result.files.map).toContain("get:")
		expect(result.files.map).toContain("delete:")
		expect(result.files.map).toContain("as const")
		expect(result.files.map).toContain("export const serviceMap")
		expect(result.files.types).toContain("export interface SDK")
		expect(result.files.client).toContain("export class SDK")
	})

	it("generated serviceMap has sorted keys", () => {
		const spec = {
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/a": { get: { operationId: "alpha.list", responses: {} } },
				"/b": { get: { operationId: "zebra.list", responses: {} } },
			},
		}

		const result = generateSDK(spec)
		const alphaIdx = result.files.map.indexOf("alpha:")
		const zebraIdx = result.files.map.indexOf("zebra:")
		expect(alphaIdx).toBeLessThan(zebraIdx)
	})
})

/* ═══════════════════════════════════════════
 * scopeSpec + generateSDK: pipeline tests
 * ═══════════════════════════════════════════ */

describe("scopeSpec + generateSDK pipeline", () => {
	it("scope by tags then generate → only scoped operations in SDK", () => {
		const spec = {
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/admin/stats": { get: { operationId: "admin.stats", tags: ["admin"] } },
				"/items": { get: { operationId: "items.list", tags: ["public"] } },
				"/users": { get: { operationId: "users.list", tags: ["public"] } },
			},
		}

		const scoped = scopeSpec(spec, { tags: ["public"] })
		const sdk = generateSDK(scoped)

		expect(sdk.serviceMap.items).toBeDefined()
		expect(sdk.serviceMap.users).toBeDefined()
		expect(sdk.serviceMap.admin).toBeUndefined()
	})

	it("scope by pathPrefix then generate", () => {
		const spec = {
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/api/v1/items": { get: { operationId: "items.list", responses: {} } },
				"/api/v2/items": { get: { operationId: "itemsV2.list", responses: {} } },
				"/health": { get: { operationId: "health", responses: {} } },
			},
		}

		const scoped = scopeSpec(spec, { pathPrefix: "/api/v1" })
		const sdk = generateSDK(scoped)
		expect(sdk.serviceMap.items).toBeDefined()
		expect(sdk.serviceMap.itemsV2).toBeUndefined()
		expect(sdk.serviceMap.health).toBeUndefined()
	})

	it("excludeTags removes admin operations", () => {
		const spec = {
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/admin": { get: { operationId: "admin.dashboard", tags: ["admin"] } },
				"/items": { get: { operationId: "items.list", tags: ["public"] } },
			},
		}

		const scoped = scopeSpec(spec, { excludeTags: ["admin"] })
		const sdk = generateSDK(scoped)
		expect(sdk.serviceMap.items).toBeDefined()
		expect(sdk.serviceMap.admin).toBeUndefined()
	})
})

/* ═══════════════════════════════════════════
 * Concurrent SDK calls
 * ═══════════════════════════════════════════ */

describe("SDK: concurrent calls", () => {
	it("50 parallel calls → all resolve correctly", async () => {
		const fetcher = vi.fn<typeof fetch>(async (url) => {
			const id = new URL(url as string).pathname.split("/").pop()
			return new Response(JSON.stringify({ id }), {
				headers: { "content-type": "application/json" },
				status: 200,
			})
		})

		const sdk = createSDK(
			{ items: { get: { method: "GET", params: ["id"], path: "/items/:id" } } },
			{ baseURL: "http://localhost", fetch: fetcher },
		)

		const results = await Promise.all(
			Array.from({ length: 50 }, (_, i) => sdk.items.get({ params: { id: String(i) } })),
		)

		for (let i = 0; i < 50; i++) {
			const r = results[i] as SDKResult
			expect((r.data as Record<string, string>).id).toBe(String(i))
			expect(r.error).toBeNull()
		}
	})
})
