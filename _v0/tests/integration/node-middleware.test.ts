import { afterEach, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { curlLogger } from "../../src/curl-logger.ts"
import { honey } from "../../src/index.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { requestId } from "../../src/request-id.ts"
import { secureHeaders } from "../../src/secure-headers.ts"
import { nodeWebSocket } from "../../src/ws/node.ts"

/**
 * Middleware that broke only on Node: the adapter's Request view and response writer differ from
 * the native objects every other runtime hands the app. Each case runs through real `serve()`.
 */

let server: HoneyServer | null = null
afterEach(async () => {
	await server?.shutdown(200)
	server = null
})

async function listen(app: unknown): Promise<string> {
	server = serve(app as never, { env: {}, hostname: "127.0.0.1", port: 0 })
	await new Promise<void>((r) => server?.once("listening", () => r()))
	return `127.0.0.1:${(server.address() as { port: number }).port}`
}

describe("middleware on Node", () => {
	it("header middleware over an immutable Response (fetch(), Response.redirect())", async () => {
		const app = honey<{}>().use(secureHeaders()).use(requestId())
		app.get("/go").handler(() => Response.redirect("https://example.com/", 302))
		const host = await listen(app)
		const res = await fetch(`http://${host}/go`, { redirect: "manual" })
		expect(res.status).toBe(302)
		expect(res.headers.get("location")).toBe("https://example.com/")
		expect(res.headers.get("x-request-id")).not.toBeNull()
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
	})

	it("cors() in front of a WebSocket route lets the upgrade through", async () => {
		const app = honey<{}>()
			.wsAdapter(nodeWebSocket())
			.use(cors({ origin: "https://app.example" }))
		app.ws("/ws").handler({ onOpen: (_c, ws) => ws.send("hi") })
		const host = await listen(app)
		const message = await new Promise<string>((resolve, reject) => {
			const ws = new WebSocket(`ws://${host}/ws`, { headers: { origin: "https://app.example" } })
			ws.on("message", (d) => {
				resolve(String(d))
				ws.close()
			})
			ws.on("error", reject)
		})
		expect(message).toBe("hi")
	})

	it("curlLogger with bodies, in front of bodyLimit, on a POST", async () => {
		const lines: unknown[] = []
		const app = honey<{}>()
			.use(curlLogger({ body: true, log: (d) => lines.push(d) }))
			.use(bodyLimit({ maxSize: 1024 }))
		app.post("/echo").handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
		const host = await listen(app)
		const res = await fetch(`http://${host}/echo`, { body: "payload", method: "POST" })
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("payload")
		expect(lines).toHaveLength(1)
	})

	it("a handler-set Transfer-Encoding never reaches the wire next to Node's own framing", async () => {
		const app = honey<{}>()
		app.get("/te").handler(() => new Response("abc", { headers: { "transfer-encoding": "chunked" } }))
		const host = await listen(app)
		const res = await fetch(`http://${host}/te`)
		expect(await res.text()).toBe("abc")
	})
})
