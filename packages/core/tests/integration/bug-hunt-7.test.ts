import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
import { serializeCookie } from "../../src/response.ts"
import { testClient } from "../../src/testing.ts"

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

/* ══════════════════════════════════════════════
 * 1. RESPONSE METHODS — binary, csv, html, xml, raw
 *
 * Zero test coverage for most non-JSON response methods.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: response method — binary", () => {
	it("binary response with Uint8Array body", async () => {
		const app = honey<{}>()
		app.get("/bin").handler((ctx) => {
			const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f])
			return ctx.res.binary("ok", data)
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/bin")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("application/octet-stream")
		expect(res.body).toBe("Hello")
	})
})

describe("bug-hunt-7: response method — csv", () => {
	it("csv response with proper content-type", async () => {
		const app = honey<{}>()
		app.get("/export").handler((ctx) => ctx.res.csv("ok", "name,age\nAlice,30\nBob,25"))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/export")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/csv; charset=utf-8")
		expect(res.body).toContain("Alice,30")
	})
})

describe("bug-hunt-7: response method — html", () => {
	it("html response with proper content-type", async () => {
		const app = honey<{}>()
		app.get("/page").handler((ctx) => ctx.res.html("ok", "<h1>Hello</h1>"))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/page")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("text/html; charset=utf-8")
		expect(res.body).toBe("<h1>Hello</h1>")
	})
})

describe("bug-hunt-7: response method — xml", () => {
	it("xml response with proper content-type", async () => {
		const app = honey<{}>()
		app.get("/data").handler((ctx) => ctx.res.xml("ok", "<root><item>1</item></root>"))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/data")
		expect(res.status).toBe(200)
		expect(res.headers["content-type"]).toBe("application/xml")
		expect(res.body).toContain("<item>1</item>")
	})
})

describe("bug-hunt-7: response method — raw", () => {
	it("raw wraps existing Response as TypedResponse", async () => {
		const app = honey<{}>()
		app.get("/raw").handler((ctx) =>
			ctx.res.raw(
				new Response("raw body", {
					headers: { "x-custom": "yes" },
					status: 418,
				}),
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/raw")
		expect(res.status).toBe(418)
		expect(res.headers["x-custom"]).toBe("yes")
		expect(res.body).toBe("raw body")
	})
})

describe("bug-hunt-7: response method — redirect", () => {
	it("redirect with default 302", async () => {
		const app = honey<{}>()
		app.get("/old").handler((ctx) => ctx.res.redirect("/new"))

		const res = await app.fetch(new Request("http://localhost/old"), {})
		expect(res.status).toBe(302)
		expect(res.headers.get("location")).toBe("/new")
	})

	it("redirect with custom 301 status", async () => {
		const app = honey<{}>()
		app.get("/old").handler((ctx) => ctx.res.redirect("/new", { status: 301 }))

		const res = await app.fetch(new Request("http://localhost/old"), {})
		expect(res.status).toBe(301)
		expect(res.headers.get("location")).toBe("/new")
	})

	it("redirect with cookies", async () => {
		const app = honey<{}>()
		app.get("/login").handler((ctx) =>
			ctx.res.redirect("/dashboard", {
				cookies: {
					session: { httpOnly: true, path: "/", value: "tok-abc" },
				},
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await new Promise<{ headers: http.IncomingHttpHeaders; status: number }>(
			(resolve, reject) => {
				const req = http.request(
					{ hostname: "127.0.0.1", method: "GET", path: "/login", port: addr.port },
					(r) => {
						resolve({ headers: r.headers, status: r.statusCode ?? 0 })
						r.resume()
					},
				)
				req.on("error", reject)
				req.end()
			},
		)
		expect(res.status).toBe(302)
		expect(res.headers.location).toBe("/dashboard")
		const cookies = res.headers["set-cookie"]
		expect(cookies).toBeTruthy()
		const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : String(cookies)
		expect(cookieStr).toContain("session=tok-abc")
	})
})

/* ══════════════════════════════════════════════
 * 2. COOKIE SIGN — value containing dots
 *
 * cookie-sign.ts:40 uses lastIndexOf(".") to split.
 * Value "a.b.c" signed becomes "a.b.c.<sig>".
 * verify must split on LAST dot to get "a.b.c" + sig.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: cookie-sign with dots in value", () => {
	it("value with dots → sign/verify round-trip works", async () => {
		const { sign, verify } = await import("../../src/cookie-sign.ts")
		const signed = await sign("user.id.12345", "secret")
		/* should have at least 3 dots: 2 in value + 1 before sig */
		expect(signed.split(".").length).toBeGreaterThanOrEqual(4)
		const value = await verify(signed, ["secret"])
		expect(value).toBe("user.id.12345")
	})

	it("value that is just a dot → works", async () => {
		const { sign, verify } = await import("../../src/cookie-sign.ts")
		const signed = await sign(".", "secret")
		const value = await verify(signed, ["secret"])
		expect(value).toBe(".")
	})
})

