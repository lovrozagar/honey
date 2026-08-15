import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createClient } from "../../../src/client/index.ts"

describe("client WS proxy", () => {
	let capturedUrl: string | undefined
	let capturedProtocols: string | string[] | undefined
	const originalWebSocket = globalThis.WebSocket

	beforeEach(() => {
		capturedUrl = undefined
		capturedProtocols = undefined

		globalThis.WebSocket = class MockWebSocket extends EventTarget {
			static readonly CLOSED = 3
			static readonly CLOSING = 2
			static readonly CONNECTING = 0
			static readonly OPEN = 1
			readonly CLOSED = 3
			readonly CLOSING = 2
			readonly CONNECTING = 0
			readonly OPEN = 1
			binaryType: BinaryType = "blob"
			bufferedAmount = 0
			extensions = ""
			onclose = null
			onerror = null
			onmessage = null
			onopen = null
			protocol = ""
			readyState = 0
			url: string
			constructor(url: string | URL, protocols?: string | string[]) {
				super()
				capturedUrl = String(url)
				capturedProtocols = protocols
				this.url = String(url)
			}
			close() {}
			send() {}
		} as unknown as typeof WebSocket
	})

	afterEach(() => {
		globalThis.WebSocket = originalWebSocket
	})

	it("ws() builds correct WSS URL", () => {
		const client = createClient({ baseURL: "https://api.example.com" })
		const proxy = client as unknown as {
			ws: (path: string, input?: unknown) => unknown
		}
		proxy.ws("/chat")
		expect(capturedUrl).toBe("wss://api.example.com/chat")
	})

	it("ws() interpolates params", () => {
		const client = createClient({ baseURL: "https://api.example.com" })
		const proxy = client as unknown as {
			ws: (path: string, input?: { params?: Record<string, string> }) => unknown
		}
		proxy.ws("/chat/:room", { params: { room: "123" } })
		expect(capturedUrl).toBe("wss://api.example.com/chat/123")
	})

	it("ws() appends reconnect_token with ?", () => {
		const client = createClient({ baseURL: "https://api.example.com" })
		const proxy = client as unknown as {
			ws: (path: string, input?: { reconnectToken?: string }) => unknown
		}
		proxy.ws("/chat", { reconnectToken: "abc" })
		expect(capturedUrl).toBe("wss://api.example.com/chat?reconnect_token=abc")
	})

	it("ws() appends reconnect_token with & when query exists", () => {
		const client = createClient({ baseURL: "https://api.example.com" })
		const proxy = client as unknown as {
			ws: (path: string, input?: { reconnectToken?: string; search?: Record<string, unknown> }) => unknown
		}
		proxy.ws("/chat", { reconnectToken: "abc", search: { x: "1" } })
		expect(capturedUrl).toContain("x=1")
		expect(capturedUrl).toContain("&reconnect_token=abc")
	})

	it("ws() passes protocols through", () => {
		const client = createClient({ baseURL: "https://api.example.com" })
		const proxy = client as unknown as {
			ws: (path: string, input?: { protocols?: string[] }) => unknown
		}
		proxy.ws("/chat", { protocols: ["v1", "v2"] })
		expect(capturedProtocols).toEqual(["v1", "v2"])
	})
})
