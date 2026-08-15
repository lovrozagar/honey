import { describe, expect, it } from "vitest"
import * as z from "zod"

const hasZodJsonSchema = typeof (z as Record<string, unknown>).toJSONSchema === "function"

import { app as demo2App } from "@honey/demo-2"
import { createSDK } from "../../../src/client/sdk.ts"
import { generateOpenApi, generateSDK } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"

/* ═══════════════════════════════════════════
 * WS: OpenAPI generation with x-websocket
 * ═══════════════════════════════════════════ */

describe("WS: OpenAPI spec generation", () => {
	it("WS routes appear in OpenAPI with x-websocket: true", async () => {
		const app = honey<{}>()
		app
			.ws("/ws/echo")
			.meta({ operationId: "ws.echo", tags: ["ws"] })
			.handler({
				onMessage(_ctx, ws, data) {
					ws.send(data)
				},
			})

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		expect(spec.paths["/ws/echo"]).toBeDefined()
		expect(spec.paths["/ws/echo"].get["x-websocket"]).toBe(true)
		expect(spec.paths["/ws/echo"].get.operationId).toBe("ws.echo")
	})

	it("WS route with path params → params in OpenAPI", async () => {
		const app = honey<{}>()
		app
			.ws("/ws/chat/:channelId")
			.meta({ operationId: "ws.chat", tags: ["ws"] })
			.handler({ onMessage() {} })

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const wsOp = spec.paths["/ws/chat/{channelId}"].get
		expect(wsOp["x-websocket"]).toBe(true)
		const params = wsOp.parameters as Array<Record<string, unknown>>
		expect(params.some((p) => p.name === "channelId")).toBe(true)
	})

	it.skipIf(!hasZodJsonSchema)("WS route with search input → query params in OpenAPI", async () => {
		const app = honey<{}>()
		app
			.ws("/ws/room")
			.meta({ operationId: "ws.joinRoom" })
			.input({ search: z.object({ roomId: z.string() }) })
			.handler({ onMessage() {} })

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const wsOp = spec.paths["/ws/room"].get
		const params = wsOp.parameters as Array<Record<string, unknown>>
		expect(params.some((p) => p.name === "roomId" && p.in === "query")).toBe(true)
	})

	it("WS route without operationId → in OpenAPI but not in SDK", async () => {
		const app = honey<{}>()
		app.ws("/ws/internal").handler({ onMessage() {} })

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		expect(spec.paths["/ws/internal"]).toBeDefined()
		expect(spec.paths["/ws/internal"].get["x-websocket"]).toBe(true)

		const { serviceMap } = generateSDK(spec)
		expect(Object.keys(serviceMap)).toHaveLength(0)
	})

	it("WS routes have 101 response", async () => {
		const app = honey<{}>()
		app
			.ws("/ws/test")
			.meta({ operationId: "ws.test" })
			.handler({ onMessage() {} })

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const responses = spec.paths["/ws/test"].get.responses as Record<string, unknown>
		expect(responses["101"]).toBeDefined()
	})
})

/* ═══════════════════════════════════════════
 * WS: SDK generation
 * ═══════════════════════════════════════════ */

