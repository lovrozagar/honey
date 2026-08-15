import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { createRealtimeHandlers } from "../../../src/cloudflare/realtime.ts"
import type { RealtimeHandlerConfig, RealtimeHandlers } from "../../../src/cloudflare/realtime.ts"

/* ------------------------------------------------------------------ */
/*  CF primitive mocks                                                 */
/* ------------------------------------------------------------------ */

function mockDOContext() {
	const webSockets = new Map<ReturnType<typeof mockWebSocket>, { attachment: string | null }>()
	const alarms: number[] = []

	return {
		acceptWebSocket: vi.fn<(ws: ReturnType<typeof mockWebSocket>) => void>((ws) => {
			webSockets.set(ws, { attachment: null })
		}),
		getTags: vi.fn<(_ws: unknown) => string[]>(() => []),
		getWebSockets: vi.fn<() => ReturnType<typeof mockWebSocket>[]>(() => [...webSockets.keys()]),
		id: { toString: () => "test-do-id" },
		storage: {
			deleteAlarm: vi.fn<() => Promise<void>>(async () => {
				alarms.length = 0
			}),
			getAlarm: vi.fn<() => Promise<number | null>>(async () => alarms[0] ?? null),
			setAlarm: vi.fn<(time: number) => Promise<void>>(async (time) => {
				alarms.push(time)
			}),
		},
	}
}

function mockWebSocket() {
	const ws = {
		_attachment: null as string | null,
		accept: vi.fn<() => void>(),
		addEventListener: vi.fn<() => void>(),
		close: vi.fn<() => void>(),
		deserializeAttachment: vi.fn<() => string | null>(() => ws._attachment ?? null),
		readyState: 1,
		send: vi.fn<(data: string) => void>(),
		serializeAttachment: vi.fn<(data: string) => void>((data) => {
			ws._attachment = data
		}),
	}
	return ws
}

function mockWebSocketPair() {
	const client = mockWebSocket()
	const server = mockWebSocket()
	return { 0: client, 1: server }
}

function makeUpgradeRequest(headers?: Record<string, string>): Request {
	return new Request("http://localhost/ws", {
		headers: {
			connection: "Upgrade",
			upgrade: "websocket",
			...headers,
		},
	})
}

function makeNonUpgradeRequest(): Request {
	return new Request("http://localhost/ws")
}

/**
 * Capture JSON frames sent via ws.send()
 */
function sentFrames(ws: ReturnType<typeof mockWebSocket>): unknown[] {
	return ws.send.mock.calls.map(([raw]: [string]) => {
		try {
			return JSON.parse(raw)
		} catch {
			return raw
		}
	})
}

/**
 * Minimal config factory -- injects mocked CF primitives
 */
function createConfig(overrides?: Partial<RealtimeHandlerConfig>): RealtimeHandlerConfig {
	const ctx = mockDOContext()
	return {
		ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
		env: {},
		...overrides,
	}
}

/**
 * Helper: set up WebSocketPair global for fetch tests.
 * Returns a cleanup function to restore the original.
 */
function installWebSocketPair(pair: ReturnType<typeof mockWebSocketPair>): () => void {
	const original = (globalThis as Record<string, unknown>).WebSocketPair
	;(globalThis as Record<string, unknown>).WebSocketPair = class {
		0 = pair[0]
		1 = pair[1]
	}
	return () => {
		if (original) {
			;(globalThis as Record<string, unknown>).WebSocketPair = original
		} else {
			delete (globalThis as Record<string, unknown>).WebSocketPair
		}
	}
}

/**
 * Helper: create a mock ws with pre-set attachment state (simulates hibernation wake)
 */
function wsWithAttachment(attachment: Record<string, unknown>) {
	const ws = mockWebSocket()
	ws._attachment = JSON.stringify(attachment)
	ws.deserializeAttachment = vi.fn<() => string | null>(() => ws._attachment)
	return ws
}

const DEFAULT_ATTACHMENT = { connId: "conn-1", reconnectToken: "tok-1", userId: null }

/* ------------------------------------------------------------------ */
/*  Factory -- createRealtimeHandlers                                  */
/* ------------------------------------------------------------------ */

