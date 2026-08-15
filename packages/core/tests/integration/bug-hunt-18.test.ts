import http from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { bodyLimit } from "../../src/body-limit.ts"
import { cors } from "../../src/cors.ts"
import { csrf } from "../../src/csrf.ts"
import { HoneyError } from "../../src/error.ts"
import { etag } from "../../src/etag.ts"
import { honey } from "../../src/index.ts"
import { createMiddleware } from "../../src/middleware.ts"
import { type HoneyServer, serve } from "../../src/node.ts"
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
 * 1. ADVERSARIAL — route path as single character
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: single-character paths", () => {
	it("route /a → matches", async () => {
		const app = honey<{}>()
		app.get("/a").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(new Request("http://localhost/a"), {})
		expect(res.status).toBe(200)
	})

	it("route /:x → single-char param name works", async () => {
		const app = honey<{}>()
		app.get("/:x").handler((ctx) => ctx.res.json("ok", { x: ctx.params.x }))

		const res = await app.fetch(new Request("http://localhost/hello"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.x).toBe("hello")
	})
})

/* ══════════════════════════════════════════════
 * 2. ADVERSARIAL — param value that looks like a path segment
 *
 * /users/:id where id contains URL-encoded characters.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: param values with special characters", () => {
	it("param with URL-encoded @ → decoded", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://localhost/users/user%40domain.com"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.id).toBe("user@domain.com")
	})

	it("param with + (not encoded) → stays as +", async () => {
		const app = honey<{}>()
		app.get("/search/:q").handler((ctx) => ctx.res.json("ok", { q: ctx.params.q }))

		const res = await app.fetch(new Request("http://localhost/search/hello+world"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		/* + in URL path is NOT decoded to space (only in query strings) */
		expect(data.q).toBe("hello+world")
	})
})

