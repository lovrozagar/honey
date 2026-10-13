import { describe, expect, it, vi } from "vitest"
import { honey } from "../../../src/index.ts"
import type { WSAdapter } from "../../../src/ws/cloudflare.ts"

/* ---- URL fast path extraction (integration via fetch()) ---- */

describe("URL fast path extraction", () => {
	it("standard URL routes correctly", async () => {
		const app = honey<{}>()
		app.get("/json").handler((ctx) => ctx.res.json("ok", { route: "json" }))

		const res = await app.fetch(new Request("http://localhost:3000/json"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.route).toBe("json")
	})

	it("URL with query string routes correctly, query not in path", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { matched: true }))

		const res = await app.fetch(new Request("http://localhost:3000/test?a=1"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.matched).toBe(true)
	})

	it("URL with fragment routes correctly, fragment stripped", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { matched: true }))

		/* browsers strip fragments, but raw Request may preserve them */
		const res = await app.fetch(new Request("http://localhost:3000/test#section"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.matched).toBe(true)
	})

	it("URL with query AND fragment strips both from path", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { matched: true }))

		const res = await app.fetch(new Request("http://localhost:3000/test?a=1#frag"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.matched).toBe(true)
	})

	it("URL with non-standard port routes correctly", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", { port: true }))

		const res = await app.fetch(new Request("http://localhost:8080/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.port).toBe(true)
	})

	it("URL without explicit path defaults to /", async () => {
		const app = honey<{}>()
		app.get("/").handler((ctx) => ctx.res.json("ok", { root: true }))

		const res = await app.fetch(new Request("http://localhost:3000/"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.root).toBe(true)
	})
})

/* ---- Static route O(1) lookup ---- */