/* ══════════════════════════════════════════════
 * 3. COOKIE ENCODING — full range of special characters
 *
 * After fixing the emoji bug, verify CJK and other multi-byte.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: cookie value encoding — multi-byte", () => {
	it("CJK characters encoded correctly", () => {
		const cookie = serializeCookie("lang", { value: "日本語" })
		expect(cookie).toContain("lang=")
		/* should be percent-encoded, not raw CJK */
		expect(cookie).toContain("%")
		expect(cookie).not.toContain("日")
	})

	it("mixed ASCII + emoji", () => {
		const cookie = serializeCookie("mood", { value: "happy🎉" })
		expect(cookie).toContain("happy")
		expect(cookie).toContain("%")
	})

	it("empty value → no encoding needed", () => {
		const cookie = serializeCookie("empty", { value: "" })
		expect(cookie).toBe("empty=")
	})

	it("tab character encoded", () => {
		const cookie = serializeCookie("data", { value: "a\tb" })
		expect(cookie).toContain("%09")
	})
})

/* ══════════════════════════════════════════════
 * 4. SSE — carriage returns in data
 *
 * response.ts:150-153 — splits on \r\n|\r|\n.
 * Each variant should produce separate data: lines.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: SSE data line splitting", () => {
	it("data with \\r\\n → proper line split", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "line1\r\nline2", event: "msg" })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.body).toContain("data: line1\n")
		expect(res.body).toContain("data: line2\n")
	})

	it("data with bare \\r → proper line split", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "a\rb\rc", event: "msg" })
				stream.close()
			}),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/events")
		expect(res.body).toContain("data: a\n")
		expect(res.body).toContain("data: b\n")
		expect(res.body).toContain("data: c\n")
	})
})

/* ══════════════════════════════════════════════
 * 5. SSE — id with carriage return → throws
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: SSE id newline validation", () => {
	it("id with \\r → throws", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				try {
					await stream.send({ data: "x", event: "msg", id: "bad\rid" })
				} catch {
					/* expected */
				}
				stream.close()
			}),
		)

		const res = await app.fetch(new Request("http://localhost/events"), {})
		const body = await res.text()
		expect(body).not.toContain("bad\rid")
	})
})

/* ══════════════════════════════════════════════
 * 6. ACCEPTS — equal q-values → server preference wins
 *
 * accepts.ts:66-75 — iterates supported types in server order,
 * picks the one with highest q. With equal q, first supported wins.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: accepts — server preference ordering", () => {
	it("equal q-values → first supported type wins", async () => {
		const { accepts } = await import("../../src/accepts.ts")
		const req = new Request("http://localhost/", {
			headers: { accept: "text/html, application/json" },
		})
		/* server prefers json first */
		const result = accepts(req, ["application/json", "text/html"])
		expect(result).toBe("application/json")
	})

	it("higher q wins regardless of server order", async () => {
		const { accepts } = await import("../../src/accepts.ts")
		const req = new Request("http://localhost/", {
			headers: { accept: "text/html;q=1.0, application/json;q=0.5" },
		})
		/* server prefers json, but client strongly prefers html */
		const result = accepts(req, ["application/json", "text/html"])
		expect(result).toBe("text/html")
	})
})

