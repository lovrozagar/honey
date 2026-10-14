import { describe, expect, it, vi } from "vitest"
import { fireHandler, type RawSocket, switchingProtocols, WS_SEND_BUFFER_MAX, WSContextImpl } from "./contract.ts"

/** A socket stand-in that records what was sent and how it was closed; `open()` fires its open listeners. */
function rawSocket(readyState: number, bufferedAmount = 0) {
	const listeners: (() => void)[] = []
	const socket = {
		addEventListener: (type: string, listener: () => void) => {
			if (type === "open") listeners.push(listener)
		},
		bufferedAmount,
		closed: [] as [number | undefined, string | undefined][],
		close(code?: number, reason?: string) {
			this.closed.push([code, reason])
			this.readyState = 3
		},
		open() {
			this.readyState = 1
			for (const listener of listeners) listener()
		},
		readyState,
		sent: [] as unknown[],
		send(data: unknown) {
			this.sent.push(data)
		},
	}
	return socket
}

const limits = (backpressurePolicy: "close" | "drop") => ({ backpressureLimit: 100, backpressurePolicy })

describe("WSContextImpl: sending", () => {
	it("sends strings and bytes as they are, and other values as JSON", () => {
		const raw = rawSocket(1)
		const ws = new WSContextImpl(raw)
		const bytes = new Uint8Array([1])
		const buffer = new ArrayBuffer(2)
		ws.send("text")
		ws.send(bytes)
		ws.send(buffer)
		ws.send({ n: 1 })
		ws.send([1, "x"])
		expect(raw.sent).toEqual(["text", bytes, buffer, '{"n":1}', '[1,"x"]'])
	})

	it("queues what is sent while the socket opens, keeps the newest 32, and sends them on open", () => {
		const raw = rawSocket(0)
		const ws = new WSContextImpl(raw)
		for (let i = 0; i < WS_SEND_BUFFER_MAX + 3; i++) ws.send(String(i))
		expect(raw.sent).toEqual([])
		raw.open()
		expect(raw.sent).toEqual(Array.from({ length: WS_SEND_BUFFER_MAX }, (_, i) => String(i + 3)))
	})

	it("flush() sends the queue for a runtime with no open event", () => {
		const raw = { ...rawSocket(0), addEventListener: undefined }
		const ws = new WSContextImpl(raw as unknown as RawSocket)
		ws.send("waiting")
		raw.readyState = 1
		ws.flush()
		expect(raw.sent).toEqual(["waiting"])
	})

	it("drops what is sent once the socket is closing or closed", () => {
		const closing = rawSocket(2)
		const closed = rawSocket(3)
		new WSContextImpl(closing).send("late")
		new WSContextImpl(closed).send("late")
		expect([closing.sent, closed.sent]).toEqual([[], []])
	})
})

describe("WSContextImpl: backpressure", () => {
	it("over the limit, the close policy closes 1013 and sends nothing", () => {
		const raw = rawSocket(1, 101)
		new WSContextImpl(raw, limits("close")).send("x")
		expect([raw.sent, raw.closed]).toEqual([[], [[1013, "slow consumer"]]])
	})

	it("over the limit, the drop policy discards the message and keeps the socket", () => {
		const raw = rawSocket(1, 101)
		new WSContextImpl(raw, limits("drop")).send("x")
		expect([raw.sent, raw.closed]).toEqual([[], []])
	})

	it("at the limit, without limits, or with a 0 limit, the message is sent", () => {
		const atLimit = rawSocket(1, 100)
		const unlimited = rawSocket(1, 10_000)
		const off = rawSocket(1, 10_000)
		new WSContextImpl(atLimit, limits("close")).send("a")
		new WSContextImpl(unlimited).send("b")
		new WSContextImpl(off, { backpressureLimit: 0, backpressurePolicy: "close" }).send("c")
		expect([atLimit.sent, unlimited.sent, off.sent]).toEqual([["a"], ["b"], ["c"]])
	})
})

describe("WSContextImpl: closing and state", () => {
	it("close() cuts the reason to 123 UTF-8 bytes and clears the open queue", () => {
		const raw = rawSocket(0)
		const ws = new WSContextImpl(raw)
		ws.send("never")
		ws.close(4000, "é".repeat(100))
		ws.close()
		raw.open()
		expect([raw.closed, raw.sent]).toEqual([
			[
				[4000, "é".repeat(61)],
				[undefined, undefined],
			],
			[],
		])
	})

	it("reports the socket's readyState and bufferedAmount", () => {
		const raw = rawSocket(1, 42)
		const ws = new WSContextImpl(raw)
		expect([ws.readyState, ws.bufferedAmount, ws.raw]).toEqual([1, 42, raw])
	})
})

describe("fireHandler: an adapter event never throws into the runtime", () => {
	it("contains a throw and a rejection, logging them under the event's phase", async () => {
		const log = { error: vi.fn() }
		fireHandler(
			"message",
			() => {
				throw new Error("sync")
			},
			log,
		)
		fireHandler("close", () => Promise.reject(new Error("async")), log)
		fireHandler("open", () => "fine")
		await vi.waitFor(() => expect(log.error).toHaveBeenCalledTimes(2))
		expect(log.error.mock.calls.map(([fields]) => fields.phase)).toEqual(["websocket message", "websocket close"])
	})
})

describe("switchingProtocols: the 101 an adapter answers with", () => {
	it("where Fetch refuses 101 (Node, Bun), an empty response that reports 101 with the handshake headers", () => {
		const response = switchingProtocols({ "sec-websocket-protocol": "chat", upgrade: "websocket" })
		expect([response.status, Object.fromEntries(response.headers), response.body]).toEqual([
			101,
			{ "sec-websocket-protocol": "chat", upgrade: "websocket" },
			null,
		])
	})

	it("where Fetch builds a 101 (Workers), the real one, with the runtime's socket in its init", () => {
		const built: unknown[] = []
		vi.stubGlobal(
			"Response",
			class {
				readonly status: number
				constructor(_body: null, init: { status: number; webSocket: unknown }) {
					built.push(init)
					this.status = init.status
				}
			},
		)
		const client = { side: "client" }
		const response = switchingProtocols({ upgrade: "websocket" }, { webSocket: client })
		vi.unstubAllGlobals()
		expect([response.status, built]).toEqual([
			101,
			[{ headers: { upgrade: "websocket" }, status: 101, webSocket: client }],
		])
	})
})