describe("WS: SDK generation", () => {
	it("x-websocket operation → ws: true in serviceMap", () => {
		const spec = {
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/ws/echo": {
					get: { operationId: "ws.echo", responses: {}, "x-websocket": true },
				},
			},
		}

		const { serviceMap } = generateSDK(spec)
		expect(serviceMap.ws.echo.ws).toBe(true)
		expect(serviceMap.ws.echo.method).toBe("GET")
	})

	it("WS with path params → params extracted", () => {
		const spec = {
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/ws/chat/{channelId}": {
					get: { operationId: "ws.chat", responses: {}, "x-websocket": true },
				},
			},
		}

		const { serviceMap } = generateSDK(spec)
		expect(serviceMap.ws.chat.params).toEqual(["channelId"])
	})

	it("generated code includes ws: true and TypedWebSocket import", () => {
		const spec = {
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/ws/echo": {
					get: { operationId: "ws.echo", responses: {}, "x-websocket": true },
				},
			},
		}

		const { files } = generateSDK(spec)
		expect(files.map).toContain("ws: true")
		expect(files.types).toContain("TypedWebSocket")
		/* Phase A (#1) adds WS suffix fields so echo now takes an optional input */
		expect(files.types).toContain("echo(input?:")
		expect(files.types).toContain("): TypedWebSocket")
	})

	it("generated code has WS params typed", () => {
		const spec = {
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/ws/chat/{channelId}": {
					get: {
						operationId: "ws.chat",
						parameters: [
							{ in: "path", name: "channelId", required: true, schema: { type: "string" } },
						],
						responses: {},
						"x-websocket": true,
					},
				},
			},
		}

		const { files } = generateSDK(spec)
		/* Phase A (#1) adds WS suffix fields after params; assert params still present */
		expect(files.types).toContain("chat(input: { params: { channelId: string }")
		expect(files.types).toContain("): TypedWebSocket")
	})

	it("mixed HTTP + WS + SSE in same SDK", () => {
		const spec = {
			info: { title: "Test", version: "1.0" },
			openapi: "3.1.0",
			paths: {
				"/items": {
					get: {
						operationId: "items.list",
						responses: { "200": { content: { "application/json": { schema: {} } } } },
					},
				},
				"/stream": {
					get: {
						operationId: "events.stream",
						responses: { "200": { content: { "text/event-stream": {} } } },
					},
				},
				"/ws/live": { get: { operationId: "ws.live", responses: {}, "x-websocket": true } },
			},
		}

		const { serviceMap } = generateSDK(spec)
		expect(serviceMap.items.list.ws).toBeUndefined()
		expect(serviceMap.items.list.sse).toBeUndefined()
		expect(serviceMap.events.stream.sse).toBe(true)
		expect(serviceMap.ws.live.ws).toBe(true)
	})
})

/* ═══════════════════════════════════════════
 * WS: createSDK proxy
 * ═══════════════════════════════════════════ */

describe("WS: createSDK proxy", () => {
	it("ws action returns object with send/close/on methods", () => {
		const sdk = createSDK(
			{ ws: { echo: { method: "GET", path: "/ws/echo", ws: true } } },
			{ baseURL: "ws://localhost:3000" },
		)

		/* can't actually connect without a server, but verify the proxy returns a WS-like object */
		const wsObj = sdk.ws.echo() as { close: unknown; on: unknown; send: unknown }
		expect(wsObj).toBeDefined()
		expect(typeof wsObj.send).toBe("function")
		expect(typeof wsObj.close).toBe("function")
		expect(typeof wsObj.on).toBe("function")
	})

	it("ws action with params interpolates URL", () => {
		let capturedUrl = ""
		/* monkey-patch WebSocket to capture URL */
		const OrigWS = globalThis.WebSocket
		globalThis.WebSocket = class extends OrigWS {
			constructor(url: string | URL, protocols?: string | string[]) {
				capturedUrl = String(url)
				super(url, protocols)
			}
		} as typeof WebSocket

		try {
			const sdk = createSDK(
				{
					ws: {
						chat: { method: "GET", params: ["channelId"], path: "/ws/chat/:channelId", ws: true },
					},
				},
				{ baseURL: "http://localhost:3000" },
			)
			try {
				sdk.ws.chat({ params: { channelId: "general" } })
			} catch {
				/* connection will fail but URL should be captured */
			}
			expect(capturedUrl).toContain("ws://localhost:3000/ws/chat/general")
		} finally {
			globalThis.WebSocket = OrigWS
		}
	})
})

/* ═══════════════════════════════════════════
 * REAL APP: demo-2 WS in SDK pipeline
 * ═══════════════════════════════════════════ */

