import http from "node:http"
import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { serve } from "../../../src/node.ts"

function makeApp() {
	const h = honey<{}>()
	h.get("/health").handler((ctx) => ctx.res.json("ok", { status: "healthy" }))
	h.post("/echo").handler(async (ctx) => {
		const body = await ctx.req.text()
		return ctx.res.text("ok", body)
	})
	return h
}

async function fetchFromServer(
	port: number,
	path: string,
	opts?: { body?: string; headers?: Record<string, string>; method?: string },
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

describe("serve", () => {
	it("starts server on specified port", async () => {
		const app = makeApp()
		const server = serve(app, { env: {}, port: 0 })
		const addr = server.address()
		expect(addr).toBeTruthy()
		server.close()
	})

	it("request → correct status, headers, body", async () => {
		const app = makeApp()
		const server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await fetchFromServer(addr.port, "/health")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toContain("application/json")
		expect(JSON.parse(res.body)).toEqual({ status: "healthy" })

		server.close()
	})

	it("POST body delivered", async () => {
		const app = makeApp()
		const server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await fetchFromServer(addr.port, "/echo", {
			body: "hello world",
			method: "POST",
		})
		expect(res.status).toBe(200)
		expect(res.body).toBe("hello world")

		server.close()
	})

	it("404 for unknown path", async () => {
		const app = makeApp()
		const server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await fetchFromServer(addr.port, "/missing")
		expect(res.status).toBe(404)

		server.close()
	})

	it("close stops server", async () => {
		const app = makeApp()
		const server = serve(app, { env: {}, port: 0 })
		server.close()

		await new Promise<void>((resolve) => {
			server.on("close", resolve)
		})
	})

	it("streaming response completes without data loss", async () => {
		const h = honey<{}>()
		const chunkCount = 100
		const chunkSize = 1024
		h.get("/stream").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				const chunk = new Uint8Array(chunkSize).fill(65)
				for (let i = 0; i < chunkCount; i++) {
					await writer.write(chunk)
				}
				await writer.close()
			}),
		)
		const server = serve(h, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await fetchFromServer(addr.port, "/stream")
		expect(res.status).toBe(200)
		expect(res.body.length).toBe(chunkCount * chunkSize)

		server.close()
	})

	it("response write respects backpressure", async () => {
		const h = honey<{}>()
		h.get("/bp").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				const chunk = new Uint8Array(64 * 1024).fill(66)
				for (let i = 0; i < 20; i++) {
					await writer.write(chunk)
				}
				await writer.close()
			}),
		)
		const server = serve(h, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* slow client: read with pauses */
		const result = await new Promise<string>((resolve, reject) => {
			const req = http.request({ hostname: "127.0.0.1", method: "GET", path: "/bp", port: addr.port }, (res) => {
				let data = ""
				res.on("data", (chunk) => {
					data += chunk
					/* simulate slow client by pausing briefly */
					res.pause()
					setTimeout(() => res.resume(), 1)
				})
				res.on("end", () => resolve(data))
			})
			req.on("error", reject)
			req.end()
		})

		expect(result.length).toBe(20 * 64 * 1024)
		server.close()
	})

	it("JSON response with content-length is fully written", async () => {
		const app = makeApp()
		const server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await fetchFromServer(addr.port, "/health")
		expect(res.status).toBe(200)
		expect(res.headers["content-length"]).toBe(String(Buffer.byteLength(res.body)))
		expect(JSON.parse(res.body)).toEqual({ status: "healthy" })

		server.close()
	})

	it("env passed through to handler", async () => {
		type Env = { SECRET: string }
		const h = honey<Env>()
		h.get("/env").handler((ctx) => {
			return ctx.res.text("ok", ctx.env.SECRET)
		})
		const server = serve(h, { env: { SECRET: "s3cr3t" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await fetchFromServer(addr.port, "/env")
		expect(res.body).toBe("s3cr3t")

		server.close()
	})
})
