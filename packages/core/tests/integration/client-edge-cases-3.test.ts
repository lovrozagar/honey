import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { WebSocket } from "ws"
import { createApp } from "@honey/e2e-kitchen"
import { ClientError, isClientError } from "../../src/client/error.ts"
import { createClient } from "../../src/client/index.ts"
import type { SSEEvent } from "../../src/client/sse.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { nodeWebSocket } from "../../src/ws/node.ts"

let server: HoneyServer
let baseURL: string

beforeAll(() => {
	const app = createApp(nodeWebSocket())
	server = serve(app, { env: {}, port: 0 })
	const addr = server.address() as { port: number }
	baseURL = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
	await server.shutdown(1000)
})

describe("edge: chained CRUD operations — data integrity", () => {
	it("create 3 orgs, list, delete 1, list again — counts correct", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		})

		const slugs = [`chain-a-${Date.now()}`, `chain-b-${Date.now()}`, `chain-c-${Date.now()}`]
		const ids: string[] = []

		/* create 3 */
		for (const slug of slugs) {
			const { data, error } = await api.post("/api/v1/organizations", {
				json: { name: slug, slug },
			})
			expect(error).toBeNull()
			ids.push((data as unknown as { id: string }).id)
		}

		/* list — should have at least 3 (plus "acme" default) */
		const list1 = await api.get("/api/v1/organizations")
		expect(list1.error).toBeNull()
		const total1 = (list1.data as unknown as { total: number }).total
		expect(total1).toBeGreaterThanOrEqual(4)

		/* delete middle one */
		const del = await api.delete("/api/v1/organizations/:orgId", {
			params: { orgId: ids[1] },
		})
		expect(del.error).toBeNull()
		expect(del.status).toBe(204)

		/* list — should be one less */
		const list2 = await api.get("/api/v1/organizations")
		expect(list2.error).toBeNull()
		expect((list2.data as unknown as { total: number }).total).toBe(total1 - 1)

		/* deleted org returns error */
		const gone = await api.get("/api/v1/organizations/:orgId", {
			params: { orgId: ids[1] },
		})
		expect(gone.error).not.toBeNull()
	})
})

describe("edge: interceptor chain ordering with retry", () => {
	it("onRequest runs again on retry, onResponse sees retried response", async () => {
		const log: string[] = []
		let attempt = 0

		const api = createClient({
			baseURL,
			headers: () => {
				attempt++
				if (attempt === 1) return {}
				return { authorization: "Bearer test" }
			},
			onRequest: [
				(ctx) => {
					log.push(`req:${ctx.method}:attempt${attempt}`)
				},
			],
			onResponse: [
				async (ctx) => {
					log.push(`res:${ctx.response.status}:retry=${ctx.isRetry}`)
					if (ctx.response.status === 401 && !ctx.isRetry) {
						return ctx.retry()
					}
					return undefined
				},
			],
			throwOnError: true,
		})

		await api.get("/api/v1/organizations")

		expect(log).toEqual([
			"req:GET:attempt1",
			"res:401:retry=false",
			"req:GET:attempt2",
			"res:200:retry=true",
		])
	})
})

describe("edge: SSE collect all fields", () => {
	it("events have data, event, id fields", async () => {
		const api = createClient({ baseURL })
		const stream = api.get("/api/events") as unknown as AsyncIterable<SSEEvent>
		const events: SSEEvent[] = []
		for await (const event of stream) {
			events.push(event)
		}

		expect(events.length).toBeGreaterThanOrEqual(2)
		for (const evt of events) {
			expect(typeof evt.data).toBe("string")
			expect(evt.data.length).toBeGreaterThan(0)
		}

		const withIds = events.filter((e) => e.id !== undefined)
		expect(withIds.length).toBeGreaterThanOrEqual(2)
	})
})

describe("edge: throw mode error shape matches tuple mode", () => {
	it("same errorKey/status in both modes", async () => {
		const tupleApi = createClient({ baseURL })
		const throwApi = createClient({ baseURL, throwOnError: true })

		/* tuple mode */
		const tupleResult = await tupleApi.get("/api/nonexistent")

		/* throw mode */
		let throwError: unknown
		try {
			await throwApi.get("/api/nonexistent")
		} catch (e) {
			throwError = e
		}

		expect(tupleResult.error).not.toBeNull()
		expect(isClientError(throwError)).toBe(true)
		expect((tupleResult.error as Record<string, unknown>)?.error_key).toBe((((throwError as ClientError).body) as Record<string, unknown>).error_key)
		expect(tupleResult.status).toBe((throwError as { status: number }).status)
	})
})