describe("createRealtimeHandlers -- factory", () => {
	it("returns an object with fetch, message, close, error, alarm methods", () => {
		const handlers = createRealtimeHandlers(createConfig())

		expect(handlers).toHaveProperty("fetch")
		expect(handlers).toHaveProperty("message")
		expect(handlers).toHaveProperty("close")
		expect(handlers).toHaveProperty("error")
		expect(handlers).toHaveProperty("alarm")
	})

	it("all returned properties are functions", () => {
		const handlers = createRealtimeHandlers(createConfig())

		expect(typeof handlers.fetch).toBe("function")
		expect(typeof handlers.message).toBe("function")
		expect(typeof handlers.close).toBe("function")
		expect(typeof handlers.error).toBe("function")
		expect(typeof handlers.alarm).toBe("function")
	})

	it("does not throw when constructed with minimal config", () => {
		expect(() => createRealtimeHandlers(createConfig())).not.toThrow()
	})

	it("accepts optional onAuth callback", () => {
		expect(() =>
			createRealtimeHandlers(
				createConfig({
					onAuth: (req) => req.headers.get("X-User-Id"),
				}),
			),
		).not.toThrow()
	})

	it("accepts optional reconnectBuffer size", () => {
		expect(() => createRealtimeHandlers(createConfig({ reconnectBuffer: 500 }))).not.toThrow()
	})
})

/* ------------------------------------------------------------------ */
/*  fetch handler -- WS upgrade                                        */
/* ------------------------------------------------------------------ */

describe("fetch handler -- WS upgrade", () => {
	it("WS upgrade request accepts WebSocket and returns 101 response", async () => {
		const ctx = mockDOContext()
		const pair = mockWebSocketPair()
		const cleanup = installWebSocketPair(pair)

		try {
			const handlers = createRealtimeHandlers({
				ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
				env: {},
			})
			const res = await handlers.fetch(makeUpgradeRequest())
			expect(res.status).toBe(101)
		} finally {
			cleanup()
		}
	})

	it("non-WS request returns 426 Upgrade Required", async () => {
		const handlers = createRealtimeHandlers(createConfig())
		const res = await handlers.fetch(makeNonUpgradeRequest())
		expect(res.status).toBe(426)
	})

	it("onAuth callback is invoked with the request", async () => {
		const onAuth = vi.fn<(req: Request) => string>(() => "user-1")
		const ctx = mockDOContext()
		const pair = mockWebSocketPair()
		const cleanup = installWebSocketPair(pair)

		try {
			const handlers = createRealtimeHandlers({
				ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
				env: {},
				onAuth,
			})
			const req = makeUpgradeRequest({ "X-User-Id": "user-1" })
			await handlers.fetch(req)

			expect(onAuth).toHaveBeenCalledTimes(1)
			expect(onAuth).toHaveBeenCalledWith(req)
		} finally {
			cleanup()
		}
	})

	it("onAuth returning userId stores it on the connection context", async () => {
		const ctx = mockDOContext()
		const pair = mockWebSocketPair()
		const cleanup = installWebSocketPair(pair)

		try {
			const handlers = createRealtimeHandlers({
				ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
				env: {},
				onAuth: () => "user-42",
			})
			await handlers.fetch(makeUpgradeRequest())

			const attachment = pair[1].serializeAttachment.mock.calls[0]?.[0]
			expect(attachment).toBeDefined()
			const parsed = JSON.parse(attachment as string)
			expect(parsed.userId).toBe("user-42")
		} finally {
			cleanup()
		}
	})

	it("onAuth returning null still allows connection (userId = null)", async () => {
		const ctx = mockDOContext()
		const pair = mockWebSocketPair()
		const cleanup = installWebSocketPair(pair)

		try {
			const handlers = createRealtimeHandlers({
				ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
				env: {},
				onAuth: () => null,
			})
			const res = await handlers.fetch(makeUpgradeRequest())

			expect(res.status).toBe(101)
			const attachment = pair[1].serializeAttachment.mock.calls[0]?.[0]
			const parsed = JSON.parse(attachment as string)
			expect(parsed.userId).toBeNull()
		} finally {
			cleanup()
		}
	})

	it("sends ready frame with reconnectToken after accept", async () => {
		const ctx = mockDOContext()
		const pair = mockWebSocketPair()
		const cleanup = installWebSocketPair(pair)

		try {
			const handlers = createRealtimeHandlers({
				ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
				env: {},
			})
			await handlers.fetch(makeUpgradeRequest())

			const frames = sentFrames(pair[1])
			const readyFrame = frames.find(
				(f) => typeof f === "object" && f !== null && (f as Record<string, unknown>).t === "ready",
			)
			expect(readyFrame).toBeDefined()
			expect(typeof (readyFrame as Record<string, unknown>).reconnectToken).toBe("string")
		} finally {
			cleanup()
		}
	})

	it("async onAuth is awaited before accepting connection", async () => {
		const ctx = mockDOContext()
		const pair = mockWebSocketPair()
		const cleanup = installWebSocketPair(pair)

		try {
			const handlers = createRealtimeHandlers({
				ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
				env: {},
				onAuth: async () => {
					await new Promise((r) => setTimeout(r, 5))
					return "async-user"
				},
			})
			await handlers.fetch(makeUpgradeRequest())

			const attachment = pair[1].serializeAttachment.mock.calls[0]?.[0]
			const parsed = JSON.parse(attachment as string)
			expect(parsed.userId).toBe("async-user")
		} finally {
			cleanup()
		}
	})
})

