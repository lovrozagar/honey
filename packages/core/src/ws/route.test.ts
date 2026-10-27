import { describe, expect, it } from "vitest"
import { createMiddleware } from "../middleware/middleware.ts"
import { honey } from "../routing/app.ts"
import type { WSAdapter } from "./contract.ts"
import { ws } from "./route.ts"

/** An adapter that answers every upgrade with a 101 and records the path it upgraded. */
function recordingAdapter() {
	const paths: string[] = []
	const adapter: WSAdapter = {
		upgrade(req) {
			paths.push(new URL(req.url).pathname)
			const response = new Response(null, { headers: { upgrade: "websocket" } })
			Object.defineProperty(response, "status", { value: 101 })
			return { response, socket: { close: () => {}, raw: null, readyState: 1, send: () => {} } }
		},
	}
	return { adapter, paths }
}

const handshake = (path: string) =>
	new Request(`https://app.example.com${path}`, {
		headers: { connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", upgrade: "websocket" },
	})

describe("ws(app, path)", () => {
	it("registers on the handle's app under its base path, behind its chain and the app's scopes, and hands the handle back", async () => {
		const { adapter, paths } = recordingAdapter()
		const ran: string[] = []
		const step = (name: string) =>
			createMiddleware((_ctx, next) => {
				ran.push(name)
				return next()
			})
		const app = honey<{}>().wsAdapter(adapter)
		app.use("/v1/rooms", step("scoped"))
		const v1 = app.basePath("/v1").use(step("chain"))
		expect(ws(v1, "/rooms/:id").handler({})).toBe(v1)
		const upgraded = (await app.fetch(handshake("/v1/rooms/7"), {})).status
		const before = [...ran]
		const unprefixed = (await app.fetch(handshake("/rooms/7"), {})).status
		expect([upgraded, before, unprefixed, paths, Object.keys(app.toRouteTree().routes)]).toEqual([
			101,
			["chain", "scoped"],
			404,
			["/v1/rooms/7"],
			["WS /v1/rooms/:id"],
		])
	})
})
