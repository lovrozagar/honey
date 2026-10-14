import { describe, expect, it } from "vitest"
import { optionalPeer } from "./optional-peer.ts"

describe("optionalPeer: an optional npm peer, loaded when first needed", () => {
	it("loads once and shares the load between callers", async () => {
		let loads = 0
		const load = optionalPeer("ws", "WebSocket routes on Node", async () => {
			loads++
			return { WebSocketServer: "ctor" }
		})
		const [a, b] = await Promise.all([load(), load()])
		expect([a, b === a, await load(), loads]).toEqual([{ WebSocketServer: "ctor" }, true, a, 1])
	})

	it("names the package and the install command when it is missing, with the cause kept", async () => {
		const missing = new Error("Cannot find package 'ws'")
		const load = optionalPeer("ws", "WebSocket routes on Node", () => Promise.reject(missing))
		const error = await load().catch((e: unknown) => e)
		expect([(error as Error).message, (error as Error).cause]).toEqual([
			'WebSocket routes on Node need the "ws" package, an optional peer dependency of honey. Install it: npm install ws',
			missing,
		])
	})

	it("does not remember a failure: installing the peer later works without a restart", async () => {
		let installed = false
		const load = optionalPeer("ws", "WebSocket routes on Node", async () => {
			if (!installed) throw new Error("missing")
			return "module"
		})
		await expect(load()).rejects.toThrow('need the "ws" package')
		installed = true
		expect(await load()).toBe("module")
	})
})