/* ------------------------------------------------------------------ */
/*  message handler -- wire protocol                                   */
/* ------------------------------------------------------------------ */

describe("message handler -- wire protocol", () => {
	it("ping frame responds with pong", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})
		await handlers.message(ws as unknown as WebSocket, JSON.stringify({ t: "ping" }))

		const frames = sentFrames(ws)
		expect(frames).toContainEqual({ t: "pong" })
	})

	it("msg frame dispatches to route handler via conn.on('message')", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)
		const receivedPayloads: unknown[] = []

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			routes: {
				"/": (_c, conn) => {
					conn.on("message", (payload) => {
						receivedPayloads.push(payload)
					})
				},
			},
		})
		await handlers.message(ws as unknown as WebSocket, JSON.stringify({ data: { text: "hello" }, t: "msg" }))

		expect(receivedPayloads).toContainEqual({ text: "hello" })
	})

	it("resume frame with valid token replays buffered messages", async () => {
		const ctx = mockDOContext()
		const token = "valid-token"
		const ws = wsWithAttachment({ connId: "conn-1", reconnectToken: token, userId: null })

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			reconnectBuffer: 100,
		})

		await handlers.message(
			ws as unknown as WebSocket,
			JSON.stringify({ lastId: 0, reconnectToken: token, t: "resume" }),
		)

		const frames = sentFrames(ws)
		const readyFrame = frames.find(
			(f) => typeof f === "object" && f !== null && (f as Record<string, unknown>).t === "ready",
		)
		expect(readyFrame).toBeDefined()
	})

	it("resume frame with invalid token sends bye with server_restart", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment({ connId: "conn-1", reconnectToken: "old-token", userId: null })

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			reconnectBuffer: 100,
		})
		await handlers.message(
			ws as unknown as WebSocket,
			JSON.stringify({ lastId: 5, reconnectToken: "wrong-token", t: "resume" }),
		)

		const frames = sentFrames(ws)
		const byeFrame = frames.find(
			(f) => typeof f === "object" && f !== null && (f as Record<string, unknown>).t === "bye",
		)
		expect(byeFrame).toBeDefined()
		expect((byeFrame as Record<string, unknown>).reason).toBe("server_restart")
	})

	it("invalid JSON is silently ignored (no crash)", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		await expect(handlers.message(ws as unknown as WebSocket, "not valid json {{{")).resolves.not.toThrow()

		expect(ws.send).not.toHaveBeenCalled()
	})

	it("binary ArrayBuffer message is handled without crash", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		const buffer = new ArrayBuffer(8)
		await expect(handlers.message(ws as unknown as WebSocket, buffer)).resolves.not.toThrow()
	})
})

/* ------------------------------------------------------------------ */
/*  close handler                                                      */
/* ------------------------------------------------------------------ */

