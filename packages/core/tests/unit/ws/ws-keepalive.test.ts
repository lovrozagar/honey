import { describe, expect, it } from "vitest"
import { bunWebSocket } from "../../../src/ws/bun.ts"
import { denoWebSocket } from "../../../src/ws/deno.ts"
import { nodeWebSocket } from "../../../src/ws/node.ts"

describe("WebSocket keepalive config", () => {
	it("nodeWebSocket accepts keepalive config", () => {
		const adapter = nodeWebSocket({
			keepalive: { interval: 30_000, timeout: 10_000 },
		})
		expect(adapter).toBeDefined()
		expect(typeof adapter.upgrade).toBe("function")
	})

	it("bunWebSocket takes no arguments", () => {
		const adapter = bunWebSocket()
		expect(adapter).toBeDefined()
		expect(typeof adapter.upgrade).toBe("function")
		expect(adapter.websocket).toBeDefined()
		expect(bunWebSocket.length).toBe(0)
	})

	it("denoWebSocket takes no arguments", () => {
		const adapter = denoWebSocket()
		expect(adapter).toBeDefined()
		expect(typeof adapter.upgrade).toBe("function")
		expect(denoWebSocket.length).toBe(0)
	})

	it("error handler clears keepalive timers (source verification)", async () => {
		/* nodeWebSocket wires ws.on("error") inside a dynamic import("ws") + handleUpgrade callback.
		   Full integration test would need a real ws server. Instead, verify the source code pattern:
		   the error handler must clear timers the same way the close handler does. */
		const { readFileSync } = await import("node:fs")
		const { resolve } = await import("node:path")
		const dir = new URL(".", import.meta.url).pathname
		const source = readFileSync(resolve(dir, "../../../src/ws/node.ts"), "utf-8")

		/* find the error handler block */
		const errorHandlerMatch = source.match(/ws\.on\("error"[\s\S]*?\}\)/)
		expect(errorHandlerMatch).not.toBeNull()
		const errorBlock = errorHandlerMatch?.[0] ?? ""

		/* must clear both interval and timeout — same as close handler */
		expect(errorBlock).toContain("clearInterval(pingTimer)")
		expect(errorBlock).toContain("clearTimeout(pongTimeout)")
	})
})