/* ══════════════════════════════════════════════
 * 3. ADVERSARIAL — handler that returns response from previous request
 *
 * If handler accidentally returns a cached/stale Response object,
 * .clone() would be needed. But Response body can only be consumed once.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: response consumed once per request", () => {
	it("each request gets fresh response body", async () => {
		let counter = 0
		const app = honey<{}>()
		app.get("/count").handler((ctx) => {
			counter++
			return ctx.res.json("ok", { n: counter })
		})

		const r1 = await app.fetch(new Request("http://localhost/count"), {})
		const r2 = await app.fetch(new Request("http://localhost/count"), {})
		const d1 = (await r1.json()) as Record<string, number>
		const d2 = (await r2.json()) as Record<string, number>
		expect(d1.n).toBe(1)
		expect(d2.n).toBe(2)
	})
})

/* ══════════════════════════════════════════════
 * 4. ADVERSARIAL — very large JSON response via Node adapter
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: large JSON response", () => {
	it("10KB JSON response → arrives intact", async () => {
		const app = honey<{}>()
		const bigArray = Array.from({ length: 500 }, (_, i) => ({
			data: "x".repeat(10),
			id: i,
		}))
		app.get("/big").handler((ctx) => ctx.res.json("ok", bigArray))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const res = await request(addr.port, "/big")
		expect(res.status).toBe(200)
		const data = JSON.parse(res.body) as Array<{ id: number }>
		expect(data.length).toBe(500)
		expect(data[0].id).toBe(0)
		expect(data[499].id).toBe(499)
	})
})

/* ══════════════════════════════════════════════
 * 5. ADVERSARIAL — CORS preflight + CSRF + bodyLimit
 *
 * Three security middlewares stacked. Preflight should
 * pass through CORS, skip CSRF and bodyLimit.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: CORS + CSRF + bodyLimit combined", () => {
	it("preflight → only CORS responds, others skipped", async () => {
		const app = honey<{}>()
			.use(cors({ origin: "http://app.com" }))
			.use(csrf({ origin: "http://app.com" }))
			.use(bodyLimit({ maxSize: 100 }))
		app.post("/api").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/api", {
				headers: {
					"access-control-request-headers": "content-type",
					"access-control-request-method": "POST",
					origin: "http://app.com",
				},
				method: "OPTIONS",
			}),
			{},
		)
		expect(res.status).toBe(204)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://app.com")
	})

	it("actual POST with all three → passes", async () => {
		const app = honey<{}>()
			.use(cors({ origin: "http://app.com" }))
			.use(csrf({ origin: "http://app.com" }))
			.use(bodyLimit({ maxSize: 1000 }))
		app.post("/api").handler(async (ctx) => {
			const body = (await ctx.req.json()) as Record<string, string>
			return ctx.res.json("created", body)
		})

		const res = await app.fetch(
			new Request("http://localhost/api", {
				body: JSON.stringify({ data: "test" }),
				headers: {
					"content-type": "application/json",
					origin: "http://app.com",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(201)
		expect(res.headers.get("access-control-allow-origin")).toBe("http://app.com")
	})
})

/* ══════════════════════════════════════════════
 * 6. ADVERSARIAL — CSRF with multipart/form-data
 *
 * csrf.ts blocks multipart/form-data from cross-origin.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: CSRF with multipart/form-data", () => {
	it("cross-origin multipart form → 403", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.post("/upload").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/upload", {
				body: '------boundary\r\nContent-Disposition: form-data; name="file"\r\n\r\ndata\r\n------boundary--',
				headers: {
					"content-type": "multipart/form-data; boundary=----boundary",
					origin: "http://evil.com",
				},
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(403)
	})

	it("same-origin multipart form → passes", async () => {
		const app = honey<{}>().use(csrf({ origin: "http://app.com" }))
		app.post("/upload").handler((ctx) => ctx.res.json("ok", {}))

		const res = await app.fetch(
			new Request("http://localhost/upload", {
				body: new FormData(),
				headers: { "sec-fetch-site": "same-origin" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(200)
	})
})

/* ══════════════════════════════════════════════
 * 7. ADVERSARIAL — etag on response with binary content-type
 *
 * Binary responses with content-type set should still
 * get ETag (they're not "streaming" — they have content-type).
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: ETag on binary response", () => {
	it("binary response with content-type → ETag computed", async () => {
		const app = honey<{}>().use(etag())
		app.get("/bin").handler((ctx) => ctx.res.binary("ok", new Uint8Array([1, 2, 3, 4, 5])))

		const res = await app.fetch(new Request("http://localhost/bin"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("etag")).toBeTruthy()
	})
})

/* ══════════════════════════════════════════════
 * 8. ADVERSARIAL — middleware that delays significantly
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: slow middleware", () => {
	it("middleware with 50ms delay → response still correct", async () => {
		const slowMw = createMiddleware(async (_ctx, next) => {
			await new Promise((r) => setTimeout(r, 50))
			return next({ delayed: true })
		})

		const app = honey<{}>().use(slowMw)
		app.get("/api").handler((ctx) => ctx.res.json("ok", { delayed: ctx.delayed }))

		const start = performance.now()
		const res = await app.fetch(new Request("http://localhost/api"), {})
		const elapsed = performance.now() - start

		expect(res.status).toBe(200)
		expect(elapsed).toBeGreaterThan(40)
		const data = (await res.json()) as Record<string, boolean>
		expect(data.delayed).toBe(true)
	})
})

/* ══════════════════════════════════════════════
 * 9. ADVERSARIAL — two different apps on same port
 *    (via mergeTree with separate middleware stacks)
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: merged apps with separate configs", () => {
	it("two apps merged → each route has its own handler behavior", async () => {
		const { mergeTree } = await import("../../src/tree.ts")

		const apiApp = honey<{}>()
		apiApp.get("/api/data").handler((ctx) => ctx.res.json("ok", { source: "api" }))

		const adminApp = honey<{}>()
		adminApp.get("/admin/users").handler((ctx) => ctx.res.json("ok", { source: "admin" }))

		const merged = mergeTree(apiApp.toRouteTree(), adminApp.toRouteTree())
		const app = honey<{}>()
		app.routeTree(merged)
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		const r1 = await request(addr.port, "/api/data")
		expect(r1.status).toBe(200)
		expect((JSON.parse(r1.body) as Record<string, unknown>).source).toBe("api")

		const r2 = await request(addr.port, "/admin/users")
		expect(r2.status).toBe(200)
		expect((JSON.parse(r2.body) as Record<string, unknown>).source).toBe("admin")

		/* cross-path 404 */
		const r3 = await request(addr.port, "/api/users")
		expect(r3.status).toBe(404)
	})
})

