/**
 * WS4–WS8 findings on the server lifecycle and the package, frozen as regressions: shutdown with
 * open WebSockets, `serve(app)` keeping the app's own ws adapter, and `ws` as an optional peer.
 */
import { readFileSync } from "node:fs"
import { Agent, get } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { WebSocket as WsClient } from "ws"
import { serve as serveNode } from "../../src/adapters/node/serve.ts"
import { serve } from "../../src/adapters/serve.ts"
import { honey } from "../../src/routing/app.ts"
import type { WSAdapter } from "../../src/ws/contract.ts"
import { nodeWebSocket } from "../../src/ws/node.ts"
import { ws } from "../../src/ws/route.ts"

/** The first message a client gets from `url`, with the client. */
function firstMessage(url: string): Promise<[string, WsClient]> {
	return new Promise((resolve, reject) => {
		const client = new WsClient(url)
		client.once("message", (data) => resolve([String(data), client]))
		client.on("error", reject)
	})
}

describe("WS5: the Node server lifecycle", () => {
	// regression: WS5 (M)
	// v0: d32721a7fe
	// v0: 8a916c8d94
	it("shutdown closes open WebSockets with 1001 and does not wait on idle keep-alive clients", async () => {
		const app = honey<{}>()
		ws(app, "/ws").handler({ onOpen: (_ctx, socket) => socket.send("ready") })
		app.get("/x").handler((ctx) => ctx.res.text("ok", "x"))
		const server = serveNode(app, { env: {}, hostname: "127.0.0.1", port: 0 })
		await new Promise((resolve) => server.once("listening", resolve))
		const { port } = server.address() as AddressInfo
		const agent = new Agent({ keepAlive: true })
		await new Promise<void>((resolve) => {
			get({ agent, host: "127.0.0.1", path: "/x", port }, (res) => {
				res.resume()
				res.on("end", resolve)
			})
		})
		const [, client] = await firstMessage(`ws://127.0.0.1:${port}/ws`)
		const closed = new Promise<number>((resolve) => client.on("close", resolve))
		const start = Date.now()
		await server.shutdown(5_000)
		const elapsed = Date.now() - start
		agent.destroy()
		expect([await closed, elapsed < 1_500]).toEqual([1001, true])
	})

	// regression: WS5 (M)
	// v0: c04f791e79
	// v0: 7216697725
	it("serve(app) keeps the ws adapter the app was given instead of replacing it", async () => {
		const base = nodeWebSocket()
		let used = 0
		const mine: WSAdapter = {
			...base,
			upgrade: (...args) => {
				used++
				return base.upgrade(...args)
			},
		}
		const app = honey<{}>().wsAdapter(mine)
		ws(app, "/ws").handler({ onOpen: (_ctx, socket) => socket.send("ready") })
		const handle = await serve(app, { hostname: "127.0.0.1", port: 0 })
		try {
			const [message, client] = await firstMessage(`${handle.url.replace("http", "ws")}/ws`)
			client.terminate()
			expect([message, used]).toEqual(["ready", 1])
		} finally {
			await handle.close(100)
		}
	})
})

describe("WS5: the package", () => {
	// regression: WS5 (M)
	// v0: 1f64fe1dc3
	it("`ws` is declared as an optional peer dependency", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
			peerDependencies?: Record<string, string>
			peerDependenciesMeta?: Record<string, { optional?: boolean }>
		}
		expect([pkg.peerDependencies?.ws, pkg.peerDependenciesMeta?.ws]).toEqual([expect.any(String), { optional: true }])
	})
})
