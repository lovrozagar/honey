import { describe, expect, it, vi } from "vitest"
import type { WSContext, WSHandler } from "./contract.ts"
import { createWsSession, WS_PENDING_MAX } from "./session.ts"

const ws = (): WSContext & { closed: [number | undefined, string | undefined][] } => {
	const closed: [number | undefined, string | undefined][] = []
	return { close: (code, reason) => void closed.push([code, reason]), closed, raw: null, readyState: 1, send: () => {} }
}

const ctx = { user: "u1" }

function session(callbacks: WSHandler<typeof ctx>, reconnectToken: string | null = null, log = { error: vi.fn() }) {
	const handler = createWsSession({
		callbacks: callbacks as WSHandler<unknown>,
		ctx,
		log,
		reconnectToken,
		route: "/chat",
	})
	return { handler, log }
}

/** What `log` recorded, as [error, phase] pairs. */
const logged = (log: { error: ReturnType<typeof vi.fn> }) =>
	log.error.mock.calls.map(([fields]) => [(fields as { err: unknown }).err, (fields as { phase: string }).phase])

/** Let every queued callback run. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("createWsSession: one ordered lane per connection", () => {
	// v0: ed2ff41bdb
	// v0: 5c95ebd74d
	// v0: 9c06ceba3c
	it("open, then messages in order, then close, each with the route's ctx, even when one is slow", async () => {
		const order: string[] = []
		const socket = ws()
		const { handler } = session({
			onClose: (c, _ws, code, reason) => void order.push(`close:${c.user}:${code}:${reason}`),
			onMessage: async (c, _ws, data) => {
				if (data === "1") await new Promise((resolve) => setTimeout(resolve, 2))
				order.push(`message:${c.user}:${String(data)}`)
			},
			onOpen: async (c) => {
				await new Promise((resolve) => setTimeout(resolve, 2))
				order.push(`open:${c.user}`)
			},
		})
		handler.onOpen?.(undefined as never, socket)
		handler.onMessage?.(undefined as never, socket, "1")
		handler.onMessage?.(undefined as never, socket, "2")
		handler.onClose?.(undefined as never, socket, 1000, "bye")
		await new Promise((resolve) => setTimeout(resolve, 30))
		expect(order).toEqual(["open:u1", "message:u1:1", "message:u1:2", "close:u1:1000:bye"])
	})

	it("a route without a callback for an event ignores it", async () => {
		const { handler, log } = session({})
		const socket = ws()
		handler.onOpen?.(undefined as never, socket)
		handler.onMessage?.(undefined as never, socket, "x")
		handler.onClose?.(undefined as never, socket, 1000, "")
		await drain()
		expect([socket.closed, log.error.mock.calls]).toEqual([[], []])
	})
})

describe("createWsSession: reconnect", () => {
	// v0: c5f647ced5
	// v0: 997746cad4
	// v0: 7162d066e9
	it.each([
		["a token and an onReconnect", "tok-1", true, ["reconnect:tok-1"]],
		["no token", null, true, ["open"]],
		["an empty token", "", true, ["open"]],
		["a token but no onReconnect", "tok-1", false, ["open"]],
	])("with %s: %j", async (_case, token, withReconnect, calls) => {
		const seen: string[] = []
		const callbacks: WSHandler<typeof ctx> = { onOpen: () => void seen.push("open") }
		if (withReconnect) callbacks.onReconnect = (_c, _ws, t) => void seen.push(`reconnect:${t}`)
		const { handler } = session(callbacks, token)
		handler.onOpen?.(undefined as never, ws())
		await drain()
		expect(seen).toEqual(calls)
	})
})

describe("createWsSession: containment", () => {
	// v0: e15de23f1f
	// v0: 60a94ed3f8
	// v0: 6a22bfcbf6
	it.each([
		[
			"throws",
			(error: Error) => {
				throw error
			},
		],
		["rejects", (error: Error) => Promise.reject(error)],
	])(
		"a callback that %s reaches the route's onError with the ctx and socket; the lane goes on",
		async (_name, fail) => {
			const boom = new Error("boom")
			const seen: unknown[] = []
			const socket = ws()
			const { handler, log } = session({
				onError: (c, s, error) => void seen.push([c.user, s === socket, error]),
				onMessage: (_c, _ws, data) => {
					if (data === "bad") return fail(boom)
					seen.push(data)
				},
			})
			handler.onMessage?.(undefined as never, socket, "bad")
			handler.onMessage?.(undefined as never, socket, "good")
			await drain()
			expect([seen, log.error.mock.calls]).toEqual([[["u1", true, boom], "good"], []])
		},
	)

	// v0: ed4eae1d93
	it("without onError, a sync throw or a rejection in onOpen or onClose never escapes: it is logged with the route and phase", async () => {
		const boom = new Error("boom")
		const thrower = () => {
			throw boom
		}
		const { handler, log } = session({ onClose: thrower, onOpen: () => Promise.reject(boom) })
		const sync = session({ onOpen: thrower })
		const socket = ws()
		expect(() => {
			handler.onOpen?.(undefined as never, socket)
			sync.handler.onOpen?.(undefined as never, socket)
			handler.onClose?.(undefined as never, socket, 1000, "")
		}).not.toThrow()
		await drain()
		expect([...log.error.mock.calls, ...sync.log.error.mock.calls]).toEqual([
			[{ err: boom, phase: "websocket open", route: "/chat" }, "callback failed"],
			[{ err: boom, phase: "websocket close", route: "/chat" }, "callback failed"],
			[{ err: boom, phase: "websocket open", route: "/chat" }, "callback failed"],
		])
	})
})

describe("createWsSession: a transport error", () => {
	// v0: edbef17bd4
	it("a transport error goes to onError once; without one, or with one that throws on it, it is logged", async () => {
		const transport = new Error("reset")
		const seen: unknown[] = []
		const withHandler = session({ onError: (_c, _ws, error) => void seen.push(error) })
		const without = session({})
		const failing = session({
			onError: () => {
				throw new Error("onError failed")
			},
		})
		for (const { handler } of [withHandler, without, failing]) handler.onError?.(undefined as never, ws(), transport)
		await drain()
		expect([seen, logged(without.log), logged(failing.log)]).toEqual([
			[transport],
			[[transport, "websocket error"]],
			[[new Error("onError failed"), "websocket error"]],
		])
	})
})

describe("createWsSession: a client flooding a slow handler", () => {
	// v0: 92f69e06ed
	it("closes 1008 once 1024 messages wait, and drops what came past the cap", async () => {
		const gate = Promise.withResolvers<void>()
		let handled = 0
		const socket = ws()
		const { handler } = session({
			onMessage: async () => {
				await gate.promise
				handled++
			},
		})
		for (let i = 0; i < WS_PENDING_MAX + 5; i++) handler.onMessage?.(undefined as never, socket, String(i))
		gate.resolve()
		await vi.waitFor(() => expect(handled).toBe(WS_PENDING_MAX))
		expect([WS_PENDING_MAX, socket.closed]).toEqual([
			1024,
			Array.from({ length: 5 }, () => [1008, "too many pending messages"]),
		])
	})
})
