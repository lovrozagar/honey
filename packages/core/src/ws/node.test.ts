import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { WebSocket as WsClient } from "ws"
import type { WSAdapter, WSContext, WSHandler } from "./contract.ts"
import { NODE_UPGRADE, type NodeUpgrade, nodeWebSocket, type NodeWebSocketOptions } from "./node.ts"

const servers: Server[] = []
const clients: { close(): void }[] = []

afterEach(async () => {
	for (const client of clients.splice(0)) client.close()
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections()
					server.close(() => resolve())
				}),
		),
	)
	vi.doUnmock("ws")
	vi.useRealTimers()
})

/** A node:http server whose 'upgrade' hands each request to `adapter` the way the Node bridge does. */
async function upgradeServer(adapter: WSAdapter, handler: WSHandler<unknown>) {
	const upgrades: NodeUpgrade[] = []
	const failures: unknown[] = []
	const server = createServer()
	server.on("upgrade", (req, socket, head) => {
		const view = new Request(`http://127.0.0.1${req.url}`, { headers: req.headers as Record<string, string> })
		const upgrade: NodeUpgrade = { head, req, socket, upgraded: false }
		upgrades.push(upgrade)
		Object.defineProperty(view, NODE_UPGRADE, { value: upgrade })
		Promise.resolve(adapter.upgrade(view, {}, handler)).catch((error: unknown) => failures.push(error))
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	return { failures, port: (server.address() as AddressInfo).port, upgrades }
}

/** A `ws` client connected to `port`; `autoPong: false` makes a peer that never answers pings. */
async function connectTo(port: number, options: { autoPong?: boolean; protocols?: string[] } = {}) {
	const client = new WsClient(`ws://127.0.0.1:${port}/live`, options.protocols ?? [], {
		autoPong: options.autoPong ?? true,
	})
	clients.push(client)
	await new Promise((resolve, reject) => {
		client.once("open", resolve)
		client.once("error", reject)
	})
	return client
}

/** A handler that records every event; `opened` resolves with the server-side socket. */
function recording() {
	const seen: unknown[] = []
	const opened = Promise.withResolvers<WSContext>()
	const closed = Promise.withResolvers<void>()
	const handler: WSHandler<unknown> = {
		onClose: (_c, _ws, code, reason) => {
			seen.push(["close", code, reason])
			closed.resolve()
		},
		onError: (_c, _ws, error) => void seen.push(["error", (error as Error).message]),
		onMessage: (_c, _ws, data) => void seen.push(["message", data]),
		onOpen: (_c, ws) => {
			seen.push(["open"])
			opened.resolve(ws)
		},
	}
	return { closed: closed.promise, handler, opened: opened.promise, seen }
}

describe("nodeWebSocket: the upgrade through ws", () => {
	// v0: 44fcb722c7
	// v0: 025b4291ee
	// v0: 8abf59f5ed
	it("ws writes the 101, the upgrade is marked done before the handler opens, and the answer reports 101", async () => {
		const { handler, opened } = recording()
		const adapter = nodeWebSocket()
		let markedFirst = false
		const observed: WSHandler<unknown> = {
			...handler,
			onOpen: (c, ws) => {
				markedFirst = upgrades[0]?.upgraded === true
				return handler.onOpen?.(c, ws)
			},
		}
		const { port, upgrades } = await upgradeServer(adapter, observed)
		await connectTo(port)
		const socket = await opened
		expect([markedFirst, socket.readyState]).toEqual([true, 1])
	})

	// v0: 2ef43014fb
	// v0: 0118832a60
	// v0: 45d66a6777
	// v0: 69827f5c2b
	// v0: 1a477c43b5
	it("a text frame arrives as a string, a binary one as exactly its bytes, then the close with its code and reason", async () => {
		const { closed, handler, seen } = recording()
		const { port } = await upgradeServer(nodeWebSocket(), handler)
		const client = await connectTo(port)
		client.send("hi")
		client.send(Buffer.from([1, 2, 3]))
		await vi.waitFor(() => expect(seen).toHaveLength(3))
		client.close(4000, "done")
		await closed
		const binary = (seen[2] as [string, ArrayBuffer])[1]
		expect([seen[0], seen[1], binary instanceof ArrayBuffer, [...new Uint8Array(binary)], seen[3]]).toEqual([
			["open"],
			["message", "hi"],
			true,
			[1, 2, 3],
			["close", 4000, "done"],
		])
	})

	// v0: 5f43c69959
	it("answers the first offered subprotocol by default, the one `protocol` picks, and none for a pick not offered", async () => {
		const first = await upgradeServer(nodeWebSocket(), {})
		const picked = await upgradeServer(nodeWebSocket({ protocol: (offered) => offered.at(-1) }), {})
		const stray = await upgradeServer(nodeWebSocket({ protocol: () => "unoffered" }), {})
		const [a, b, c] = await Promise.all([
			connectTo(first.port, { protocols: ["chat", "v2"] }),
			connectTo(picked.port, { protocols: ["chat", "v2"] }),
			connectTo(stray.port, { protocols: ["chat"] }).catch((error: Error) => error.message),
		])
		expect([a.protocol, b.protocol, c]).toEqual(["chat", "v2", "Server sent no subprotocol"])
	})
})

describe("nodeWebSocket: what it refuses", () => {
	// v0: 61ddd08ef5
	// v0: 9a1bde85dc
	it("refuses a frame over maxPayload (1009) without delivering it; onError hears why", async () => {
		const { closed, handler, seen } = recording()
		const { port } = await upgradeServer(nodeWebSocket({ maxPayload: 4 }), handler)
		const client = await connectTo(port)
		const clientClose = new Promise<number>((resolve) => client.once("close", resolve))
		client.send("12345")
		await closed
		/* the client is told 1009; the server's own side sees the socket end abnormally */
		expect([await clientClose, seen.slice(0, 2), (seen[2] as unknown[])[0]]).toEqual([
			1009,
			[["open"], ["error", "Max payload size exceeded"]],
			"close",
		])
	})

	it("fails, never hangs, when ws answers a malformed handshake itself", async () => {
		const { port, failures } = await upgradeServer(nodeWebSocket(), {})
		const raw = await import("node:net").then(({ connect }) => connect(port, "127.0.0.1"))
		raw.on("error", () => {})
		raw.write("GET /live HTTP/1.1\r\nHost: h\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		await vi.waitFor(() => expect(failures).toHaveLength(1))
		raw.destroy()
		expect((failures[0] as Error).message).toBe("WebSocket handshake failed")
	})

	it("refuses a request that did not come through the Node bridge's upgrade listener", async () => {
		await expect(Promise.resolve(nodeWebSocket().upgrade(new Request("http://h/live"), {}, {}))).rejects.toThrow(
			"nodeWebSocket needs the upgrade socket: serve the app with serve(app) on Node",
		)
	})
})

/** Open one connection with `options`; the server socket, the client and the close resolve. */
async function watched(options: NodeWebSocketOptions, autoPong = true) {
	const { closed, handler, opened } = recording()
	const { port } = await upgradeServer(nodeWebSocket(options), handler)
	const client = await connectTo(port, { autoPong })
	return { client, closed, socket: await opened }
}

describe("nodeWebSocket: keepalive and idle", () => {
	// v0: 360a4dfee4
	// v0: 45a4f5282d
	it("pings on the interval and a peer that pongs stays open", async () => {
		const { client } = await watched({ idleTimeout: 0, keepalive: { interval: 20, timeout: 40 } })
		let pings = 0
		client.on("ping", () => pings++)
		await new Promise((resolve) => setTimeout(resolve, 120))
		expect([pings >= 3, client.readyState]).toEqual([true, 1])
	})

	// v0: 4b66e7b013
	it("terminates a peer whose pong never comes", async () => {
		const { client, closed } = await watched({ idleTimeout: 0, keepalive: { interval: 20, timeout: 20 } }, false)
		const code = new Promise<number>((resolve) => client.once("close", resolve))
		await closed
		/* terminated, not closed: the client sees the connection drop */
		expect(await code).toBe(1006)
	})

	// v0: d11ed2cc49
	// v0: 199c718211
	it("idleTimeout pings a quiet peer halfway, then ends it; traffic keeps a peer alive", async () => {
		vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] })
		const quiet = await watched({ idleTimeout: 100 }, false)
		const chatty = await watched({ idleTimeout: 100 }, false)
		const pinged = new Promise((resolve) => quiet.client.once("ping", resolve))
		vi.advanceTimersByTime(50)
		await pinged
		vi.advanceTimersByTime(25)
		chatty.client.send("still here")
		/* real time for the frame to arrive; the fake clock stands still meanwhile */
		await new Promise((resolve) => setTimeout(resolve, 20))
		/* the next check: the quiet peer has been silent the whole timeout, the chatty one only a quarter of it */
		vi.advanceTimersByTime(25)
		await quiet.closed
		expect([chatty.client.readyState, quiet.socket.readyState]).toEqual([1, 3])
	})

	// v0: 96e79d6aac
	// v0: 761d3d1de1
	// v0: b326c630da
	// v0: 9a1901ee18
	it("refuses keepalive values that are not positive, and takes valid ones", () => {
		expect(() => nodeWebSocket({ keepalive: { interval: 0, timeout: 5 } })).toThrow(
			"nodeWebSocket: keepalive.interval and keepalive.timeout must be positive",
		)
		expect(() => nodeWebSocket({ keepalive: { interval: 5, timeout: -1 } })).toThrow("must be positive")
		expect([
			nodeWebSocket({ keepalive: { interval: 5, timeout: 5 } }).runtime,
			nodeWebSocket().options?.idleTimeout,
		]).toEqual(["node", 120_000])
	})
})

