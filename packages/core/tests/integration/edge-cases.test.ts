import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { csrf } from "../../src/csrf.ts"
import { etag } from "../../src/etag.ts"
import { createMiddleware, honey } from "../../src/index.ts"
import { ipRestrict } from "../../src/ip-restrict.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { timeout } from "../../src/timeout.ts"

function request(
	port: number,
	path: string,
	opts?: {
		body?: string
		headers?: Record<string, string>
		method?: string
	},
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

let server: HoneyServer | null = null

afterEach(() => {
	if (server) {
		server.close()
		server = null
	}
})

describe("edge: CSRF with PUT/PATCH/DELETE", () => {
	it("PUT with form content-type from cross-origin → 403", async () => {
		const app = honey<{}>().use(csrf())
		app.put("/resource").handler((ctx) => ctx.res.json("ok", { updated: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/resource", {
			body: "data=x",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"sec-fetch-site": "cross-site",
			},
			method: "PUT",
		})
		expect(res.status).toBe(403)
	})

	it("PATCH with form content-type from cross-origin → 403", async () => {
		const app = honey<{}>().use(csrf())
		app.patch("/resource").handler((ctx) => ctx.res.json("ok", { patched: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/resource", {
			body: "data=x",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"sec-fetch-site": "cross-site",
			},
			method: "PATCH",
		})
		expect(res.status).toBe(403)
	})

	it("DELETE with form content-type from cross-origin → 403", async () => {
		const app = honey<{}>().use(csrf())
		app.delete("/resource").handler((ctx) => ctx.res.json("ok", { deleted: true }))

		/* use app.fetch() directly — Node HTTP parser rejects DELETE with chunked body */
		const res = await app.fetch(
			new Request("http://localhost/resource", {
				body: "data=x",
				headers: {
					"content-type": "application/x-www-form-urlencoded",
					"sec-fetch-site": "cross-site",
				},
				method: "DELETE",
			}),
			{},
		)
		expect(res.status).toBe(403)
	})
})

describe("edge: ETag on HEAD request", () => {
	it("HEAD gets same ETag as GET", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { items: [1, 2, 3] }))
		app.head("/data").handler((ctx) => ctx.res.json("ok", { items: [1, 2, 3] }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const getRes = await request(addr.port, "/data")
		const headRes = await request(addr.port, "/data", { method: "HEAD" })

		expect(getRes.headers.etag).toBeTruthy()
		expect(headRes.headers.etag).toBeTruthy()
		expect(headRes.headers.etag).toBe(getRes.headers.etag)
	})
})

describe("edge: ETag If-None-Match with multiple values", () => {
	it("If-None-Match with comma-separated list matches", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { stable: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const first = await request(addr.port, "/data")
		const etagVal = first.headers.etag as string

		const res = await request(addr.port, "/data", {
			headers: { "if-none-match": `"stale", ${etagVal}, "other"` },
		})
		expect(res.status).toBe(304)
	})
})