/* ══════════════════════════════════════════════
 * 7. NODE ADAPTER — array headers (e.g. multiple set-cookie)
 *
 * node.ts:18-25 — array headers use append().
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: Node adapter — response with multiple headers of same type", () => {
	it("multiple Set-Cookie headers preserved through Node adapter", async () => {
		const app = honey<{}>()
		app.get("/cookies").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: {
						a: { path: "/", value: "1" },
						b: { path: "/", value: "2" },
						c: { path: "/", value: "3" },
					},
				},
			),
		)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/cookies")
		expect(res.status).toBe(200)
		const cookies = res.headers["set-cookie"]
		expect(cookies).toBeTruthy()
		const cookieArr = Array.isArray(cookies)
			? cookies
			: ([cookies as string | undefined].filter(Boolean) as string[])
		expect(cookieArr.length).toBe(3)
	})
})

/* ══════════════════════════════════════════════
 * 8. TESTCLIENT — HEAD and custom methods
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: testClient — all HTTP methods", () => {
	it("HEAD request via testClient", async () => {
		const app = honey<{}>()
		app.get("/data").handler((ctx) => ctx.res.json("ok", { big: "data" }))

		const client = testClient(app, { env: {} })
		const res = await client.head("/data")
		expect(res.status).toBe(200)
		/* HEAD should have empty body */
		const body = await res.text()
		expect(body).toBe("")
	})

	it("OPTIONS request via testClient", async () => {
		const app = honey<{}>()
		app.options("/api").handler((ctx) => ctx.res.noContent())

		const client = testClient(app, { env: {} })
		const res = await client.options("/api")
		expect(res.status).toBe(204)
	})

	it("custom method via testClient.request()", async () => {
		const app = honey<{}>()
		app.all("/resource").handler((ctx) => ctx.res.json("ok", { method: ctx.req.method }))

		const client = testClient(app, { env: {} })
		const res = await client.request("PATCH", "/resource", {
			json: { field: "updated" },
		})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.method).toBe("PATCH")
	})
})

