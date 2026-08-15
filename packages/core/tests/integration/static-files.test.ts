import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { honey } from "../../src/index.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { staticFiles } from "../../src/static.ts"

/** in-memory file system for testing — simulates runtime-specific resolve */
const FILES: Record<string, { body: string; type: string }> = {
	"/index.html": { body: "<h1>hello</h1>", type: "text/html" },
	"/css/style.css": { body: "body{}", type: "text/css" },
	"/js/app.js": { body: "console.log(1)", type: "application/javascript" },
	"/img/logo.png": { body: "PNG_DATA", type: "image/png" },
}

function memResolve(_ctx: unknown, path: string): Response | null {
	const file = FILES[path]
	if (!file) return null
	return new Response(file.body, {
		headers: { "content-type": file.type },
	})
}

function request(
	port: number,
	path: string,
	opts?: { headers?: Record<string, string>; method?: string },
): Promise<{
	body: string
	headers: http.IncomingHttpHeaders
	status: number
}> {
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
					resolve({
						body: data,
						headers: res.headers,
						status: res.statusCode ?? 0,
					})
				})
			},
		)
		req.on("error", reject)
		req.end()
	})
}

let server: HoneyServer | null = null

afterEach(() => {
	if (server) {
		server.close()
		server = null
	}
})

describe("integration: staticFiles with real HTTP server", () => {
	it("serves static file and falls through to routes", async () => {
		const app = honey<{}>().use(staticFiles({ resolve: memResolve }))

		app.get("/api/health").handler((ctx) => ctx.res.json("ok", { up: true }))

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* static file served */
		const css = await request(addr.port, "/css/style.css")
		expect(css.status).toBe(200)
		expect(css.body).toBe("body{}")
		expect(css.headers["content-type"]).toBe("text/css")

		/* API route still works (fallthrough) */
		const api = await request(addr.port, "/api/health")
		expect(api.status).toBe(200)
		expect(JSON.parse(api.body)).toEqual({ up: true })
	})

	it("prefix scopes static serving", async () => {
		const app = honey<{}>().use(
			staticFiles({
				prefix: "/assets",
				resolve: memResolve,
			}),
		)

		app.get("/api/data").handler((ctx) => ctx.res.text("ok", "api"))

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* /assets/css/style.css → resolve receives /css/style.css */
		const res = await request(addr.port, "/assets/css/style.css")
		expect(res.status).toBe(200)
		expect(res.body).toBe("body{}")

		/* /css/style.css without prefix → fallthrough (404 or route) */
		const miss = await request(addr.port, "/css/style.css")
		expect(miss.status).toBe(404)
	})

	it("applies cache headers from config", async () => {
		const app = honey<{}>().use(
			staticFiles({
				headers: { "cache-control": "public, max-age=31536000, immutable" },
				resolve: memResolve,
			}),
		)

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/js/app.js")
		expect(res.status).toBe(200)
		expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable")
		expect(res.body).toBe("console.log(1)")
	})

	it("HEAD returns headers without body", async () => {
		const app = honey<{}>().use(staticFiles({ resolve: memResolve }))

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/index.html", { method: "HEAD" })
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/html")
	})

	it("POST passes through to routes", async () => {
		const app = honey<{}>().use(staticFiles({ resolve: memResolve }))

		app.post("/index.html").handler((ctx) => ctx.res.text("ok", "posted"))

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/index.html", { method: "POST" })
		expect(res.status).toBe(200)
		expect(res.body).toBe("posted")
	})

	it("missing file falls through to 404", async () => {
		const app = honey<{}>().use(staticFiles({ resolve: memResolve }))

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/not-found.txt")
		expect(res.status).toBe(404)
	})

	it("rewritePath transforms before resolve", async () => {
		const app = honey<{}>().use(
			staticFiles({
				prefix: "/v1",
				resolve: memResolve,
				rewritePath: (p) => p.replace("/static", ""),
			}),
		)

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* /v1/static/js/app.js → strip prefix → /static/js/app.js → rewrite → /js/app.js */
		const res = await request(addr.port, "/v1/static/js/app.js")
		expect(res.status).toBe(200)
		expect(res.body).toBe("console.log(1)")
	})

	it("simulates CF Workers env.ASSETS pattern", async () => {
		type Env = {
			ASSETS: { fetch: (req: Request) => Promise<Response | null> }
		}

		const mockAssets = {
			fetch: async (req: Request) => {
				const url = new URL(req.url)
				return memResolve(null, url.pathname)
			},
		}

		const app = honey<Env>().use(
			staticFiles<{ env: Env; req: Request }>({
				resolve: async (ctx, path) => {
					const res = await ctx.env.ASSETS.fetch(new Request(`https://a${path}`))
					return res
				},
			}),
		)

		app.get("/api/ping").handler((ctx) => ctx.res.text("ok", "pong"))

		server = serve(app, { env: { ASSETS: mockAssets }, port: 0 })
		const addr = server.address() as { port: number }

		const html = await request(addr.port, "/index.html")
		expect(html.status).toBe(200)
		expect(html.body).toBe("<h1>hello</h1>")

		const api = await request(addr.port, "/api/ping")
		expect(api.status).toBe(200)
		expect(api.body).toBe("pong")
	})

	it("simulates Node fs-based resolve with MIME lookup", async () => {
		const MIME: Record<string, string> = {
			".css": "text/css",
			".html": "text/html",
			".js": "application/javascript",
			".png": "image/png",
		}

		function lookupMime(path: string): string {
			const dot = path.lastIndexOf(".")
			if (dot === -1) return "application/octet-stream"
			return MIME[path.substring(dot)] ?? "application/octet-stream"
		}

		const app = honey<{}>().use(
			staticFiles({
				prefix: "/public",
				resolve: (_ctx, path) => {
					const file = FILES[path]
					if (!file) return null
					return new Response(file.body, {
						headers: { "content-type": lookupMime(path) },
					})
				},
			}),
		)

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const js = await request(addr.port, "/public/js/app.js")
		expect(js.status).toBe(200)
		expect(js.headers["content-type"]).toBe("application/javascript")

		const css = await request(addr.port, "/public/css/style.css")
		expect(css.status).toBe(200)
		expect(css.headers["content-type"]).toBe("text/css")
	})

	it("headers function receives filePath for per-file cache policy", async () => {
		const app = honey<{}>().use(
			staticFiles({
				headers: (filePath) => {
					if (filePath.startsWith("/js/") || filePath.startsWith("/css/")) {
						return { "cache-control": "public, max-age=31536000, immutable" }
					}
					return { "cache-control": "no-cache" }
				},
				resolve: memResolve,
			}),
		)

		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const js = await request(addr.port, "/js/app.js")
		expect(js.headers["cache-control"]).toBe("public, max-age=31536000, immutable")

		const html = await request(addr.port, "/index.html")
		expect(html.headers["cache-control"]).toBe("no-cache")
	})
})
