import { describe, expect, it, vi } from "vitest"

let installed = false
vi.mock("ws", () => {
	if (!installed) throw new Error("Cannot find package 'ws'")
	return {
		WebSocketServer: class {
			handleUpgrade(_r: unknown, _s: unknown, _h: unknown, cb: (ws: unknown) => void) {
				cb({ binaryType: "", on() {}, readyState: 1 })
			}
		},
	}
})

describe("nodeWebSocket without the ws package", () => {
	it("fails the upgrade with an install hint, and works once ws is there (not cached)", async () => {
		const { nodeWebSocket } = await import("../../../src/ws/node.ts")
		const adapter = nodeWebSocket()
		const env = { __nodeUpgrade: { head: Buffer.alloc(0), req: {}, socket: {}, upgraded: false } }
		await expect(adapter.upgrade(new Request("http://x/ws"), env, {})).rejects.toThrow(/npm install ws/)
		installed = true
		vi.resetModules()
		await expect(adapter.upgrade(new Request("http://x/ws"), env, {})).resolves.toMatchObject({
			response: { status: 101 },
		})
	})
})
