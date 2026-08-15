import { describe, expect, it } from "vitest"
import { app } from "@honey/demo-2"
import { createSDK } from "../../../src/client/sdk.ts"
import { generateOpenApi, generateSDK } from "../../../src/codegen.ts"

type SDKResult = { data: unknown; error: unknown; response: Response; status: number }

/**
 * REAL consumer test using the actual demo-2 app.
 * No mocking — real routes, real handlers, real app.fetch().
 */

const ENV = { API_KEY: "test-key", DATABASE_URL: "postgres://localhost/test" }

describe("SDK with real demo-2 app", () => {
	it("generates SDK from demo-2 OpenAPI spec", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		/* routes with operationId should appear */
		expect(serviceMap.input).toBeDefined()
		expect(serviceMap.resources).toBeDefined()

		/* input resource actions */
		expect(serviceMap.input.createJson).toBeDefined()
		expect(serviceMap.input.createForm).toBeDefined()
		expect(serviceMap.input.search).toBeDefined()
		expect(serviceMap.input.none).toBeDefined()

		/* resources CRUD */
		expect(serviceMap.resources.list).toBeDefined()
		expect(serviceMap.resources.create).toBeDefined()
		expect(serviceMap.resources.update).toBeDefined()
		expect(serviceMap.resources.patch).toBeDefined()
		expect(serviceMap.resources.delete).toBeDefined()
	})

	it("SDK calls demo-2 JSON input route via app.fetch", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), ENV),
		})

		const { data } = (await sdk.input.createJson({
			json: { email: "alice@test.com", name: "Alice" },
		})) as SDKResult
		expect((data as Record<string, string>).id).toBe("1")
	})

	it("SDK calls demo-2 no-input route", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), ENV),
		})

		const { data } = (await sdk.input.none()) as SDKResult
		expect((data as Record<string, string>).ping).toBe("pong")
	})

	it("SDK calls demo-2 resources.list", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), ENV),
		})

		const { data } = (await sdk.resources.list()) as SDKResult
		expect((data as Record<string, unknown>).items).toEqual([])
	})

	it("SDK calls demo-2 resources.create with JSON body", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), ENV),
		})

		const { data } = (await sdk.resources.create({
			json: { name: "Widget" },
		})) as SDKResult
		expect((data as Record<string, string>).id).toBe("1")
	})

	it("SDK calls demo-2 resources.update with params + JSON", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), ENV),
		})

		const { data } = (await sdk.resources.update({
			json: { name: "Updated" },
			params: { id: "42" },
		})) as SDKResult
		const result = data as Record<string, string>
		expect(result.id).toBe("42")
		expect(result.name).toBe("Updated")
	})

	it("SDK calls demo-2 resources.delete → 204", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), ENV),
		})

		const result = (await sdk.resources.delete({ params: { id: "1" } })) as SDKResult
		expect(result.data).toBeNull()
		expect(result.error).toBeNull()
	})

	it("SDK calls demo-2 resources.patch", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), ENV),
		})

		const { data } = (await sdk.resources.patch({
			json: { name: "Patched" },
			params: { id: "7" },
		})) as SDKResult
		expect((data as Record<string, string>).id).toBe("7")
	})

	it("SDK validation error from demo-2 → returns error in tuple", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), ENV),
		})

		/* missing required 'email' field */
		const result = (await sdk.input.createJson({ json: { name: "Alice" } })) as SDKResult
		expect(result.data).toBeNull()
		expect(result.error).not.toBeNull()
		expect(result.status).toBe(400)
		/* input validation uses the framework validation_failed key */
		expect((result.error as Record<string, unknown>)?.error_key).toBe("validation_failed")
	})

	it("generated code contains demo-2 operations", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { files } = generateSDK(spec)

		expect(files.map).toContain("input:")
		expect(files.map).toContain("resources:")
		expect(files.map).toContain("createJson:")
		expect(files.map).toContain("list:")
		expect(files.map).toContain("update:")
		expect(files.map).toContain("as const")
	})

	it("routes without operationId excluded from SDK", async () => {
		const spec = await generateOpenApi(app, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		/* routes like /in/headers, /out/text etc have no operationId → not in serviceMap */
		const allActions = Object.values(serviceMap).flatMap((r) => Object.keys(r))
		/* should not contain any path-looking keys */
		expect(allActions.every((a) => !a.startsWith("/"))).toBe(true)
	})
})