describe("static route O(1) lookup", () => {
	it("static route /json matches via static map", async () => {
		const app = honey<{}>()
		app.get("/json").handler((ctx) => ctx.res.json("ok", { static: true }))

		const res = await app.fetch(new Request("http://localhost/json"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.static).toBe(true)
	})

	it("parameterized route /users/:id does NOT use static map, falls through to tree", async () => {
		const app = honey<{}>()
		app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))

		const res = await app.fetch(new Request("http://localhost/users/42"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBe("42")
	})

	it("HEAD request to static route falls back to GET handler via static map", async () => {
		const app = honey<{}>()
		app.get("/health").handler((ctx) => ctx.res.json("ok", { healthy: true }))

		const res = await app.fetch(new Request("http://localhost/health", { method: "HEAD" }), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json")
		/* HEAD must have empty body */
		expect(await res.text()).toBe("")
	})

	it("ALL method routes fall through to tree (not static map)", async () => {
		const app = honey<{}>()
		app.all("/catch").handler((ctx) => ctx.res.json("ok", { method: ctx.req.method }))

		const getRes = await app.fetch(new Request("http://localhost/catch"), {})
		expect(getRes.status).toBe(200)
		const getBody = (await getRes.json()) as Record<string, unknown>
		expect(getBody.method).toBe("GET")

		const postRes = await app.fetch(new Request("http://localhost/catch", { method: "POST" }), {})
		expect(postRes.status).toBe(200)
		const postBody = (await postRes.json()) as Record<string, unknown>
		expect(postBody.method).toBe("POST")
	})

	it("multiple static routes each resolve independently", async () => {
		const app = honey<{}>()
		app.get("/a").handler((ctx) => ctx.res.json("ok", { r: "a" }))
		app.get("/b").handler((ctx) => ctx.res.json("ok", { r: "b" }))
		app.post("/a").handler((ctx) => ctx.res.json("created", { r: "a-post" }))

		const resA = await app.fetch(new Request("http://localhost/a"), {})
		expect(((await resA.json()) as Record<string, unknown>).r).toBe("a")

		const resB = await app.fetch(new Request("http://localhost/b"), {})
		expect(((await resB.json()) as Record<string, unknown>).r).toBe("b")

		const resAPost = await app.fetch(new Request("http://localhost/a", { method: "POST" }), {})
		expect(((await resAPost.json()) as Record<string, unknown>).r).toBe("a-post")
	})
})

/* ---- WS upgrade header check ---- */

describe("WS upgrade header check", () => {
	function createTestAdapter(): WSAdapter {
		const response = new Response(null, { status: 200 })
		Object.defineProperty(response, "status", { value: 101 })

		return {
			upgrade(_req, _env, handler) {
				const mockSocket = {
					close: vi.fn(),
					readyState: 1 as const,
					send: vi.fn(),
				}
				const { WSContextImpl } = require("../../../src/ws/cloudflare.ts")
				const socket = new WSContextImpl(mockSocket)
				handler.onOpen?.(undefined, socket)
				return { response, socket }
			},
		}
	}

	it("normal GET to WS-only route returns 426 Upgrade Required", async () => {
		const adapter = createTestAdapter()
		const app = honey<{}>()
		app.wsAdapter(adapter)
		app.ws("/chat").handler({ onOpen: () => {} })

		const res = await app.fetch(new Request("http://localhost/chat"), {})
		expect(res.status).toBe(426)
	})

	it("WebSocket upgrade request to WS route is handled (not 426)", async () => {
		const adapter = createTestAdapter()
		const app = honey<{}>()
		app.wsAdapter(adapter)
		app.ws("/chat").handler({ onOpen: () => {} })

		const req = new Request("http://localhost/chat", {
			headers: { connection: "Upgrade", upgrade: "websocket" },
		})
		const res = await app.fetch(req, {})
		/* adapter returns synthetic 101 */
		expect(res.status).toBe(101)
	})

	it("normal GET to HTTP route returns 200 (not affected by WS check)", async () => {
		const adapter = createTestAdapter()
		const app = honey<{}>()
		app.wsAdapter(adapter)
		app.ws("/chat").handler({ onOpen: () => {} })
		app.get("/api").handler((ctx) => ctx.res.json("ok", { ok: true }))

		const res = await app.fetch(new Request("http://localhost/api"), {})
		expect(res.status).toBe(200)
	})
})

/* ---- Response fast paths (pre-allocated headers) ---- */

describe("response fast paths", () => {
	it("ctx.res.json without opts uses pre-allocated JSON_HEADERS", async () => {
		const app = honey<{}>()
		app.get("/j").handler((ctx) => ctx.res.json("ok", { a: 1 }))

		const res = await app.fetch(new Request("http://localhost/j"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json")
		const body = (await res.json()) as Record<string, unknown>
		expect(body.a).toBe(1)
	})

	it("ctx.res.json with custom headers uses Headers instance (slow path)", async () => {
		const app = honey<{}>()
		app.get("/j2").handler((ctx) => ctx.res.json("ok", { b: 2 }, { headers: { "x-custom": "1" } }))

		const res = await app.fetch(new Request("http://localhost/j2"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/json")
		expect(res.headers.get("x-custom")).toBe("1")
	})

	it("ctx.res.text without opts uses pre-allocated TEXT_HEADERS", async () => {
		const app = honey<{}>()
		app.get("/t").handler((ctx) => ctx.res.text("ok", "hello"))

		const res = await app.fetch(new Request("http://localhost/t"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
		expect(await res.text()).toBe("hello")
	})

	it("ctx.res.html without opts uses pre-allocated HTML_HEADERS", async () => {
		const app = honey<{}>()
		app.get("/h").handler((ctx) => ctx.res.html("ok", "<h1>hi</h1>"))

		const res = await app.fetch(new Request("http://localhost/h"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8")
		expect(await res.text()).toBe("<h1>hi</h1>")
	})

	it("ctx.res.csv without opts uses pre-allocated CSV_HEADERS", async () => {
		const app = honey<{}>()
		app.get("/c").handler((ctx) => ctx.res.csv("ok", "a,b\n1,2"))

		const res = await app.fetch(new Request("http://localhost/c"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8")
	})

	it("ctx.res.binary without opts uses pre-allocated BINARY_HEADERS", async () => {
		const app = honey<{}>()
		app.get("/bin").handler((ctx) => ctx.res.binary("ok", new Uint8Array([1, 2, 3])))

		const res = await app.fetch(new Request("http://localhost/bin"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("application/octet-stream")
	})

	it("ctx.res.text with custom headers falls back to Headers instance", async () => {
		const app = honey<{}>()
		app.get("/t2").handler((ctx) => ctx.res.text("ok", "hi", { headers: { "x-tag": "yes" } }))

		const res = await app.fetch(new Request("http://localhost/t2"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8")
		expect(res.headers.get("x-tag")).toBe("yes")
	})
})
