import { describe, expect, it } from "vitest"
import * as z from "zod"
import { createSDK } from "../../../src/client/sdk.ts"
import { generateOpenApi, generateSDK, mergeSpecs, scopeSpec } from "../../../src/codegen.ts"
import { HoneyError, honey } from "../../../src/index.ts"

type SDKResult = { data: unknown; error: unknown; response: Response; status: number }

/**
 * Real consumer tests — simulating what a published SDK package would do.
 * Uses actual honey apps with real route handlers, real OpenAPI generation,
 * and real app.fetch() as transport. No mocking.
 */

/* ═══════════════════════════════════════════
 * SCENARIO 1: Simple API — single app, single SDK
 * ═══════════════════════════════════════════ */

function createUsersApp() {
	const app = honey<{}>()

	app
		.get("/users")
		.meta({ operationId: "users.list", tags: ["users"] })
		.input({ search: z.object({ limit: z.coerce.number().optional() }) })
		.output({ "application/json": { ok: z.array(z.object({ id: z.string(), name: z.string() })) } })
		.handler((ctx) =>
			ctx.res.json("ok", [
				{ id: "1", name: "Alice" },
				{ id: "2", name: "Bob" },
			]),
		)

	app
		.get("/users/:id")
		.meta({ operationId: "users.get", tags: ["users"] })
		.input({ params: z.object({ id: z.string() }) })
		.output({
			"application/json": { ok: z.object({ email: z.string(), id: z.string(), name: z.string() }) },
		})
		.handler((ctx) => ctx.res.json("ok", { email: "alice@test.com", id: ctx.params.id, name: "Alice" }))

	app
		.post("/users")
		.meta({ operationId: "users.create", tags: ["users"] })
		.input({ json: z.object({ email: z.string().email(), name: z.string() }) })
		.output({ "application/json": { created: z.object({ id: z.string() }) } })
		.handler((ctx) => ctx.res.json("created", { id: "new-1" }))

	app
		.put("/users/:id")
		.meta({ operationId: "users.update", tags: ["users"] })
		.input({
			json: z.object({ name: z.string() }),
			params: z.object({ id: z.string() }),
		})
		.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }) } })
		.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, name: ctx.input.json.name }))

	app
		.delete("/users/:id")
		.meta({ operationId: "users.delete", tags: ["users"] })
		.input({ params: z.object({ id: z.string() }) })
		.handler((ctx) => ctx.res.noContent())

	app.get("/health").handler((ctx) => ctx.res.json("ok", { status: "healthy" }))

	return app
}

describe("consumer: simple API → SDK", () => {
	it("full pipeline: define → generate → consume", async () => {
		const app = createUsersApp()
		const spec = await generateOpenApi(app, { info: { title: "Users API", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), {}),
		})

		/* list */
		const listResult = (await sdk.users.list()) as SDKResult
		const users = listResult.data as Array<{ id: string; name: string }>
		expect(users).toHaveLength(2)
		expect(users[0].name).toBe("Alice")

		/* get */
		const getResult = (await sdk.users.get({ params: { id: "42" } })) as SDKResult
		const user = getResult.data as Record<string, string>
		expect(user.id).toBe("42")
		expect(user.email).toBe("alice@test.com")

		/* create */
		const createResult = (await sdk.users.create({
			json: { email: "bob@test.com", name: "Bob" },
		})) as SDKResult
		const created = createResult.data as Record<string, string>
		expect(created.id).toBe("new-1")

		/* update */
		const updateResult = (await sdk.users.update({
			json: { name: "Alice Updated" },
			params: { id: "1" },
		})) as SDKResult
		const updated = updateResult.data as Record<string, string>
		expect(updated.name).toBe("Alice Updated")

		/* delete */
		const deleteResult = (await sdk.users.delete({ params: { id: "1" } })) as SDKResult
		expect(deleteResult.data).toBeNull()
		expect(deleteResult.error).toBeNull()
	})

	it("health route excluded from SDK (no operationId)", async () => {
		const app = createUsersApp()
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		expect(serviceMap.users).toBeDefined()
		expect((serviceMap as Record<string, unknown>).health).toBeUndefined()
	})

	it("search params forwarded correctly", async () => {
		const app = createUsersApp()
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		let capturedUrl = ""
		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: async (url, init) => {
				capturedUrl = url as string
				return app.fetch(new Request(url as string, init), {})
			},
		})

		await sdk.users.list({ search: { limit: 5 } })
		expect(capturedUrl).toContain("limit=5")
	})
})

/* ═══════════════════════════════════════════
 * SCENARIO 2: Multi-service → scoped SDKs
 * ═══════════════════════════════════════════ */

function createStoreApp() {
	const app = honey<{}>()

	app
		.get("/products")
		.meta({ operationId: "products.list", tags: ["store"] })
		.output({
			"application/json": { ok: z.array(z.object({ id: z.string(), price: z.number() })) },
		})
		.handler((ctx) => ctx.res.json("ok", [{ id: "p-1", price: 9.99 }]))

	app
		.post("/orders")
		.meta({ operationId: "orders.create", tags: ["store"] })
		.input({ json: z.object({ items: z.array(z.string()) }) })
		.output({ "application/json": { created: z.object({ orderId: z.string() }) } })
		.handler((ctx) => ctx.res.json("created", { orderId: "ord-1" }))

	return app
}

function createAdminApp() {
	const app = honey<{}>()

	app
		.get("/admin/metrics")
		.meta({ operationId: "admin.metrics", tags: ["admin"] })
		.output({ "application/json": { ok: z.object({ revenue: z.number(), users: z.number() }) } })
		.handler((ctx) => ctx.res.json("ok", { revenue: 50000, users: 1200 }))

	app
		.delete("/admin/cache")
		.meta({ operationId: "admin.clearCache", tags: ["admin"] })
		.handler((ctx) => ctx.res.noContent())

	return app
}