describe("edge: WebSocket with path params via native ws", () => {
	it("authenticated WS with authed route", async () => {
		const wsUrl = `${baseURL.replace("http", "ws")}/api/v1/socket`
		const ws = new WebSocket(wsUrl, {
			headers: { authorization: "Bearer test" },
		})

		const messages: string[] = []
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("WS timeout")), 5000)
			ws.on("message", (data: Buffer) => {
				messages.push(data.toString())
				clearTimeout(timer)
				ws.close()
				resolve()
			})
			ws.on("error", (err) => {
				clearTimeout(timer)
				reject(err)
			})
		})

		const parsed = JSON.parse(messages[0]) as { event: string; user: string }
		expect(parsed.event).toBe("welcome")
		expect(parsed.user).toBe("u1")
	})
})

describe("edge: $url with all features combined", () => {
	it("baseURL prefix + params + search + sort", () => {
		const api = createClient({
			baseURL: `${baseURL}/api`,
			sortSearchParams: true,
		})

		const url = api.$url("/v1/organizations/:orgId", {
			params: { orgId: "org-1" },
			search: { a: "first", z: "last" },
		})

		expect(url).toContain("/api/v1/organizations/org-1")
		/* sorted */
		const qs = new URL(url).search
		expect(qs).toBe("?a=first&z=last")
	})

	it("$path with same params", () => {
		const api = createClient({ baseURL: `${baseURL}/api`, sortSearchParams: true })
		const path = api.$path("/v1/organizations/:orgId", {
			params: { orgId: "org-1" },
			search: { a: "1", z: "3" },
		})
		expect(path).toBe("/v1/organizations/org-1?a=1&z=3")
	})
})

describe("edge: response status is numeric", () => {
	it("success status is number 200", async () => {
		const api = createClient({ baseURL })
		const { status } = await api.get("/api/health")
		expect(status).toBe(200)
		expect(typeof status).toBe("number")
	})

	it("error status is number 404", async () => {
		const api = createClient({ baseURL })
		const { status } = await api.get("/api/nonexistent")
		expect(status).toBe(404)
		expect(typeof status).toBe("number")
	})

	it("created status is number 201", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		})
		const { status } = await api.post("/api/v1/organizations", {
			json: { name: "StatusCheck", slug: `status-${Date.now()}` },
		})
		expect(status).toBe(201)
	})
})

describe("edge: interceptors don't leak state between requests", () => {
	it("onRequest called fresh each time", async () => {
		const callPaths: string[] = []
		const api = createClient({
			baseURL,
			onRequest: [
				(ctx) => {
					callPaths.push(ctx.path)
				},
			],
		})

		await api.get("/api/health")
		await api.get("/api/echo")
		await api.get("/api/health")

		expect(callPaths).toEqual(["/api/health", "/api/echo", "/api/health"])
	})
})

describe("edge: empty string path param", () => {
	it("empty string param does not crash — server handles it", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		})
		const result = await api.get("/api/v1/organizations/:orgId", {
			params: { orgId: "" },
		})
		/* empty param → resolves to /api/v1/organizations/ → list route or 404 */
		/* either way: no crash, valid response */
		expect(result.status).toBeGreaterThanOrEqual(200)
		expect(result.status).toBeLessThan(600)
	})
})

describe("edge: multiple error formats", () => {
	it("validation error has fields, not_found does not", async () => {
		const api = createClient({
			baseURL,
			headers: { authorization: "Bearer test" },
		})

		/* validation error — has field-level errors */
		const validation = await api.post("/api/v1/organizations", { json: {} })
		expect((validation.error as Record<string, unknown>)?.error_key).toBe("invalid_input")
		expect(Object.keys(((validation.error as Record<string, unknown>)?.fields as Record<string, unknown>) ?? {}).length).toBeGreaterThan(0)

		/* not found — no fields */
		const notFound = await api.get("/api/v1/organizations/:orgId", {
			params: { orgId: "nope" },
		})
		expect(notFound.error).not.toBeNull()
		expect(Object.keys(((notFound.error as Record<string, unknown>)?.fields as Record<string, unknown>) ?? {}).length).toBe(0)
	})
})