describe("nodeWebSocket: containment and shutdown", () => {
	// v0: e3a4aae4cc
	// v0: b5b260e1a3
	// v0: 7486902fe5
	it("a handler that throws or rejects never throws into ws; the connection keeps working", async () => {
		const received: unknown[] = []
		const { port } = await upgradeServer(nodeWebSocket(), {
			onMessage: (_c, ws, data) => {
				if (data === "boom") throw new Error("handler failed")
				ws.send(`echo:${String(data)}`)
			},
			onOpen: () => Promise.reject(new Error("open failed")),
		})
		const client = await connectTo(port)
		client.on("message", (data) => received.push(String(data)))
		client.send("boom")
		client.send("ok")
		await vi.waitFor(() => expect(received).toEqual(["echo:ok"]))
	})

	// v0: 55869913d8
	it("closeAll closes every open socket with the code it is given", async () => {
		const adapter = nodeWebSocket()
		const first = recording()
		const { port } = await upgradeServer(adapter, first.handler)
		const a = await connectTo(port)
		const codes: number[] = []
		a.on("close", (code) => codes.push(code))
		await first.opened
		adapter.closeAll?.(1001, "server shutting down")
		await vi.waitFor(() => expect(codes).toEqual([1001]))
	})

	it("names the package to install when ws is missing, and loads it once installed", async () => {
		vi.doMock("ws", () => {
			throw new Error("Cannot find package 'ws'")
		})
		const adapter = nodeWebSocket()
		const view = new Request("http://h/live")
		Object.defineProperty(view, NODE_UPGRADE, {
			value: { head: Buffer.alloc(0), req: {}, socket: {}, upgraded: false },
		})
		await expect(Promise.resolve(adapter.upgrade(view, {}, {}))).rejects.toThrow(
			'WebSocket routes on Node need the "ws" package, an optional peer dependency of honey. Install it: npm install ws',
		)
	})
})
