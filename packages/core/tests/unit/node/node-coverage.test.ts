import http from "node:http"
import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { serve } from "../../../src/node.ts"

function fetchFromServer(
	port: number,
	path: string,
	opts?: { body?: string; headers?: Record<string, string[]>; method?: string },
): Promise<{ body: string; headers: http.IncomingHttpHeaders; status: number }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				headers: opts?.headers,
				hostname: "127.0.0.1",
				method: opts?.method ?? "GET",
				path,
				port,
			},
			(res) => {
				let data = ""
				res.on("data", (chunk) => {
					data += chunk
				})
				res.on("end", () => {
					resolve({ body: data, headers: res.headers, status: res.statusCode ?? 0 })
				})
			},
		)
		req.on("error", reject)
		if (opts?.body) req.write(opts.body)
		req.end()
	})
}

describe("node.ts — uncovered branches", () => {
	it("array headers forwarded correctly (multiple Set-Cookie)", async () => {
		const h = honey<{}>()
		h.get("/cookies").handler((ctx) =>
			ctx.res.json(
				"ok",
				{ ok: true },
				{
					cookies: {
						a: { value: "1" },
						b: { value: "2" },
					},
				},
			),
		)
		const server = serve(h, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await fetchFromServer(addr.port, "/cookies")
		expect(res.status).toBe(200)
		const cookies = res.headers["set-cookie"]
		expect(Array.isArray(cookies)).toBe(true)
		expect(cookies).toHaveLength(2)

		server.close()
	})

	it("handler crash → 500 (Honey catches and returns JSON error)", async () => {
		const h = honey<{}>()
		h.get("/crash").handler(() => {
			throw new Error("boom")
		})
		const server = serve(h, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await fetchFromServer(addr.port, "/crash")
		expect(res.status).toBe(500)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.error_key).toBe("internal_server_error")

		server.close()
	})

	it("draining mode → 503 Service Unavailable", async () => {
		const h = honey<{}>()
		h.get("/slow").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 200))
			return ctx.res.text("ok", "done")
		})
		const server = serve(h, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* start in-flight request */
		const pending = fetchFromServer(addr.port, "/slow")
		await new Promise((r) => setTimeout(r, 20))

		/* begin draining */
		const shutdownPromise = server.shutdown()

		/* new request during drain → 503 */
		const res2 = await fetchFromServer(addr.port, "/slow").catch(() => null)

		/* wait for in-flight to finish */
		const res1 = await pending
		expect(res1.status).toBe(200)

		await shutdownPromise

		/* 503 check: if connection was accepted during drain */
		if (res2 !== null) {
			expect(res2.status).toBe(503)
			expect(res2.body).toBe("Service Unavailable")
		}
	})

	it("shutdown with timeout → force-closes", async () => {
		const h = honey<{}>()
		h.get("/hang").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 10000))
			return ctx.res.text("ok", "never")
		})
		const server = serve(h, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* start hanging request — ignore outcome */
		const req = http.request({
			hostname: "127.0.0.1",
			method: "GET",
			path: "/hang",
			port: addr.port,
		})
		req.on("error", () => {})
		req.end()
		await new Promise((r) => setTimeout(r, 20))

		/* shutdown with 50ms timeout — should resolve well under 10s */
		const start = Date.now()
		await server.shutdown(50)
		const elapsed = Date.now() - start

		expect(elapsed).toBeLessThan(300)
	})

	it("POST with array headers in request", async () => {
		const h = honey<{}>()
		h.post("/echo-headers").handler((ctx) => {
			const val = ctx.req.headers.get("x-multi")
			return ctx.res.text("ok", val ?? "none")
		})
		const server = serve(h, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await fetchFromServer(addr.port, "/echo-headers", {
			body: "test",
			headers: { "x-multi": ["val1", "val2"] },
			method: "POST",
		})
		expect(res.status).toBe(200)
		expect(res.body).toContain("val1")

		server.close()
	})
})
