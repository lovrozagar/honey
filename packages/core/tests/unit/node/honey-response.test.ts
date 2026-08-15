import http from "node:http"
import { describe, expect, it } from "vitest"
import { cors } from "../../../src/cors.ts"
import { etag } from "../../../src/etag.ts"
import { HoneyResponse, isHoneyResponse } from "../../../src/honey-response.ts"
import { createMiddleware, honey } from "../../../src/index.ts"
import { serve } from "../../../src/node.ts"
import { HoneyRes } from "../../../src/response.ts"

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

describe("HoneyResponse", () => {
	it("json/text skip native Response when nodeOut is set", async () => {
		const res = new HoneyRes(true)
		const json = res.json("ok", { message: "Hello, World!" })
		expect(isHoneyResponse(json)).toBe(true)
		expect(Object.getPrototypeOf(json) === Response.prototype).toBe(false)
		expect(json.status).toBe(200)
		expect(json.headers.get("content-type")).toBe("application/json")
		expect(await json.json()).toEqual({ message: "Hello, World!" })

		const text = res.text("created", "hi")
		expect(isHoneyResponse(text)).toBe(true)
		expect(text.status).toBe(201)
		expect(await text.text()).toBe("hi")
	})

	it("fetch() still returns a native Response", async () => {
		const app = honey<{}>()
		app.get("/json").handler((ctx) => ctx.res.json("ok", { message: "Hello, World!" }))
		const response = await app.fetch(new Request("http://localhost/json"), {})
		expect(response).toBeInstanceOf(Response)
		expect(isHoneyResponse(response)).toBe(false)
		expect(await response.json()).toEqual({ message: "Hello, World!" })
	})

	it("serve() writes json/text/empty without a Fetch Response", async () => {
		const seen: unknown[] = []
		const app = honey<{}>().use(
			createMiddleware(async (_ctx, next) => {
				const response = await next()
				seen.push(response)
				return response
			}),
		)
		app.get("/json").handler((ctx) => ctx.res.json("ok", { message: "Hello, World!" }))
		app.get("/text").handler((ctx) => ctx.res.text("ok", "plain"))
		app.get("/empty").handler((ctx) => ctx.res.noContent())
		app.get("/cookie").handler((ctx) =>
			ctx.res.json("ok", { ok: true }, { cookies: { sid: { httpOnly: true, value: "abc" } } }),
		)
		const server = serve(app, { env: {}, port: 0 })
		const port = (server.address() as { port: number }).port

		const json = await fetchFromServer(port, "/json")
		expect(json.status).toBe(200)
		expect(json.headers["content-type"]).toBe("application/json")
		expect(JSON.parse(json.body)).toEqual({ message: "Hello, World!" })

		const text = await fetchFromServer(port, "/text")
		expect(text.status).toBe(200)
		expect(text.body).toBe("plain")

		const empty = await fetchFromServer(port, "/empty")
		expect(empty.status).toBe(204)
		expect(empty.body).toBe("")

		const cookie = await fetchFromServer(port, "/cookie")
		expect(cookie.status).toBe(200)
		expect(String(cookie.headers["set-cookie"])).toContain("sid=abc")

		expect(seen.length).toBe(4)
		for (const response of seen) {
			expect(response).toBeInstanceOf(HoneyResponse)
		}

		server.close()
	})

	it("cors + etag keep the Node bag", async () => {
		const app = honey<{}>().use(cors({ origin: "http://allowed.com" })).use(etag())
		app.get("/json").handler((ctx) => ctx.res.json("ok", { message: "Hello, World!" }))
		const server = serve(app, { env: {}, port: 0 })
		const port = (server.address() as { port: number }).port

		const first = await fetchFromServer(port, "/json", { headers: { origin: "http://allowed.com" } })
		expect(first.status).toBe(200)
		expect(first.headers["access-control-allow-origin"]).toBe("http://allowed.com")
		expect(first.headers.etag).toBeTruthy()
		expect(JSON.parse(first.body)).toEqual({ message: "Hello, World!" })

		const second = await fetchFromServer(port, "/json", {
			headers: { "if-none-match": String(first.headers.etag), origin: "http://allowed.com" },
		})
		expect(second.status).toBe(304)
		expect(second.body).toBe("")

		server.close()
	})
})