/* ══════════════════════════════════════════════
 * 9. MIDDLEWARE CHAIN — route-level .use() stacks correctly
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: route-level middleware chaining", () => {
	it("multiple .use() on route → all execute in order", async () => {
		const order: string[] = []
		const mw1 = createMiddleware(async (_ctx, next) => {
			order.push("mw1")
			return next({ one: true })
		})
		const mw2 = createMiddleware(async (_ctx, next) => {
			order.push("mw2")
			return next({ two: true })
		})

		const app = honey<{}>()
		app
			.get("/test")
			.use(mw1)
			.use(mw2)
			.handler((ctx) => {
				order.push("handler")
				return ctx.res.json("ok", { one: ctx.one, two: ctx.two })
			})

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(order).toEqual(["mw1", "mw2", "handler"])
		const data = (await res.json()) as Record<string, boolean>
		expect(data.one).toBe(true)
		expect(data.two).toBe(true)
	})
})

/* ══════════════════════════════════════════════
 * 10. ETAG — conditional request with mismatched ETag
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: ETag — conditional miss", () => {
	it("If-None-Match with wrong ETag → 200 with full body", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { value: 1 }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/data", {
			headers: { "if-none-match": '"wrong-etag"' },
		})
		expect(res.status).toBe(200)
		expect(res.headers.etag).toBeTruthy()
		expect(res.body.length).toBeGreaterThan(0)
	})
})

/* ══════════════════════════════════════════════
 * 11. ETAG — skips non-GET/HEAD methods
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: ETag — method filtering", () => {
	it("POST request → no ETag computed", async () => {
		const app = honey<{}>().use(etag())
		app.post("/data").handler((ctx) => ctx.res.json("created", { id: 1 }))

		const res = await app.fetch(new Request("http://localhost/data", { method: "POST" }), {})
		expect(res.status).toBe(201)
		expect(res.headers.get("etag")).toBeNull()
	})
})

/* ══════════════════════════════════════════════
 * 12. CORS — exposeHeaders on actual request
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: CORS — exposeHeaders", () => {
	it("exposeHeaders listed in response", async () => {
		const app = honey<{}>().use(
			cors({
				exposeHeaders: ["x-custom", "x-total-count"],
				origin: "*",
			}),
		)
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: { origin: "http://app.com" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const exposed = res.headers.get("access-control-expose-headers")
		expect(exposed).toContain("x-custom")
		expect(exposed).toContain("x-total-count")
	})
})

/* ══════════════════════════════════════════════
 * 13. CORS — preflight with explicit allowed methods
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: CORS — custom allowed methods", () => {
	it("preflight with custom methods list", async () => {
		const app = honey<{}>().use(
			cors({
				methods: ["GET", "POST"],
				origin: "*",
			}),
		)
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: {
					"access-control-request-method": "POST",
					origin: "http://app.com",
				},
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.status).toBe(204)
		const methods = res.headers.get("access-control-allow-methods")
		expect(methods).toBe("GET, POST")
	})
})

/* ══════════════════════════════════════════════
 * 14. CORS — maxAge on preflight
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: CORS — maxAge", () => {
	it("custom maxAge in preflight", async () => {
		const app = honey<{}>().use(cors({ maxAge: 3600, origin: "*" }))
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: {
					"access-control-request-method": "GET",
					origin: "http://app.com",
				},
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.headers.get("access-control-max-age")).toBe("3600")
	})
})

/* ══════════════════════════════════════════════
 * 15. BODYLIMIT — POST with no body (null body)
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: bodyLimit — POST with no body", () => {
	it("POST with null body → passes through", async () => {
		const app = honey<{}>().use(bodyLimit({ maxSize: 10 }))
		app.post("/action").handler((ctx) => ctx.res.noContent())

		const res = await app.fetch(new Request("http://localhost/action", { method: "POST" }), {})
		expect(res.status).toBe(204)
	})
})

/* ══════════════════════════════════════════════
 * 16. DUPLICATE ROUTE REGISTRATION → throws
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: duplicate route registration", () => {
	it("same method + path twice → throws", () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))
		expect(() => app.get("/api").handler((ctx) => ctx.res.json("ok", {}))).toThrow(
			"Duplicate route",
		)
	})

	it("different methods on same path → allowed", () => {
		const app = honey<{}>()
		app.get("/api").handler((ctx) => ctx.res.json("ok", {}))
		expect(() => app.post("/api").handler((ctx) => ctx.res.json("created", {}))).not.toThrow()
	})
})

/* ══════════════════════════════════════════════
 * 17. WILDCARD NAME CONFLICT ON INSERT
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: wildcard name conflict on insertRoute", () => {
	it("different wildcard names at same node → throws", () => {
		const app = honey<{}>()
		app.get("/files/*path").handler((ctx) => ctx.res.json("ok", {}))
		expect(() => app.get("/files/*filepath").handler((ctx) => ctx.res.json("ok", {}))).toThrow(
			"Wildcard name conflict",
		)
	})
})

/* ══════════════════════════════════════════════
 * 18. PARAM NAME CONFLICT ON INSERT
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: param name conflict on insertRoute", () => {
	it("different param names at same position → throws", () => {
		const app = honey<{}>()
		app.get("/users/:userId").handler((ctx) => ctx.res.json("ok", {}))
		expect(() => app.post("/users/:id").handler((ctx) => ctx.res.json("created", {}))).toThrow(
			"param name conflict",
		)
	})
})

/* ══════════════════════════════════════════════
 * 19. NODE ADAPTER — response with streaming body + backpressure
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: Node adapter — large streaming response", () => {
	it("large generate() stream → all data received", async () => {
		const app = honey<{}>()
		app.get("/large").handler((ctx) => {
			function* gen() {
				for (let i = 0; i < 100; i++) {
					yield `chunk-${i}\n`
				}
			}
			return ctx.res.generate(gen(), { contentType: "text/plain" })
		})
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/large")
		expect(res.status).toBe(200)
		/* verify all 100 chunks arrived */
		expect(res.body).toContain("chunk-0")
		expect(res.body).toContain("chunk-99")
		const lines = res.body.trim().split("\n")
		expect(lines.length).toBe(100)
	})
})

/* ══════════════════════════════════════════════
 * 20. RESPONSE OPTIONS — custom status on noContent
 * ══════════════════════════════════════════════ */

describe("bug-hunt-7: noContent with custom headers", () => {
	it("noContent with custom header", async () => {
		const app = honey<{}>()
		app.delete("/item").handler((ctx) => ctx.res.noContent({ headers: { "x-deleted": "true" } }))

		const res = await app.fetch(new Request("http://localhost/item", { method: "DELETE" }), {})
		expect(res.status).toBe(204)
		expect(res.headers.get("x-deleted")).toBe("true")
	})
})
