import { describe, expect, it, vi } from "vitest"
import { bunWebSocket, type BunWebSocketHandlers } from "./bun.ts"
import type { WSHandler } from "./contract.ts"

/** A Bun server stand-in: `upgrade` records what it was given and answers `accept`. */
function bunServer(accept = true) {
	const upgrades: { data: unknown; headers: unknown; req: Request }[] = []
	return {
		upgrade: (req: Request, options: { data: unknown; headers?: unknown }) => {
			upgrades.push({ data: options.data, headers: options.headers, req })
			return accept
		},
		upgrades,
	}
}

type BunSocket = Parameters<BunWebSocketHandlers["open"]>[0]

/** A socket as Bun hands it to the websocket callbacks: `data` is what upgrade() stored. */
function bunSocket(data: unknown): BunSocket & { closed: [number | undefined, string | undefined][] } {
	const socket = {
		closed: [] as [number | undefined, string | undefined][],
		close(code?: number, reason?: string) {
			this.closed.push([code, reason])
		},
		data,
		getBufferedAmount: () => 0,
		readyState: 1,
		send: () => 0,
	}
	return socket as unknown as BunSocket & { closed: [number | undefined, string | undefined][] }
}

function recordingHandler() {
	const seen: unknown[] = []
	const handler: WSHandler<unknown> = {
		onClose: (_c, ws, code, reason) => void seen.push(["close", code, reason, ws.readyState]),
		onMessage: (_c, ws, data) => void seen.push(["message", data, ws.readyState]),
		onOpen: (_c, ws) => void seen.push(["open", ws.readyState]),
	}
	return { handler, seen }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

describe("bunWebSocket: the upgrade", () => {
	// v0: e91c9702ad
	it("asks Bun's server to upgrade with the handler stored on the socket, and answers 101", async () => {
		const server = bunServer()
		const { response } = await bunWebSocket().upgrade(new Request("http://h/ws"), { db: "x", server }, {})
		expect([response.status, server.upgrades.length, server.upgrades[0]?.headers]).toEqual([101, 1, undefined])
	})

	it("finds the server passed as the env itself (Bun.serve({ fetch: app.fetch })), and sends the chosen protocol", async () => {
		const server = bunServer()
		const req = new Request("http://h/ws", { headers: { "sec-websocket-protocol": "chat, v2" } })
		await bunWebSocket({ protocol: (offered) => offered.at(-1) }).upgrade(req, server, {})
		expect(server.upgrades[0]?.headers).toEqual({ "sec-websocket-protocol": "v2" })
	})

	// v0: 9c7a5039ce
	it.each([
		["Bun refuses the upgrade", { server: bunServer(false) }, "Bun refused the WebSocket upgrade"],
		["no Bun server reaches it", {}, "bunWebSocket needs Bun's server"],
	])("throws when %s, so the route answers 500 through onError", async (_case, env, message) => {
		await expect(async () => bunWebSocket().upgrade(new Request("http://h/ws"), env, {})).rejects.toThrow(message)
	})
})

/** Upgrade once and return the socket Bun would hand the callbacks. */
async function upgraded(handler: WSHandler<unknown>) {
	const server = bunServer()
	const adapter = bunWebSocket()
	await adapter.upgrade(new Request("http://h/ws"), { server }, handler)
	return { adapter, ws: bunSocket(server.upgrades[0]?.data) }
}

describe("bunWebSocket: the websocket callbacks Bun.serve runs", () => {
	// v0: 7ce153fda8
	// v0: a79996040f
	// v0: 6073396e9c
	// v0: f8474a8db1
	it("open, a string message, a binary message as exactly its bytes, then close reach the handler", async () => {
		const { handler, seen } = recordingHandler()
		const { adapter, ws } = await upgraded(handler)
		const pooled = new Uint8Array([9, 1, 2, 3, 9])
		adapter.websocket.open(ws)
		adapter.websocket.message(ws, "hi")
		adapter.websocket.message(ws, pooled.subarray(1, 4))
		adapter.websocket.close(ws, 4000, "bye")
		await settle()
		const binary = seen[2] as [string, ArrayBuffer, number]
		expect([seen[0], seen[1], [...new Uint8Array(binary[1])], seen[3]]).toEqual([
			["open", 1],
			["message", "hi", 1],
			[1, 2, 3],
			["close", 4000, "bye", 1],
		])
	})

	// v0: 8d7032b9dc
	// v0: fa2c6fcdcc
	// v0: 7f80ba8f0a
	it("a message or a close before open still hands the handler a socket, the same one each time", async () => {
		const sockets: unknown[] = []
		const { adapter, ws } = await upgraded({
			onClose: (_c, socket) => void sockets.push(socket),
			onMessage: (_c, socket) => void sockets.push(socket),
		})
		adapter.websocket.message(ws, "early")
		adapter.websocket.close(ws, 1000, "")
		await settle()
		expect([sockets.length, sockets[0] !== undefined, sockets[0] === sockets[1]]).toEqual([2, true, true])
	})

	it("closeAll closes every open socket, one already closing included, and forgets closed ones", async () => {
		const { adapter, ws } = await upgraded({})
		const failing = {
			...bunSocket(ws.data),
			close: () => {
				throw new Error("closing")
			},
		}
		const gone = bunSocket(ws.data)
		adapter.websocket.open(ws)
		adapter.websocket.open(failing)
		adapter.websocket.open(gone)
		adapter.websocket.close(gone, 1000, "")
		expect(() => adapter.closeAll?.(1001, "server shutting down")).not.toThrow()
		expect([ws.closed, gone.closed]).toEqual([[[1001, "server shutting down"]], []])
	})
})

describe("bunWebSocket: the limits handed to Bun.serve", () => {
	// v0: d0117ea12d
	it.each([
		[{}, { backpressureLimit: 8 * 1024 * 1024, idleTimeout: 120, maxPayloadLength: 1024 * 1024 }],
		[{ idleTimeout: 0 }, { backpressureLimit: 8 * 1024 * 1024, idleTimeout: 0, maxPayloadLength: 1024 * 1024 }],
		[{ idleTimeout: 1 }, { backpressureLimit: 8 * 1024 * 1024, idleTimeout: 1, maxPayloadLength: 1024 * 1024 }],
		[
			{ idleTimeout: 2_000_000 },
			{ backpressureLimit: 8 * 1024 * 1024, idleTimeout: 960, maxPayloadLength: 1024 * 1024 },
		],
		[
			{ backpressureLimit: 0, maxPayload: 10 },
			{ backpressureLimit: 1, idleTimeout: 120, maxPayloadLength: 10 },
		],
	])("%j → %j: idle in whole seconds, at most 960; honey applies its own send policy", (options, limits) => {
		const { backpressureLimit, closeOnBackpressureLimit, idleTimeout, maxPayloadLength } =
			bunWebSocket(options).websocket
		expect([{ backpressureLimit, idleTimeout, maxPayloadLength }, closeOnBackpressureLimit]).toEqual([limits, false])
	})

	it("a failing handler never throws into Bun", async () => {
		const server = bunServer()
		const adapter = bunWebSocket()
		await adapter.upgrade(
			new Request("http://h/ws"),
			{ server },
			{
				onOpen: () => {
					throw new Error("boom")
				},
			},
		)
		expect(() => adapter.websocket.open(bunSocket(server.upgrades[0]?.data))).not.toThrow()
		vi.restoreAllMocks()
	})
})