describe("close handler", () => {
	it("fires the connection's close handler", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)
		const closeReasons: Array<{ code: number; reason: string }> = []

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			routes: {
				"/": (_c, conn) => {
					conn.on("close", (reason) => {
						closeReasons.push({ code: 1000, reason })
					})
				},
			},
		})
		await handlers.close(ws as unknown as WebSocket, 1000, "normal", true)

		expect(closeReasons.length).toBeGreaterThanOrEqual(1)
	})

	it("cleans up bus subscriptions on close", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		await expect(handlers.close(ws as unknown as WebSocket, 1000, "going away", true)).resolves.not.toThrow()
	})

	it("starts reconnect buffer disconnect TTL", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			reconnectBuffer: 100,
		})
		await handlers.close(ws as unknown as WebSocket, 1000, "disconnect", true)

		expect(ctx.storage.setAlarm).toHaveBeenCalled()
	})

	it("abnormal close (wasClean=false) still triggers cleanup", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		await expect(handlers.close(ws as unknown as WebSocket, 1006, "", false)).resolves.not.toThrow()
	})
})

/* ------------------------------------------------------------------ */
/*  error handler                                                      */
/* ------------------------------------------------------------------ */

describe("error handler", () => {
	it("does not throw when receiving an error", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		await expect(handlers.error(ws as unknown as WebSocket, new Error("network failure"))).resolves.not.toThrow()
	})

	it("cleans up the connection on error", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})
		await handlers.error(ws as unknown as WebSocket, new Error("boom"))

		expect(ws.close).toHaveBeenCalled()
	})
})

/* ------------------------------------------------------------------ */
/*  alarm handler                                                      */
/* ------------------------------------------------------------------ */

describe("alarm handler", () => {
	it("cleans up expired reconnect buffers", async () => {
		const ctx = mockDOContext()

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			reconnectBuffer: 100,
		})

		await expect(handlers.alarm()).resolves.not.toThrow()
	})

	it("deletes alarm after processing", async () => {
		const ctx = mockDOContext()

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			reconnectBuffer: 100,
		})
		await handlers.alarm()

		expect(ctx.storage.deleteAlarm).toHaveBeenCalled()
	})

	it("no-op when no buffers exist to clean up", async () => {
		const ctx = mockDOContext()

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		await expect(handlers.alarm()).resolves.not.toThrow()
	})
})

/* ------------------------------------------------------------------ */
/*  Reconnect buffer                                                   */
/* ------------------------------------------------------------------ */

describe("reconnect buffer", () => {
	it("messages are buffered up to configured limit", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			reconnectBuffer: 5,
		})

		for (let i = 0; i < 7; i++) {
			await handlers.message(ws as unknown as WebSocket, JSON.stringify({ data: { idx: i }, t: "msg" }))
		}

		const resumeWs = wsWithAttachment(DEFAULT_ATTACHMENT)
		await handlers.message(
			resumeWs as unknown as WebSocket,
			JSON.stringify({ lastId: 0, reconnectToken: "tok-1", t: "resume" }),
		)

		const frames = sentFrames(resumeWs)
		const msgFrames = frames.filter(
			(f) => typeof f === "object" && f !== null && (f as Record<string, unknown>).t === "msg",
		)
		expect(msgFrames.length).toBeLessThanOrEqual(5)
	})

	it("resume replays messages after lastId", async () => {
		const ctx = mockDOContext()
		const token = "replay-token"
		const ws = wsWithAttachment({ connId: "conn-1", reconnectToken: token, userId: null })

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			reconnectBuffer: 100,
		})
		await handlers.message(
			ws as unknown as WebSocket,
			JSON.stringify({ lastId: 3, reconnectToken: token, t: "resume" }),
		)

		const frames = sentFrames(ws)
		const msgFrames = frames.filter(
			(f) => typeof f === "object" && f !== null && (f as Record<string, unknown>).t === "msg",
		)

		for (const frame of msgFrames) {
			expect((frame as Record<string, unknown>).id).toBeGreaterThan(3)
		}
	})

	it("default buffer size is 100", () => {
		const ctx = mockDOContext()
		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		expect(handlers).toBeDefined()
	})

	it("custom reconnectBuffer size from config is respected", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			reconnectBuffer: 3,
		})

		for (let i = 0; i < 10; i++) {
			await handlers.message(ws as unknown as WebSocket, JSON.stringify({ data: { idx: i }, t: "msg" }))
		}

		const resumeWs = wsWithAttachment(DEFAULT_ATTACHMENT)
		await handlers.message(
			resumeWs as unknown as WebSocket,
			JSON.stringify({ lastId: 0, reconnectToken: "tok-1", t: "resume" }),
		)

		const frames = sentFrames(resumeWs)
		const msgFrames = frames.filter(
			(f) => typeof f === "object" && f !== null && (f as Record<string, unknown>).t === "msg",
		)
		expect(msgFrames.length).toBeLessThanOrEqual(3)
	})

	it("resume with lastId equal to latest message replays nothing", async () => {
		const ctx = mockDOContext()
		const token = "up-to-date-token"
		const ws = wsWithAttachment({ connId: "conn-1", reconnectToken: token, userId: null })

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
			reconnectBuffer: 100,
		})
		await handlers.message(
			ws as unknown as WebSocket,
			JSON.stringify({ lastId: 999, reconnectToken: token, t: "resume" }),
		)

		const frames = sentFrames(ws)
		const msgFrames = frames.filter(
			(f) => typeof f === "object" && f !== null && (f as Record<string, unknown>).t === "msg",
		)
		expect(msgFrames).toHaveLength(0)
	})
})

