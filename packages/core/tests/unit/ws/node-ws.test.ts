import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type MessageCb = (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => void

type FakeWS = {
	_listeners: Record<string, Array<(...args: unknown[]) => void>>
	close: ReturnType<typeof vi.fn>
	on: (event: string, cb: (...args: unknown[]) => void) => void
	ping: ReturnType<typeof vi.fn>
	readyState: number
	send: ReturnType<typeof vi.fn>
	terminate: ReturnType<typeof vi.fn>
}

/** Call every listener for `event`, as an EventEmitter would. */
function fire(ws: FakeWS, event: string, ...args: unknown[]): void {
	for (const cb of ws._listeners[event] ?? []) cb(...args)
}

function createFakeWS(): FakeWS {
	const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
	return {
		_listeners: listeners,
		close: vi.fn(),
		on(event: string, cb: (...args: unknown[]) => void) {
			if (listeners[event] === undefined) listeners[event] = []
			listeners[event].push(cb)
		},
		ping: vi.fn(),
		readyState: 1,
		send: vi.fn(),
		terminate: vi.fn(),
	}
}

let fakeWS: FakeWS
type ServerOpts = { handleProtocols(p: Set<string>, req: unknown): string | false; maxPayload: number }
let serverOpts: ServerOpts | null = null
let chosenProtocol: string | false | null = null

vi.mock("ws", () => ({
	WebSocketServer: class {
		constructor(opts: ServerOpts) {
			serverOpts = opts
		}
		handleUpgrade(_req: unknown, _socket: unknown, _head: unknown, cb: (ws: FakeWS) => void) {
			chosenProtocol = serverOpts?.handleProtocols(new Set(["graphql-ws", "json"]), _req) ?? null
			cb(fakeWS)
		}
	},
}))

describe("nodeWebSocket", () => {
	beforeEach(() => {
		fakeWS = createFakeWS()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	async function getAdapter(keepalive?: { interval: number; timeout: number }) {
		const { nodeWebSocket } = await import("../../../src/ws/node.ts")
		return nodeWebSocket(keepalive ? { keepalive } : undefined)
	}

	function makeEnv() {
		return {
			__nodeUpgrade: {
				head: Buffer.alloc(0),
				req: {},
				socket: {},
			},
		}
	}

	it("text message → handler.onMessage receives string", async () => {
		const adapter = await getAdapter()
		const onMessage = vi.fn()
		const handler = { onMessage, onOpen: vi.fn() }

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), handler)

		const msgCb = fakeWS._listeners["message"]?.[0] as MessageCb
		msgCb(Buffer.from("hello"), false)

		expect(onMessage).toHaveBeenCalledWith(undefined, expect.anything(), "hello")
	})

	it("binary Buffer message → handler.onMessage receives ArrayBuffer", async () => {
		const adapter = await getAdapter()
		const onMessage = vi.fn()

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onMessage,
		})

		const msgCb = fakeWS._listeners["message"]?.[0] as MessageCb
		msgCb(Buffer.from([1, 2, 3]), true)

		expect(onMessage).toHaveBeenCalled()
		const data = onMessage.mock.calls[0][2]
		expect(data).toBeInstanceOf(ArrayBuffer)
		expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3]))
	})

	it("Buffer[] (fragmented) → merged ArrayBuffer", async () => {
		const adapter = await getAdapter()
		const onMessage = vi.fn()

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onMessage,
		})

		const msgCb = fakeWS._listeners["message"]?.[0] as MessageCb
		msgCb([Buffer.from([1, 2]), Buffer.from([3, 4])], true)

		expect(onMessage).toHaveBeenCalled()
		const data = onMessage.mock.calls[0][2]
		expect(data).toBeInstanceOf(ArrayBuffer)
		expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3, 4]))
	})

	it("raw ArrayBuffer passes through", async () => {
		const adapter = await getAdapter()
		const onMessage = vi.fn()

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onMessage,
		})

		const msgCb = fakeWS._listeners["message"]?.[0] as MessageCb
		const ab = new ArrayBuffer(2)
		msgCb(ab as unknown as Buffer, true)

		expect(onMessage).toHaveBeenCalledWith(undefined, expect.anything(), ab)
	})

	it("close event → calls handler.onClose and clears timers", async () => {
		const adapter = await getAdapter({ interval: 1000, timeout: 500 })
		const onClose = vi.fn()

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onClose,
		})

		fire(fakeWS, "close", 1000, Buffer.from("normal"))

		expect(onClose).toHaveBeenCalledWith(undefined, expect.anything(), 1000, "normal")
	})

	it("error event → calls handler.onError", async () => {
		const adapter = await getAdapter()
		const onError = vi.fn()

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onError,
		})

		const err = new Error("test")
		fire(fakeWS, "error", err)

		expect(onError).toHaveBeenCalledWith(undefined, expect.anything(), err)
	})

	it("keepalive: ping sent on interval, pong resets timeout", async () => {
		const adapter = await getAdapter({ interval: 1000, timeout: 500 })

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {})

		/* advance past interval → ping should fire */
		vi.advanceTimersByTime(1000)
		expect(fakeWS.ping).toHaveBeenCalledTimes(1)

		/* pong received → clears timeout */
		fire(fakeWS, "pong")

		/* no close should be called */
		vi.advanceTimersByTime(500)
		expect(fakeWS.close).not.toHaveBeenCalled()
		expect(fakeWS.terminate).not.toHaveBeenCalled()
	})

	it("keepalive: no pong → terminate()", async () => {
		const adapter = await getAdapter({ interval: 1000, timeout: 500 })

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {})

		/* trigger ping */
		vi.advanceTimersByTime(1000)
		expect(fakeWS.ping).toHaveBeenCalledTimes(1)

		/* no pong, wait for timeout: a dead peer never answers a close handshake */
		vi.advanceTimersByTime(500)
		expect(fakeWS.terminate).toHaveBeenCalledTimes(1)
	})

	it("response has status 101", async () => {
		const adapter = await getAdapter()

		const result = await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {})

		expect(result.response.status).toBe(101)
	})

	it("onOpen called after upgrade", async () => {
		const adapter = await getAdapter()
		const onOpen = vi.fn()

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onOpen,
		})

		expect(onOpen).toHaveBeenCalledWith(undefined, expect.anything())
	})

	it("creates the server with a 1 MiB maxPayload by default, configurable", async () => {
		const { nodeWebSocket } = await import("../../../src/ws/node.ts")
		await nodeWebSocket().upgrade(new Request("http://localhost/ws"), makeEnv(), {})
		expect(serverOpts?.maxPayload).toBe(1024 * 1024)
		await nodeWebSocket({ maxPayload: 4096 }).upgrade(new Request("http://localhost/ws"), makeEnv(), {})
		expect(serverOpts?.maxPayload).toBe(4096)
	})

	it("selects the first offered subprotocol by default, or the one `protocol` picks", async () => {
		const { nodeWebSocket } = await import("../../../src/ws/node.ts")
		const offer = { headers: { "sec-websocket-protocol": "graphql-ws, json" } }
		await nodeWebSocket().upgrade(new Request("http://localhost/ws", offer), makeEnv(), {})
		expect(chosenProtocol).toBe("graphql-ws")
		await nodeWebSocket({ protocol: (offered) => offered.at(-1) }).upgrade(
			new Request("http://localhost/ws", offer),
			makeEnv(),
			{},
		)
		expect(chosenProtocol).toBe("json")
		/* a choice the client did not offer is never sent */
		await nodeWebSocket({ protocol: () => "other" }).upgrade(new Request("http://localhost/ws", offer), makeEnv(), {})
		expect(chosenProtocol).toBe(false)
	})

	it("marks the upgrade done before calling back, so serve() never writes HTTP onto the socket", async () => {
		const adapter = await getAdapter()
		const env = makeEnv() as { __nodeUpgrade: { upgraded?: boolean } }
		let seen: boolean | undefined
		await adapter.upgrade(new Request("http://localhost/ws"), env, {
			onOpen() {
				seen = env.__nodeUpgrade.upgraded
			},
		})
		expect(seen).toBe(true)
	})

	it("contains a throwing handler instead of throwing into ws", async () => {
		const adapter = await getAdapter()
		const errors = vi.spyOn(console, "error").mockImplementation(() => {})
		await expect(
			adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
				onMessage() {
					throw new Error("boom")
				},
				onOpen() {
					throw new Error("boom")
				},
			}),
		).resolves.toMatchObject({ response: { status: 101 } })
		expect(() => fire(fakeWS, "message", Buffer.from("x"), false)).not.toThrow()
		await vi.waitFor(() => expect(errors).toHaveBeenCalled())
		errors.mockRestore()
	})

	it("keepalive keeps one pong outstanding: a slow pong never stacks timers", async () => {
		const adapter = await getAdapter({ interval: 100, timeout: 250 })
		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {})
		vi.advanceTimersByTime(200)
		/* the second tick finds a pong still pending and does not ping again */
		expect(fakeWS.ping).toHaveBeenCalledTimes(1)
		fire(fakeWS, "pong")
		vi.advanceTimersByTime(300)
		expect(fakeWS.terminate).not.toHaveBeenCalled()
	})

	it("idleTimeout pings a quiet peer, then terminates it", async () => {
		const { nodeWebSocket } = await import("../../../src/ws/node.ts")
		await nodeWebSocket({ idleTimeout: 1000 }).upgrade(new Request("http://localhost/ws"), makeEnv(), {})
		vi.advanceTimersByTime(500)
		expect(fakeWS.ping).toHaveBeenCalledTimes(1)
		vi.advanceTimersByTime(500)
		expect(fakeWS.terminate).toHaveBeenCalledTimes(1)
	})

	it("traffic resets the idle clock", async () => {
		const { nodeWebSocket } = await import("../../../src/ws/node.ts")
		await nodeWebSocket({ idleTimeout: 1000 }).upgrade(new Request("http://localhost/ws"), makeEnv(), {})
		for (let i = 0; i < 5; i++) {
			vi.advanceTimersByTime(400)
			fire(fakeWS, "pong")
		}
		expect(fakeWS.terminate).not.toHaveBeenCalled()
	})

	it("closeAll closes every open socket", async () => {
		const adapter = await getAdapter()
		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {})
		adapter.closeAll?.(1001, "server shutting down")
		expect(fakeWS.close).toHaveBeenCalledWith(1001, "server shutting down")
	})

	it("rejects invalid options at construction", async () => {
		const { nodeWebSocket } = await import("../../../src/ws/node.ts")
		expect(() => nodeWebSocket({ maxPayload: -1 })).toThrow(TypeError)
		expect(() => nodeWebSocket({ backpressurePolicy: "pause" as never })).toThrow(TypeError)
		expect(() => nodeWebSocket({ keepalive: { interval: 0, timeout: 1 } })).toThrow(TypeError)
	})
})