describe("edge: body-limit with malformed Content-Length", () => {
	it("Content-Length: NaN → falls through to slow path", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 100 }))
		app.post("/echo").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.text("ok", body)
		})

		/* use app.fetch() directly — Node HTTP parser rejects invalid Content-Length at socket level */
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "small",
				headers: { "content-length": "not-a-number" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("small")
	})

	it("Content-Length: -5 → falls through to slow path", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 100 }))
		app.post("/echo").handler(async (ctx) => {
			const body = await ctx.req.text()
			return ctx.res.text("ok", body)
		})

		/* use app.fetch() directly — Node HTTP parser rejects invalid Content-Length at socket level */
		const res = await app.fetch(
			new Request("http://localhost/echo", {
				body: "small",
				headers: { "content-length": "-5" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})

describe("edge: CORS with port in Origin", () => {
	it("Origin with port must match exactly", async () => {
		const app = honey<{}>().use(cors({ origin: "http://example.com:3000" }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const match = await request(addr.port, "/api", {
			headers: { origin: "http://example.com:3000" },
		})
		expect(match.headers["access-control-allow-origin"]).toBe("http://example.com:3000")

		const noMatch = await request(addr.port, "/api", {
			headers: { origin: "http://example.com" },
		})
		expect(noMatch.headers["access-control-allow-origin"]).toBeUndefined()
	})
})

describe("edge: chain middleware throwing during 404", () => {
	it("middleware error during 404 → 500, server stays alive", async () => {
		let shouldThrow = false
		const conditionalMw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			if (shouldThrow) throw new Error("middleware boom")
			return res
		})
		const app = honey<{}>().use(conditionalMw)
		app.get("/exists").handler((ctx) => ctx.res.text("ok", "ok"))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* first: trigger error during 404 chain */
		shouldThrow = true
		const res = await request(addr.port, "/nonexistent")
		expect(res.status).toBe(500)

		/* server still alive — normal request works */
		shouldThrow = false
		const res2 = await request(addr.port, "/exists")
		expect(res2.status).toBe(200)
	})
})

describe("edge: timeout = 0", () => {
	it("timeout 0 with sync handler → handler wins race", async () => {
		const app = honey<{}>().use(timeout({ duration: 0 }))
		app.get("/test").handler((ctx) => ctx.res.text("ok", "ok"))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* sync handler completes before setTimeout(0) fires */
		const res = await request(addr.port, "/test")
		expect(res.status).toBe(200)
	})

	it("timeout 0 with async handler → 504", async () => {
		const app = honey<{}>().use(timeout({ duration: 0 }))
		app.get("/test").handler(async (ctx) => {
			await new Promise((r) => setTimeout(r, 10))
			return ctx.res.text("ok", "ok")
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/test")
		expect(res.status).toBe(504)
	})
})

describe("edge: handler returning undefined", () => {
	it("handler without return → 500 not crash", async () => {
		const app = honey<{}>()
		app.get("/bad").handler(((ctx: unknown) => {
			;(ctx as { res: { json: (s: string, b: unknown) => unknown } }).res.json("ok", { x: 1 })
			/* missing return — returns undefined */
		}) as never)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/bad")
		expect(res.status).toBe(500)
	})
})

describe("edge: IPv6 in X-Forwarded-For with brackets", () => {
	it("bracketed IPv6 [::1] matches allowList ::1", async () => {
		const app = honey<{}>().use(ipRestrict({ allowList: ["::1"], trustProxy: true }))
		app.get("/admin").handler((ctx) => ctx.res.json("ok", { ok: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/admin", {
			headers: { "x-forwarded-for": "[::1], 10.0.0.1" },
		})
		expect(res.status).toBe(200)
	})
})

describe("edge: cookie maxAge validation", () => {
	it("maxAge NaN → throws", () => {
		const app = honey<{}>()
		app
			.get("/cookie")
			.handler((ctx) => ctx.res.json("ok", {}, { cookies: { s: { maxAge: NaN, value: "x" } } }))

		expect(app.fetch(new Request("http://localhost/cookie"), {})).resolves.toHaveProperty(
			"status",
			500,
		)
	})

	it("maxAge Infinity → throws", () => {
		const app = honey<{}>()
		app
			.get("/cookie")
			.handler((ctx) =>
				ctx.res.json("ok", {}, { cookies: { s: { maxAge: Infinity, value: "x" } } }),
			)

		expect(app.fetch(new Request("http://localhost/cookie"), {})).resolves.toHaveProperty(
			"status",
			500,
		)
	})

	it("maxAge negative → throws", () => {
		const app = honey<{}>()
		app
			.get("/cookie")
			.handler((ctx) => ctx.res.json("ok", {}, { cookies: { s: { maxAge: -1, value: "x" } } }))

		expect(app.fetch(new Request("http://localhost/cookie"), {})).resolves.toHaveProperty(
			"status",
			500,
		)
	})

	it("maxAge 0 → valid (immediate expiry)", () => {
		const app = honey<{}>()
		app
			.get("/cookie")
			.handler((ctx) => ctx.res.json("ok", {}, { cookies: { s: { maxAge: 0, value: "x" } } }))

		expect(app.fetch(new Request("http://localhost/cookie"), {})).resolves.toHaveProperty(
			"status",
			200,
		)
	})
})

describe("edge: middleware next() reserved key protection", () => {
	it("next({ req: ... }) does NOT overwrite ctx.req", async () => {
		const evilMw = createMiddleware(async (_ctx, next) => {
			return next({ req: "overwritten" })
		})
		const app = honey<{}>().use(evilMw)
		app.get("/test").handler((ctx) =>
			ctx.res.json("ok", {
				isRequest: (ctx as unknown as { req: unknown }).req instanceof Request,
				type: typeof (ctx as unknown as { req: unknown }).req,
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/test")
		expect(res.status).toBe(200)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.isRequest).toBe(true)
	})

	it("next({ env: ... }) does NOT overwrite ctx.env", async () => {
		const evilMw = createMiddleware(async (_ctx, next) => {
			return next({ env: "overwritten" })
		})
		const app = honey<{ SECRET: string }>().use(evilMw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { type: typeof ctx.env }))
		server = serve(app, { env: { SECRET: "s" }, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/test")
		expect(res.status).toBe(200)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.type).toBe("object")
	})

	it("next({ db: ... }) still works (non-reserved key)", async () => {
		const dbMw = createMiddleware(async (_ctx, next) => {
			return next({ db: "postgres" })
		})
		const app = honey<{}>().use(dbMw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { db: ctx.db }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/test")
		expect(res.status).toBe(200)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.db).toBe("postgres")
	})
})

describe("edge: SSE retry validation", () => {
	it("negative retry → retry line not emitted", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "x", event: "msg", retry: -1000 })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.body).not.toContain("retry:")
	})

	it("NaN retry → retry line not emitted", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "x", event: "msg", retry: NaN })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.body).not.toContain("retry:")
	})

	it("valid retry → retry line emitted", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "x", event: "msg", retry: 5000 })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.body).toContain("retry: 5000")
	})
})

