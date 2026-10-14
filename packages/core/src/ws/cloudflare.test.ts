import { afterEach, describe, expect, it, vi } from "vitest"
import { cfWebSocket } from "./cloudflare.ts"
import type { WSHandler } from "./contract.ts"

/** One side of a Workers WebSocketPair: events in, sends and closes recorded. */
class PairSocket extends EventTarget {
	accepted = false
	closed: [number | undefined, string | undefined][] = []
	readyState = 1
	sent: unknown[] = []
	accept() {
		this.accepted = true
	}
	close(code?: number, reason?: string) {
		this.closed.push([code, reason])
	}
	send(data: unknown) {
		this.sent.push(data)
	}
}

/** Stub WebSocketPair and a Response that takes status 101, as Workers has them; returns the server side. */
function workers() {
	const pairs: { client: PairSocket; server: PairSocket }[] = []
	/* `new WebSocketPair()` takes the object a constructor function returns */
	vi.stubGlobal("WebSocketPair", function WebSocketPair() {
		const pair = { client: new PairSocket(), server: new PairSocket() }
		pairs.push(pair)
		return [pair.client, pair.server]
	})
	vi.stubGlobal(
		"Response",
		class {
			readonly headers: Headers
			readonly status: number
			readonly webSocket: unknown
			constructor(_body: null, init: { headers: Record<string, string>; status: number; webSocket: unknown }) {
				this.headers = new Headers(init.headers)
				this.status = init.status
				this.webSocket = init.webSocket
			}
		},
	)
	return pairs
}

function recordingHandler() {
	const seen: unknown[] = []
	const handler: WSHandler<unknown> = {
		onClose: (_c, _ws, code, reason) => void seen.push(["close", code, reason]),
		onError: () => void seen.push(["error"]),
		onMessage: (_c, _ws, data) => void seen.push(["message", data]),
		onOpen: () => void seen.push(["open"]),
	}
	return { handler, seen }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

const request = (protocols?: string) =>
	new Request("https://h/ws", { headers: protocols === undefined ? {} : { "sec-websocket-protocol": protocols } })

afterEach(() => {
	vi.unstubAllGlobals()
})

describe("cfWebSocket: the upgrade", () => {
	// v0: cc33c57bd8
	it("accepts the server side, opens the handler, and answers 101 carrying the client side", async () => {
		const pairs = workers()
		const { handler, seen } = recordingHandler()
		const { response, socket } = await cfWebSocket().upgrade(request(), {}, handler)
		await settle()
		const pair = pairs[0] as { client: PairSocket; server: PairSocket }
		expect([
			pair.server.accepted,
			response.status,
			(response as unknown as { webSocket: unknown }).webSocket === pair.client,
			response.headers.get("upgrade"),
			socket.raw === pair.server,
			seen,
		]).toEqual([true, 101, true, "websocket", true, [["open"]]])
	})

	// v0: 485d1a3bc6
	it("answers with the subprotocol chosen from the offered ones, and none when nothing was offered", async () => {
		workers()
		const adapter = cfWebSocket({ protocol: (offered) => offered.at(-1) })
		const [chosen, none] = await Promise.all([
			adapter.upgrade(request("a, b"), {}, {}),
			adapter.upgrade(request(), {}, {}),
		])
		expect([
			chosen.response.headers.get("sec-websocket-protocol"),
			none.response.headers.get("sec-websocket-protocol"),
		]).toEqual(["b", null])
	})
})

describe("cfWebSocket: events from the runtime", () => {
	// v0: 0d0e5e9658
	it("message, error and close reach the handler; the close is echoed so the client's handshake completes", async () => {
		const pairs = workers()
		const { handler, seen } = recordingHandler()
		await cfWebSocket().upgrade(request(), {}, handler)
		const server = (pairs[0] as { server: PairSocket }).server
		server.dispatchEvent(Object.assign(new Event("message"), { data: "hi" }))
		server.dispatchEvent(new Event("error"))
		server.dispatchEvent(Object.assign(new Event("close"), { code: 4000, reason: "done" }))
		await settle()
		expect([seen, server.closed]).toEqual([
			[["open"], ["message", "hi"], ["error"], ["close", 4000, "done"]],
			[[4000, "done"]],
		])
	})

	// v0: b4ea2b7621
	it("echoes a close code that can never be sent (1005, 1006) as 1000, and survives a socket already closed", async () => {
		const pairs = workers()
		await cfWebSocket().upgrade(request(), {}, {})
		const server = (pairs[0] as { server: PairSocket }).server
		server.dispatchEvent(Object.assign(new Event("close"), { code: 1005, reason: "" }))
		server.close = () => {
			throw new Error("already closed")
		}
		expect(() => server.dispatchEvent(Object.assign(new Event("close"), { code: 1006, reason: "" }))).not.toThrow()
		expect(server.closed).toEqual([[1000, ""]])
	})

	// v0: 485d1a3bc6
	it("closes 1009 on a message over maxPayload, and the handler never sees it", async () => {
		const pairs = workers()
		const { handler, seen } = recordingHandler()
		await cfWebSocket({ maxPayload: 4 }).upgrade(request(), {}, handler)
		const server = (pairs[0] as { server: PairSocket }).server
		server.dispatchEvent(Object.assign(new Event("message"), { data: "12345" }))
		await settle()
		expect([seen, server.closed]).toEqual([[["open"]], [[1009, "message too big"]]])
	})

	it("validates its options when created", () => {
		expect(() => cfWebSocket({ maxPayload: 0 })).toThrow("maxPayload must be positive")
		expect(cfWebSocket().options?.maxPayload).toBe(1024 * 1024)
	})
})