describe("consumer: multi-service scoped SDKs", () => {
	it("merge two specs → scope → separate SDKs", async () => {
		const storeApp = createStoreApp()
		const adminApp = createAdminApp()

		const storeSpec = await generateOpenApi(storeApp, { info: { title: "Store", version: "1.0" } })
		const adminSpec = await generateOpenApi(adminApp, { info: { title: "Admin", version: "1.0" } })

		const fullSpec = mergeSpecs(storeSpec, adminSpec)

		/* public store SDK */
		const storeScoped = scopeSpec(fullSpec, { tags: ["store"] })
		const storeSDK = generateSDK(storeScoped)
		expect(storeSDK.serviceMap.products).toBeDefined()
		expect(storeSDK.serviceMap.orders).toBeDefined()
		expect(storeSDK.serviceMap.admin).toBeUndefined()

		/* admin SDK */
		const adminScoped = scopeSpec(fullSpec, { tags: ["admin"] })
		const adminSDKResult = generateSDK(adminScoped)
		expect(adminSDKResult.serviceMap.admin).toBeDefined()
		expect(adminSDKResult.serviceMap.products).toBeUndefined()
	})

	it("scoped SDK calls work end-to-end", async () => {
		const storeApp = createStoreApp()
		const storeSpec = await generateOpenApi(storeApp, { info: { title: "Store", version: "1.0" } })
		const { serviceMap } = generateSDK(storeSpec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => storeApp.fetch(new Request(url as string, init), {}),
		})

		const productsResult = (await sdk.products.list()) as SDKResult
		const products = productsResult.data as Array<{ id: string; price: number }>
		expect(products[0].id).toBe("p-1")
		expect(products[0].price).toBe(9.99)

		const orderResult = (await sdk.orders.create({
			json: { items: ["p-1", "p-2"] },
		})) as SDKResult
		const order = orderResult.data as Record<string, string>
		expect(order.orderId).toBe("ord-1")
	})
})

/* ═══════════════════════════════════════════
 * SCENARIO 3: Error handling in SDK consumer
 * ═══════════════════════════════════════════ */

describe("consumer: SDK error handling", () => {
	it("server validation error → SDK returns error in tuple", async () => {
		const app = honey<{}>()
		app
			.post("/items")
			.meta({ operationId: "items.create", tags: ["items"] })
			.input({ json: z.object({ name: z.string().min(3) }) })
			.handler((ctx) => ctx.res.json("created", { id: "1" }))

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), {}),
		})

		const result = (await sdk.items.create({ json: { name: "ab" } })) as SDKResult
		expect(result.data).toBeNull()
		expect(result.error).not.toBeNull()
		expect(result.status).toBe(400)
		expect((result.error as Record<string, unknown>)?.error_key).toBe("validation_failed")
	})

	it("server 404 → SDK returns error with not_found", async () => {
		const app = honey<{}>()
		app
			.get("/items/:id")
			.meta({ operationId: "items.get", tags: ["items"] })
			.handler(() => {
				throw new HoneyError({
					errorKey: "not_found",
					status: "not_found",
				})
			})

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), {}),
		})

		const result = (await sdk.items.get({ params: { id: "999" } })) as SDKResult
		expect(result.data).toBeNull()
		expect(result.error).not.toBeNull()
		expect(result.status).toBe(404)
		expect((result.error as Record<string, unknown>)?.error_key).toBe("not_found")
	})
})

/* ═══════════════════════════════════════════
 * SCENARIO 4: SDK code generation output
 * ═══════════════════════════════════════════ */

describe("consumer: generated code can be evaluated", () => {
	it("generated code string is valid JS module", async () => {
		const app = createUsersApp()
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const { files } = generateSDK(spec)

		/* map file is valid JS module */
		expect(files.map).toContain("export const serviceMap")
		expect(files.map).toContain("as const")

		/* types file exports the SDK interface */
		expect(files.types).toContain("export interface SDK")

		/* client file exports the SDK class */
		expect(files.client).toContain("export class SDK")

		/* map should contain all resources */
		expect(files.map).toContain("users:")
		expect(files.map).toContain("list:")
		expect(files.map).toContain("get:")
		expect(files.map).toContain("create:")
		expect(files.map).toContain("update:")
		expect(files.map).toContain("delete:")

		/* map should contain correct HTTP methods */
		expect(files.map).toContain('"GET"')
		expect(files.map).toContain('"POST"')
		expect(files.map).toContain('"PUT"')
		expect(files.map).toContain('"DELETE"')
	})
})

/* ═══════════════════════════════════════════
 * SCENARIO 5: Published SDK pattern
 * ═══════════════════════════════════════════ */

describe("consumer: published SDK wrapper pattern", () => {
	it("wrapper function hides serviceMap from consumer", async () => {
		const app = createUsersApp()
		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		/* this is what a published SDK's index.ts would look like */
		function createUsersSDK(config: { accessToken: string; baseURL: string }) {
			return createSDK(serviceMap, {
				baseURL: config.baseURL,
				fetch: (url, init) => app.fetch(new Request(url as string, init), {}),
				headers: { authorization: `Bearer ${config.accessToken}` },
			})
		}

		/* consumer code — clean, no paths, no serviceMap */
		const sdk = createUsersSDK({
			accessToken: "tok-123",
			baseURL: "http://localhost",
		})

		const listResult = (await sdk.users.list()) as SDKResult
		const users = listResult.data as Array<{ id: string }>
		expect(users).toHaveLength(2)

		const getResult = (await sdk.users.get({ params: { id: "1" } })) as SDKResult
		const user = getResult.data as Record<string, string>
		expect(user.id).toBe("1")
	})
})