describe("edge: frozen middleware additions with reserved key", () => {
	it("frozen additions with reserved key → request still succeeds", async () => {
		const frozenMw = createMiddleware(async (_ctx, next) => {
			return next(Object.freeze({ db: "pg", req: "evil" }))
		})
		const app = honey<{}>().use(frozenMw)
		app.get("/test").handler((ctx) => ctx.res.json("ok", { db: ctx.db }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/test")
		expect(res.status).toBe(200)
		expect((JSON.parse(res.body) as Record<string, unknown>).db).toBe("pg")
	})
})

describe("edge: ETag not set on error responses", () => {
	it("404 → no ETag header", async () => {
		const app = honey<{}>().use(etag())
		app.get("/exists").handler((ctx) => ctx.res.json("ok", { ok: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/missing")
		expect(res.status).toBe(404)
		expect(res.headers.etag).toBeUndefined()
	})

	it("200 → ETag present", async () => {
		const app = honey<{}>().use(etag())
		app.get("/ok").handler((ctx) => ctx.res.json("ok", { ok: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/ok")
		expect(res.status).toBe(200)
		expect(res.headers.etag).toBeTruthy()
	})
})

describe("edge: error vars in response body", () => {
	it("HoneyError vars included in JSON error response", async () => {
		const { HoneyError } = await import("../../src/error.ts")
		const app = honey<{}>()
		app.get("/fail").handler(() => {
			throw new HoneyError({
				errorKey: "custom_err",
				status: "bad_request",
				vars: { detail: "something specific" },
			})
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/fail")
		expect(res.status).toBe(400)
		const body = JSON.parse(res.body) as Record<string, unknown>
		expect(body.error_key).toBe("custom_err")
		expect(body.vars).toBeDefined()
		expect((body.vars as Record<string, unknown>).detail).toBe("something specific")
	})
})

describe("edge: chain middleware on sub-routes via .route()", () => {
	it("CSRF applies to sub-routes", async () => {
		const sub = honey<{}>()
		sub.post("/action").handler((ctx) => ctx.res.json("ok", { done: true }))

		const app = honey<{}>().use(csrf())
		app.route(sub)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/action", {
			body: "x=1",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				"sec-fetch-site": "cross-site",
			},
			method: "POST",
		})
		expect(res.status).toBe(403)
	})

	it("chain middleware runs on sub-route", async () => {
		const { requestId: rid } = await import("../../src/request-id.ts")
		const sub = honey<{}>().use(rid())
		sub.get("/sub").handler((ctx) => ctx.res.json("ok", { id: ctx.requestId }))

		const app = honey<{}>().use(rid())
		app.route(sub)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/sub")
		expect(res.status).toBe(200)
		expect(res.headers["x-request-id"]).toBeTruthy()
	})
})

describe("edge: server resilience after errors", () => {
	it("server handles 10 error requests then 1 success", async () => {
		const app = honey<{}>()
		app.get("/crash").handler(() => {
			throw new Error("boom")
		})
		app.get("/ok").handler((ctx) => ctx.res.text("ok", "alive"))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		for (let i = 0; i < 10; i++) {
			const res = await request(addr.port, "/crash")
			expect(res.status).toBe(500)
		}

		const res = await request(addr.port, "/ok")
		expect(res.status).toBe(200)
		expect(res.body).toBe("alive")
	})
})