/* ══════════════════════════════════════════════
 * 10. ADVERSARIAL — testClient multi-step workflow
 *    with cookies + auth + search params
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: testClient — full API workflow", () => {
	it("register → login → create → list → delete → verify", async () => {
		const items: Array<{ id: number; name: string; owner: string }> = []
		let nextId = 1

		const app = honey<{}>()
		app
			.post("/auth/login")
			.handler((ctx) =>
				ctx.res.json(
					"ok",
					{ user: "alice" },
					{ cookies: { session: { httpOnly: true, path: "/", value: "s-alice" } } },
				),
			)
		app.post("/items").handler(async (ctx) => {
			const session = ctx.cookies.session
			if (!session) throw new HoneyError({ errorKey: "unauthorized", status: "unauthorized" })
			const body = (await ctx.req.json()) as { name: string }
			const item = { id: nextId++, name: body.name, owner: session }
			items.push(item)
			return ctx.res.json("created", item)
		})
		app.get("/items").handler((ctx) => {
			const owner = ctx.search.owner as string | undefined
			const filtered = owner ? items.filter((i) => i.owner === owner) : items
			return ctx.res.json("ok", filtered)
		})
		app.delete("/items/:id").handler((ctx) => {
			const idx = items.findIndex((i) => i.id === Number(ctx.params.id))
			if (idx === -1) throw new HoneyError({ errorKey: "not_found", status: "not_found" })
			items.splice(idx, 1)
			return ctx.res.noContent()
		})

		const client = testClient(app, { cookies: true, env: {} })

		/* login */
		const loginRes = await client.post("/auth/login")
		expect(loginRes.status).toBe(200)

		/* create item (cookie auto-sent) */
		const createRes = await client.post("/items", { json: { name: "Widget" } })
		expect(createRes.status).toBe(201)
		const created = (await createRes.json()) as { id: number }
		expect(created.id).toBe(1)

		/* list with filter */
		const listRes = await client.get("/items", { search: { owner: "s-alice" } })
		expect(listRes.status).toBe(200)
		const list = (await listRes.json()) as Array<{ name: string }>
		expect(list.length).toBe(1)
		expect(list[0].name).toBe("Widget")

		/* delete */
		const delRes = await client.delete("/items/1")
		expect(delRes.status).toBe(204)

		/* verify empty */
		const emptyRes = await client.get("/items")
		expect(emptyRes.status).toBe(200)
		const empty = (await emptyRes.json()) as unknown[]
		expect(empty.length).toBe(0)
	})
})

/* ══════════════════════════════════════════════
 * 11. ADVERSARIAL — error thrown inside SSE send()
 *
 * If event.data is an object that can't be stringified
 * (e.g., contains a function), JSON.stringify throws.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: SSE send with unstringifiable data", () => {
	it("object with function → JSON.stringify throws inside send", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				/* send valid event first */
				await stream.send({ data: "ok", event: "first" })
				/* then try to send unstringifiable data */
				try {
					await stream.send({
						data: { fn: () => {} } as unknown as string,
						event: "bad",
					})
				} catch {
					/* JSON.stringify on function doesn't actually throw — it silently
					 * drops the function key. So this won't error. */
				}
				stream.close()
			}),
		)

		const res = await app.fetch(new Request("http://localhost/events"), {})
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toContain("data: ok")
	})
})

/* ══════════════════════════════════════════════
 * 12. ADVERSARIAL — JSON response with undefined values
 *
 * JSON.stringify drops undefined values from objects.
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: JSON serialization edge cases", () => {
	it("object with undefined values → keys dropped", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { exists: true, gone: undefined }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.exists).toBe(true)
		expect("gone" in data).toBe(false)
	})

	it("NaN in JSON → becomes null", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { value: Number.NaN }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const data = (await res.json()) as Record<string, unknown>
		expect(data.value).toBeNull()
	})

	it("Infinity in JSON → becomes null", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { value: Number.POSITIVE_INFINITY }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const data = (await res.json()) as Record<string, unknown>
		expect(data.value).toBeNull()
	})
})

/* ══════════════════════════════════════════════
 * 13. ADVERSARIAL — concurrent SSE + regular requests
 * ══════════════════════════════════════════════ */

describe("bug-hunt-18: SSE + regular requests concurrent", () => {
	it("SSE stream doesn't block regular requests", async () => {
		const app = honey<{}>()
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				await stream.send({ data: "hello", event: "msg" })
				await new Promise((r) => setTimeout(r, 30))
				stream.close()
			}),
		)
		app.get("/api").handler((ctx) => ctx.res.json("ok", { fast: true }))
		server = serve(app, { env: {}, port: 0 })
		const addr = server.address() as { port: number }

		/* start SSE and regular request concurrently */
		const [sseRes, apiRes] = await Promise.all([
			request(addr.port, "/events"),
			request(addr.port, "/api"),
		])

		expect(sseRes.status).toBe(200)
		expect(sseRes.body).toContain("data: hello")
		expect(apiRes.status).toBe(200)
		expect((JSON.parse(apiRes.body) as Record<string, unknown>).fast).toBe(true)
	})
})