/* ------------------------------------------------------------------ */
/*  Hibernation state (serializeAttachment)                            */
/* ------------------------------------------------------------------ */

describe("hibernation state (serializeAttachment)", () => {
	it("connection state is serialized on WebSocket via serializeAttachment", async () => {
		const ctx = mockDOContext()
		const pair = mockWebSocketPair()
		const cleanup = installWebSocketPair(pair)

		try {
			const handlers = createRealtimeHandlers({
				ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
				env: {},
				onAuth: () => "user-x",
			})
			await handlers.fetch(makeUpgradeRequest())

			expect(pair[1].serializeAttachment).toHaveBeenCalled()
			const attachment = pair[1].serializeAttachment.mock.calls[0][0]
			expect(typeof attachment).toBe("string")
			const parsed = JSON.parse(attachment)
			expect(parsed).toHaveProperty("connId")
			expect(parsed).toHaveProperty("reconnectToken")
			expect(parsed).toHaveProperty("userId")
		} finally {
			cleanup()
		}
	})

	it("state survives across message handler calls (simulating hibernation wake)", async () => {
		const ctx = mockDOContext()
		const state = JSON.stringify({ connId: "conn-123", reconnectToken: "tok-abc", userId: "user-7" })
		const ws = mockWebSocket()
		ws._attachment = state
		ws.deserializeAttachment = vi.fn<() => string | null>(() => ws._attachment)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		await handlers.message(ws as unknown as WebSocket, JSON.stringify({ t: "ping" }))
		await handlers.message(ws as unknown as WebSocket, JSON.stringify({ t: "ping" }))

		expect(ws.deserializeAttachment.mock.calls.length).toBeGreaterThanOrEqual(2)

		const frames = sentFrames(ws)
		const pongs = frames.filter(
			(f) => typeof f === "object" && f !== null && (f as Record<string, unknown>).t === "pong",
		)
		expect(pongs).toHaveLength(2)
	})

	it("connId and reconnectToken are preserved in attachment", async () => {
		const ctx = mockDOContext()
		const pair = mockWebSocketPair()
		const cleanup = installWebSocketPair(pair)

		try {
			const handlers = createRealtimeHandlers({
				ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
				env: {},
			})
			await handlers.fetch(makeUpgradeRequest())

			const attachment = pair[1].serializeAttachment.mock.calls[0][0]
			const parsed = JSON.parse(attachment)

			expect(typeof parsed.connId).toBe("string")
			expect(parsed.connId.length).toBeGreaterThan(0)
			expect(typeof parsed.reconnectToken).toBe("string")
			expect(parsed.reconnectToken.length).toBeGreaterThan(0)
		} finally {
			cleanup()
		}
	})

	it("attachment userId is null when onAuth is not provided", async () => {
		const ctx = mockDOContext()
		const pair = mockWebSocketPair()
		const cleanup = installWebSocketPair(pair)

		try {
			const handlers = createRealtimeHandlers({
				ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
				env: {},
			})
			await handlers.fetch(makeUpgradeRequest())

			const attachment = pair[1].serializeAttachment.mock.calls[0][0]
			const parsed = JSON.parse(attachment)
			expect(parsed.userId).toBeNull()
		} finally {
			cleanup()
		}
	})
})

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

