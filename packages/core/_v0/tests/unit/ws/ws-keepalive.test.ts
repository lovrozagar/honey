import { describe, expect, it } from "vitest"
import { bunWebSocket } from "../../../src/ws/bun.ts"
import { cfWebSocket } from "../../../src/ws/cloudflare.ts"
import { denoWebSocket } from "../../../src/ws/deno.ts"
import { nodeWebSocket } from "../../../src/ws/node.ts"

describe("WebSocket adapter options", () => {
	it("nodeWebSocket accepts keepalive config", () => {
		const adapter = nodeWebSocket({
			keepalive: { interval: 30_000, timeout: 10_000 },
		})
		expect(adapter).toBeDefined()
		expect(typeof adapter.upgrade).toBe("function")
	})

	it("every adapter resolves the same defaults", () => {
		for (const adapter of [nodeWebSocket(), bunWebSocket(), denoWebSocket(), cfWebSocket()]) {
			expect(adapter.options).toMatchObject({
				backpressureLimit: 8 * 1024 * 1024,
				backpressurePolicy: "close",
				idleTimeout: 120_000,
				maxPayload: 1024 * 1024,
			})
		}
	})

	it("bunWebSocket hands its limits to Bun.serve({ websocket })", () => {
		const adapter = bunWebSocket({ idleTimeout: 30_500, maxPayload: 2048 })
		expect(adapter.websocket.maxPayloadLength).toBe(2048)
		/* Bun takes whole seconds */
		expect(adapter.websocket.idleTimeout).toBe(31)
		expect(adapter.websocket.closeOnBackpressureLimit).toBe(false)
		expect(bunWebSocket({ idleTimeout: 0 }).websocket.idleTimeout).toBe(0)
		/* Bun's ceiling */
		expect(bunWebSocket({ idleTimeout: 3_600_000 }).websocket.idleTimeout).toBe(960)
	})
})
