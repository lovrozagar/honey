import { describe, expect, expectTypeOf, it, vi } from "vitest"
import * as z from "zod"
import { isClientError } from "../../../src/client/error.ts"
import { createClient } from "../../../src/client/index.ts"
import type { InputFor, OutputFor, PathsForMethod } from "../../../src/client/types.ts"
import { honey } from "../../../src/index.ts"

/* ---- test app for type-level tests ---- */
function createTestApp() {
	return honey<{}>()
		.get("/health")
		.handler((ctx) => ctx.res.text("ok", "healthy"))

		.get("/users")
		.input({ search: z.object({ limit: z.string().optional(), page: z.string().optional() }) })
		.output({
			"application/json": {
				ok: z.object({
					items: z.array(z.object({ id: z.string(), name: z.string() })),
					total: z.number(),
				}),
			},
		})
		.handler((ctx) => ctx.res.json("ok", { items: [], total: 0 }))

		.post("/users")
		.input({ json: z.object({ email: z.string(), name: z.string() }) })
		.output({ "application/json": { created: z.object({ id: z.string() }) } })
		.handler((ctx) => ctx.res.json("created", { id: "1" }))

		.get("/users/:userId")
		.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }) } })
		.handler((ctx) => ctx.res.json("ok", { id: ctx.params.userId, name: "Test" }))

		.delete("/users/:userId")
		.handler((ctx) => ctx.res.noContent())

		.put("/users/:userId")
		.input({ json: z.object({ name: z.string() }) })
		.handler((ctx) => ctx.res.json("ok", { id: ctx.params.userId }))

		.patch("/users/:userId/settings")
		.input({ json: z.object({ theme: z.enum(["light", "dark"]) }) })
		.handler((ctx) => ctx.res.json("ok", { theme: "light" }))
}

type TestApp = ReturnType<typeof createTestApp>

/* ---- type-level tests ---- */

describe("client type utilities", () => {
	it("PathsForMethod extracts correct paths for GET", () => {
		type Routes = TestApp["$routes"]
		type GetPaths = PathsForMethod<Routes, "get">

		expectTypeOf<"/health">().toMatchTypeOf<GetPaths>()
		expectTypeOf<"/users">().toMatchTypeOf<GetPaths>()
		expectTypeOf<"/users/:userId">().toMatchTypeOf<GetPaths>()
	})

	it("PathsForMethod extracts correct paths for POST", () => {
		type Routes = TestApp["$routes"]
		type PostPaths = PathsForMethod<Routes, "post">

		expectTypeOf<"/users">().toMatchTypeOf<PostPaths>()
	})

	it("PathsForMethod excludes non-existent method+path combos", () => {
		type Routes = TestApp["$routes"]
		type DeletePaths = PathsForMethod<Routes, "delete">

		expectTypeOf<"/users/:userId">().toMatchTypeOf<DeletePaths>()
	})

	it("InputFor extracts input schema types", () => {
		type Routes = TestApp["$routes"]
		type PostInput = InputFor<Routes, "/users", "post">

		expectTypeOf<PostInput>().toMatchTypeOf<{
			json: { email: string; name: string }
		}>()
	})

	it("InputFor extracts search params", () => {
		type Routes = TestApp["$routes"]
		type GetInput = InputFor<Routes, "/users", "get">

		expectTypeOf<GetInput>().toMatchTypeOf<{
			search: { limit?: string; page?: string }
		}>()
	})

	it("OutputFor infers typed response from output schema", () => {
		type Routes = TestApp["$routes"]
		type GetUsersOutput = OutputFor<Routes, "/users", "get">

		expectTypeOf<GetUsersOutput>().toMatchTypeOf<{
			items: Array<{ id: string; name: string }>
			total: number
		}>()
	})

	it("OutputFor infers created response", () => {
		type Routes = TestApp["$routes"]
		type PostUsersOutput = OutputFor<Routes, "/users", "post">

		expectTypeOf<PostUsersOutput>().toMatchTypeOf<{ id: string }>()
	})

	it("OutputFor returns unknown for routes without .output()", () => {
		type Routes = TestApp["$routes"]
		type HealthOutput = OutputFor<Routes, "/health", "get">

		expectTypeOf<HealthOutput>().toEqualTypeOf<null>()
	})
})

