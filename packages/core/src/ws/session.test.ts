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

/** Let every queued callback run. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("createWsSession: one ordered lane per connection", () => {
	it("open, then messages in order, then close, each with the route's ctx, even when one is slow", async () => {
		const order: string[] = []
		const socket = ws()
		const { handler } = session({
			onClose: (c, _ws, code, reason) => void order.push(`close:${c.user}:${code}:${reason}`),
			onMessage: async (c, _ws, data) => {
				if (data === "1") await new Promise((resolve) => setTimeout(resolve, 2))
				order.push(`message:${c.user}:${String(data)}`)
			},
			onOpen: (c) => void order.push(`open:${c.user}`),
		})
		handler.onOpen?.(undefined as never, socket)
		handler.onMessage?.(undefined as never, socket, "1")
		handler.onMessage?.(undefined as never, socket, "2")
		handler.onClose?.(undefined as never, socket, 1000, "bye")
		await drain()
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
	it("a callback that throws reaches the route's onError with the ctx and socket; the lane goes on", async () => {
		const boom = new Error("boom")
		const seen: unknown[] = []
		const socket = ws()
		const { handler, log } = session({
			onError: (c, s, error) => void seen.push([c.user, s === socket, error]),
			onMessage: (_c, _ws, data) => {
				if (data === "bad") throw boom
				seen.push(data)
			},
		})
		handler.onMessage?.(undefined as never, socket, "bad")
		handler.onMessage?.(undefined as never, socket, "good")
		await drain()
		expect([seen, log.error.mock.calls]).toEqual([[["u1", true, boom], "good"], []])
	})

	it("without onError, a failing callback is logged with the route and phase", async () => {
		const boom = new Error("boom")
		const { handler, log } = session({ onOpen: () => Promise.reject(boom) })
		handler.onOpen?.(undefined as never, ws())
		await drain()
		expect(log.error.mock.calls).toEqual([[{ err: boom, phase: "websocket open", route: "/chat" }, "callback failed"]])
	})

	it("a transport error goes to onError once; without one it is logged", async () => {
		const transport = new Error("reset")
		const seen: unknown[] = []
		const withHandler = session({ onError: (_c, _ws, error) => void seen.push(error) })
		const without = session({})
		withHandler.handler.onError?.(undefined as never, ws(), transport)
		without.handler.onError?.(undefined as never, ws(), transport)
		await drain()
		expect([seen, without.log.error.mock.calls.map(([fields]) => [fields.err, fields.phase])]).toEqual([
			[transport],
			[[transport, "websocket error"]],
		])
	})
})

describe("createWsSession: a client flooding a slow handler", () => {
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