describe("demo-2: WS routes in SDK", () => {
	it("demo-2 WS routes appear in OpenAPI with x-websocket", async () => {
		const spec = await generateOpenApi(demo2App, { info: { title: "Demo 2", version: "1.0" } })

		const wsRoutes = Object.entries(spec.paths)
			.filter(([_, methods]) => {
				const m = methods as Record<string, Record<string, unknown>>
				return m.get?.["x-websocket"] === true
			})
			.map(([path]) => path)

		expect(wsRoutes).toContain("/ws/echo")
		expect(wsRoutes).toContain("/ws/room")
		expect(wsRoutes).toContain("/ws/reconnect")
		expect(wsRoutes).toContain("/ws/chat/{channelId}")
	})

	it("demo-2 WS routes in SDK serviceMap", async () => {
		const spec = await generateOpenApi(demo2App, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		expect(serviceMap.ws).toBeDefined()
		expect(serviceMap.ws.echo).toBeDefined()
		expect(serviceMap.ws.echo.ws).toBe(true)
		expect(serviceMap.ws.joinRoom).toBeDefined()
		expect(serviceMap.ws.joinRoom.ws).toBe(true)
		expect(serviceMap.ws.reconnect).toBeDefined()
		expect(serviceMap.ws.chat).toBeDefined()
		expect(serviceMap.ws.chat.params).toEqual(["channelId"])
	})

	it("demo-2 generated SDK code has WS types", async () => {
		const spec = await generateOpenApi(demo2App, { info: { title: "Demo 2", version: "1.0" } })
		const { files } = generateSDK(spec)

		/* Phase A (#1) adds WS suffix fields so echo now takes an optional input */
		expect(files.types).toContain("echo(input?:")
		expect(files.types).toContain("joinRoom(")
		/* Phase A (#1): params followed by suffix fields */
		expect(files.types).toContain("chat(input: { params: { channelId: string }")
		expect(files.types).toContain("export type TypedWebSocket")
	})

	it("demo-2 SDK has HTTP + WS resources coexisting", async () => {
		const spec = await generateOpenApi(demo2App, { info: { title: "Demo 2", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		/* HTTP resources */
		expect(serviceMap.input).toBeDefined()
		expect(serviceMap.resources).toBeDefined()

		/* WS resources */
		expect(serviceMap.ws).toBeDefined()

		/* HTTP routes are NOT WS */
		expect(serviceMap.input.createJson.ws).toBeUndefined()
		expect(serviceMap.resources.list.ws).toBeUndefined()
	})
})

/* ═══════════════════════════════════════════
 * SSE: SDK generation
 * ═══════════════════════════════════════════ */

describe("SSE: SDK generation", () => {
	it("SSE route → sse: true in serviceMap", async () => {
		const app = honey<{}>()
		app
			.get("/events")
			.meta({ operationId: "events.stream" })
			.output({ "text/event-stream": { ok: z.string() } })
			.handler((ctx) =>
				ctx.res.sse(async (stream) => {
					await stream.send({ data: "test", event: "msg" })
					stream.close()
				}),
			)

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)
		expect(serviceMap.events.stream.sse).toBe(true)
		expect(serviceMap.events.stream.ws).toBeUndefined()
	})

	it("SSE generated type is AsyncIterable", async () => {
		const app = honey<{}>()
		app
			.get("/events")
			.meta({ operationId: "events.stream" })
			.output({ "text/event-stream": { ok: z.string() } })
			.handler((ctx) =>
				ctx.res.sse(async (stream) => {
					stream.close()
				}),
			)

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const { files } = generateSDK(spec)
		expect(files.types).toContain("stream(")
		expect(files.types).toContain("AsyncIterable")
	})

	it("SSE via SDK returns async iterable from real app", async () => {
		const app = honey<{}>()
		app
			.get("/events")
			.meta({ operationId: "events.stream" })
			.output({ "text/event-stream": { ok: z.string() } })
			.handler((ctx) =>
				ctx.res.sse(async (stream) => {
					await stream.send({ data: "hello", event: "msg", id: "1" })
					await stream.send({ data: "world", event: "msg", id: "2" })
					stream.close()
				}),
			)

		const spec = await generateOpenApi(app, { info: { title: "Test", version: "1.0" } })
		const { serviceMap } = generateSDK(spec)

		const sdk = createSDK(serviceMap, {
			baseURL: "http://localhost",
			fetch: (url, init) => app.fetch(new Request(url as string, init), {}),
		})

		const events: Array<{ data: string; event: string }> = []
		for await (const evt of sdk.events.stream() as AsyncIterable<{ data: string; event: string }>) {
			events.push(evt)
		}

		expect(events.length).toBeGreaterThanOrEqual(2)
		expect(events[0].event).toBe("msg")
		expect(events[0].data).toBe("hello")
		expect(events[1].data).toBe("world")
	})
})
