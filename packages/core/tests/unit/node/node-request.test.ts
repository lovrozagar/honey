import http from "node:http"
import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { serve } from "../../../src/node.ts"
import { bodyLimit } from "../../../src/body-limit.ts"
import { incomingToNodeRequest, NodeRequest } from "../../../src/node-request.ts"

function fetchFromServer(
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

describe("NodeRequest", () => {
	it("is Request-shaped without being constructed as one", () => {
		const incoming = {
			headers: { host: "localhost" },
			method: "GET",
			rawHeaders: ["Host", "localhost"],
			url: "/json",
		} as unknown as http.IncomingMessage
		const req = incomingToNodeRequest(incoming)
		expect(req instanceof Request).toBe(true)
		expect(Object.getPrototypeOf(req) === Request.prototype).toBe(false)
		expect(req).toBeInstanceOf(NodeRequest)
		expect(req.method).toBe("GET")
		expect(req.url).toBe("http://localhost/json")
		expect(req.headers.get("host")).toBe("localhost")
		expect(req.body).toBeNull()
	})

	it("GET json and POST body still work through serve()", async () => {
		const app = honey<{}>()
		app.get("/json").handler((ctx) => ctx.res.json("ok", { message: "Hello, World!" }))
		app.post("/echo").handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
		const server = serve(app, { env: {}, port: 0 })
		const port = (server.address() as { port: number }).port

		const get = await fetchFromServer(port, "/json")
		expect(get.status).toBe(200)
		expect(JSON.parse(get.body)).toEqual({ message: "Hello, World!" })

		const post = await fetchFromServer(port, "/echo", { body: "hello", method: "POST" })
		expect(post.status).toBe(200)
		expect(post.body).toBe("hello")

		server.close()
	})

	it("bodyLimit can wrap a POST body without new Request(NodeRequest)", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 1024 }))
		app.post("/echo").handler(async (ctx) => ctx.res.text("ok", await ctx.req.text()))
		const server = serve(app, { env: {}, port: 0 })
		const port = (server.address() as { port: number }).port

		const post = await fetchFromServer(port, "/echo", {
			body: "hello",
			headers: { "content-type": "text/plain" },
			method: "POST",
		})
		expect(post.status).toBe(200)
		expect(post.body).toBe("hello")

		const tooBig = await fetchFromServer(port, "/echo", {
			body: "x".repeat(2000),
			headers: { "content-length": "2000", "content-type": "text/plain" },
			method: "POST",
		})
		expect(tooBig.status).toBe(413)

		server.close()
	})
})
