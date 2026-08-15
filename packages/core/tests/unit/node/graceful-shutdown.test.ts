import http from "node:http"
import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { serve } from "../../../src/node.ts"

function makeSlowApp() {
	const h = honey<{}>()
	h.get("/slow").handler(async (ctx) => {
		await new Promise((r) => setTimeout(r, 200))
		return ctx.res.text("ok", "done")
	})
	h.get("/fast").handler((ctx) => ctx.res.text("ok", "ok"))
	return h
}

function fetchFromServer(port: number, path: string): Promise<{ body: string; status: number }> {
	return new Promise((resolve, reject) => {
		const req = http.request({ hostname: "127.0.0.1", method: "GET", path, port }, (res) => {
			let data = ""
			res.on("data", (chunk) => {
				data += chunk
			})
			res.on("end", () => {
				resolve({ body: data, status: res.statusCode ?? 0 })
			})
		})
		req.on("error", reject)
		req.end()
	})
}

describe("graceful shutdown", () => {
	it("shutdown() returns a promise", async () => {
		const app = makeSlowApp()
		const server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }
		expect(addr).toBeTruthy()

		const result = server.shutdown()
		expect(result).toBeInstanceOf(Promise)
		await result
	})

	it("shutdown() waits for in-flight requests before closing", async () => {
		const app = makeSlowApp()
		const server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* start a slow request */
		const pending = fetchFromServer(addr.port, "/slow")

		/* small delay to ensure request is in-flight */
		await new Promise((r) => setTimeout(r, 20))

		/* initiate shutdown while request is in-flight */
		const shutdownPromise = server.shutdown()

		/* the in-flight request should complete successfully */
		const res = await pending
		expect(res.status).toBe(200)
		expect(res.body).toBe("done")

		await shutdownPromise
	})

	it("shutdown() rejects new connections after being called", async () => {
		const app = makeSlowApp()
		const server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const shutdownPromise = server.shutdown()

		/* new request after shutdown should fail */
		await expect(fetchFromServer(addr.port, "/fast")).rejects.toThrow()

		await shutdownPromise
	})

	it("shutdown(timeout) force-closes within timeout period", async () => {
		const app = makeSlowApp()
		const server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* start slow request (takes 200ms) */
		const pending = fetchFromServer(addr.port, "/slow")

		await new Promise((r) => setTimeout(r, 20))

		/* shutdown with 50ms timeout — shorter than the 200ms request */
		const start = Date.now()
		await server.shutdown(50)
		const elapsed = Date.now() - start

		/* should have force-closed in ~50ms, not waited 200ms */
		expect(elapsed).toBeLessThan(150)

		/*
		 * After force-close, the pending request either rejects (socket destroyed)
		 * or resolves with partial/error data — either is acceptable.
		 * The important behavior is the timeout being respected.
		 */
		await pending.catch(() => {})
	})
})