/* ---- runtime tests ---- */

describe("createClient", () => {
	it("returns object with HTTP method functions", () => {
		const client = createClient<TestApp, true>({
			baseURL: "https://api.test.com",
			fetch: vi.fn(),
			throwOnError: true,
		})

		expect(typeof client.get).toBe("function")
		expect(typeof client.post).toBe("function")
		expect(typeof client.put).toBe("function")
		expect(typeof client.patch).toBe("function")
		expect(typeof client.delete).toBe("function")
		expect(typeof client.ws).toBe("function")
	})

	it("GET request returns parsed JSON", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ items: [{ id: "1", name: "Alice" }], total: 1 }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		)

		const client = createClient<TestApp, true>({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		const result = await client.get("/users", { search: { limit: "10" } })
		expect(result).toEqual({ items: [{ id: "1", name: "Alice" }], total: 1 })

		const [url, init] = fetchFn.mock.calls[0]
		expect(url).toContain("/users")
		expect(url).toContain("limit=10")
		expect(init.method).toBe("GET")
	})

	it("POST request sends JSON body", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ id: "new-1" }), {
				headers: { "content-type": "application/json" },
				status: 201,
			}),
		)

		const client = createClient<TestApp, true>({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		const result = await client.post("/users", { json: { email: "a@b.com", name: "Alice" } })
		expect(result).toEqual({ id: "new-1" })

		const [, init] = fetchFn.mock.calls[0]
		expect(init.method).toBe("POST")
		expect(init.headers.get("content-type")).toBe("application/json")
		expect(JSON.parse(init.body)).toEqual({ email: "a@b.com", name: "Alice" })
	})

	it("DELETE request works", async () => {
		const fetchFn = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))

		const client = createClient<TestApp, true>({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		const result = await client.delete("/users/:userId", { params: { userId: "42" } })
		expect(result).toBeNull()

		const [url] = fetchFn.mock.calls[0]
		expect(url).toContain("/users/42")
	})

	it("throws ClientError on error responses", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error_key: "not_found",
					fields: {},
					message: "User not found",
					status: 404,
					status_key: "not_found",
				}),
				{ headers: { "content-type": "application/json" }, status: 404 },
			),
		)

		const client = createClient<TestApp, true>({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		try {
			await client.get("/users/:userId", { params: { userId: "999" } })
			expect.fail("should have thrown")
		} catch (e) {
			expect(isClientError(e)).toBe(true)
			if (isClientError(e)) {
				expect((e.body as Record<string, unknown>).error_key).toBe("not_found")
				expect(e.status).toBe(404)
			}
		}
	})

	it("passes custom headers from config", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ ok: true }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		)

		const client = createClient<TestApp, true>({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			headers: { authorization: "Bearer xyz" },
			throwOnError: true,
		})

		await client.get("/health")

		const [, init] = fetchFn.mock.calls[0]
		expect(init.headers.get("authorization")).toBe("Bearer xyz")
	})

	it("interpolates path params in URL", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ id: "42", name: "Alice" }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		)

		const client = createClient<TestApp, true>({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		await client.get("/users/:userId", { params: { userId: "42" } })

		const [url] = fetchFn.mock.calls[0]
		expect(url).toBe("https://api.test.com/users/42")
	})

	it("PUT request with json body and params", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ id: "42" }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		)

		const client = createClient<TestApp, true>({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		await client.put("/users/:userId", {
			json: { name: "Updated" },
			params: { userId: "42" },
		})

		const [url, init] = fetchFn.mock.calls[0]
		expect(url).toBe("https://api.test.com/users/42")
		expect(init.method).toBe("PUT")
		expect(JSON.parse(init.body)).toEqual({ name: "Updated" })
	})

	it("PATCH request works", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ theme: "dark" }), {
				headers: { "content-type": "application/json" },
				status: 200,
			}),
		)

		const client = createClient<TestApp, true>({
			baseURL: "https://api.test.com",
			fetch: fetchFn,
			throwOnError: true,
		})

		await client.patch("/users/:userId/settings", {
			json: { theme: "dark" },
			params: { userId: "42" },
		})

		const [url, init] = fetchFn.mock.calls[0]
		expect(url).toBe("https://api.test.com/users/42/settings")
		expect(init.method).toBe("PATCH")
	})
})