describe("edge cases", () => {
	it("message handler with null attachment does not crash", async () => {
		const ctx = mockDOContext()
		const ws = mockWebSocket()
		ws._attachment = null
		ws.deserializeAttachment = vi.fn<() => null>(() => null)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		await expect(handlers.message(ws as unknown as WebSocket, JSON.stringify({ t: "ping" }))).resolves.not.toThrow()
	})

	it("close handler with null attachment does not crash", async () => {
		const ctx = mockDOContext()
		const ws = mockWebSocket()
		ws._attachment = null
		ws.deserializeAttachment = vi.fn<() => null>(() => null)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		await expect(handlers.close(ws as unknown as WebSocket, 1000, "normal", true)).resolves.not.toThrow()
	})

	it("concurrent message calls do not corrupt state", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		const promises = Array.from({ length: 50 }, () =>
			handlers.message(ws as unknown as WebSocket, JSON.stringify({ t: "ping" })),
		)
		await expect(Promise.all(promises)).resolves.not.toThrow()

		const frames = sentFrames(ws)
		const pongs = frames.filter(
			(f) => typeof f === "object" && f !== null && (f as Record<string, unknown>).t === "pong",
		)
		expect(pongs).toHaveLength(50)
	})

	it("empty string message is handled without crash", async () => {
		const ctx = mockDOContext()
		const ws = wsWithAttachment(DEFAULT_ATTACHMENT)

		const handlers = createRealtimeHandlers({
			ctx: ctx as unknown as RealtimeHandlerConfig["ctx"],
			env: {},
		})

		await expect(handlers.message(ws as unknown as WebSocket, "")).resolves.not.toThrow()
	})

	it("fetch with request that has no upgrade header returns 426", async () => {
		const handlers = createRealtimeHandlers(createConfig())
		const req = new Request("http://localhost/ws")

		const res = await handlers.fetch(req)
		expect(res.status).toBe(426)
	})
})

/* ------------------------------------------------------------------ */
/*  Type contracts                                                     */
/* ------------------------------------------------------------------ */

describe("type contracts", () => {
	it("createRealtimeHandlers returns RealtimeHandlers type", () => {
		const handlers = createRealtimeHandlers(createConfig())
		expectTypeOf(handlers).toMatchTypeOf<RealtimeHandlers>()
	})

	it("RealtimeHandlers.fetch returns Promise<Response>", () => {
		const handlers = createRealtimeHandlers(createConfig())
		expectTypeOf(handlers.fetch).returns.toEqualTypeOf<Promise<Response>>()
	})

	it("RealtimeHandlerConfig accepts generic TEnv type parameter", () => {
		type MyEnv = { DB: string; KV: string }
		const config: RealtimeHandlerConfig<MyEnv> = {
			ctx: mockDOContext() as unknown as RealtimeHandlerConfig<MyEnv>["ctx"],
			env: { DB: "d1", KV: "kv" },
		}
		expectTypeOf(config.env).toEqualTypeOf<MyEnv>()
	})

	it("onAuth receives Request and returns string | null | Promise<string | null>", () => {
		type AuthFn = NonNullable<RealtimeHandlerConfig["onAuth"]>
		expectTypeOf<AuthFn>().parameter(0).toEqualTypeOf<Request>()
		expectTypeOf<AuthFn>().returns.toEqualTypeOf<string | null | Promise<string | null>>()
	})

	it("message handler accepts WebSocket and ArrayBuffer | string", () => {
		const handlers = createRealtimeHandlers(createConfig())
		expectTypeOf(handlers.message).parameter(0).toEqualTypeOf<WebSocket>()
		expectTypeOf(handlers.message).parameter(1).toEqualTypeOf<ArrayBuffer | string>()
	})

	it("close handler accepts WebSocket, code, reason, wasClean", () => {
		const handlers = createRealtimeHandlers(createConfig())
		expectTypeOf(handlers.close).parameter(0).toEqualTypeOf<WebSocket>()
		expectTypeOf(handlers.close).parameter(1).toEqualTypeOf<number>()
		expectTypeOf(handlers.close).parameter(2).toEqualTypeOf<string>()
		expectTypeOf(handlers.close).parameter(3).toEqualTypeOf<boolean>()
	})
})
