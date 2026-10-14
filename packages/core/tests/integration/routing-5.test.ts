import { describe, expect, expectTypeOf, it, vi } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware, type MiddlewareFn } from "../../src/middleware/middleware.ts"
import { defineErrors } from "../../src/errors/errors.ts"
import { normalizePattern, parsePattern } from "../../src/routing/pattern.ts"

type TestInit = { headers?: Record<string, string>; json?: unknown; search?: Record<string, string> }

/** v0's testClient5, reduced to what these cases use: requests through app.fetch. */
function testClient5<E>(app: { fetch: (r: Request, env: E) => Response | Promise<Response> }, opts?: { env?: E }) {
	const request = async (method: string, path: string, init?: TestInit): Promise<Response> => {
		const url = new URL(path, "http://localhost")
		for (const [k, v] of Object.entries(init?.search ?? {})) url.searchParams.set(k, v)
		const headers = new Headers(init?.headers)
		let body: string | undefined
		if (init?.json !== undefined) {
			headers.set("content-type", "application/json")
			body = JSON.stringify(init.json)
		}
		return app.fetch(new Request(url, { body, headers, method }), (opts?.env ?? {}) as E)
	}
	const verb = (method: string) => (path: string, init?: TestInit) => request(method, path, init)
	return {
		delete: verb("DELETE"),
		get: verb("GET"),
		head: verb("HEAD"),
		options: verb("OPTIONS"),
		patch: verb("PATCH"),
		post: verb("POST"),
		put: verb("PUT"),
		request,
	}
}

const PROTO_KEYS = ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]

const auth: MiddlewareFn<{ req: Request }, {}> = (ctx, next) =>
	ctx.req.headers.get("authorization") === "ok" ? next() : new Response("denied", { status: 401 })

const get = (app: { fetch(r: Request, e: object): Response | Promise<Response> }, path: string, method = "GET") =>
	app.fetch(new Request(`http://x${path}`, { method }), {})

const cache: MiddlewareFn<{ req: Request }, {}> = async (ctx, next) => {
	if (ctx.req.url.includes("/cached")) {
		return new Response(JSON.stringify({ cached: true }), {
			headers: { "content-type": "application/json" },
			status: 200,
		})
	}
	return next()
}
describe("integration: middleware short-circuit", () => {
	// v0: 013c02744a
	it("middleware returns response directly → handler never runs", async () => {
		const handlerCalled = vi.fn()

		const h = honey<{}>()
		const cached = h.use(cache)

		cached.get("/cached").handler((ctx) => {
			handlerCalled()
			return ctx.res.text("ok", "not-cached")
		})
		cached.get("/uncached").handler((ctx) => ctx.res.text("ok", "fresh"))

		const client = testClient5(h, { env: {} })

		const res1 = await client.get("/cached")
		expect(res1.status).toBe(200)
		const body = (await res1.json()) as Record<string, unknown>
		expect(body.cached).toBe(true)
		expect(handlerCalled).not.toHaveBeenCalled()

		const res2 = await client.get("/uncached")
		expect(res2.status).toBe(200)
		expect(await res2.text()).toBe("fresh")
	})
})

describe("request-keyed objects have no prototype", () => {
	// v0: 6ed9c47660
	it("ctx.search and ctx.searchAll treat prototype names as plain keys", async () => {
		const app = honey<{}>()
		app.get("/q").handler((ctx) =>
			ctx.res.json("ok", {
				all: PROTO_KEYS.map((k) => ctx.searchAll[k] ?? null),
				first: PROTO_KEYS.map((k) => ctx.search[k] ?? null),
				missing: ctx.search["nope"] ?? null,
			}),
		)
		const query = PROTO_KEYS.map((k) => `${k}=v-${k}&${k}=w`).join("&")
		const res = await app.fetch(new Request(`http://localhost/q?${query}`), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { all: string[][]; first: string[]; missing: null }
		expect(body.first).toEqual(PROTO_KEYS.map((k) => `v-${k}`))
		expect(body.all).toEqual(PROTO_KEYS.map((k) => [`v-${k}`, "w"]))
		expect(body.missing).toBeNull()
	})

	// v0: 9eb2f48506
	it("ctx.headers is a null-prototype view", async () => {
		const app = honey<{}>()
		app.get("/h").handler((ctx) => ctx.res.json("ok", { type: typeof ctx.headers["constructor"] }))
		expect(await (await app.fetch(new Request("http://localhost/h"), {})).json()).toEqual({ type: "undefined" })
	})
})

describe("the router, scopes and ctx.path see one normalized path", () => {
	function app() {
		const a = honey<{}>()
		a.use("/admin", auth)
		a.get("/admin/secret").handler((ctx) => ctx.res.json("ok", { path: ctx.path, pattern: ctx.routePattern }))
		a.get("/files/*rest").handler((ctx) => ctx.res.json("ok", { path: ctx.path, rest: ctx.params.rest }))
		return a
	}

	// v0: b8530d8cc2
	it("//admin/secret is /admin/secret everywhere: scope guard, ctx.path and route", async () => {
		const a = app()
		expect((await a.fetch(new Request("http://localhost//admin/secret"), {})).status).toBe(401)
		const res = await a.fetch(new Request("http://localhost//admin/secret", { headers: { authorization: "ok" } }), {})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ path: "/admin/secret", pattern: "/admin/secret" })
	})

	// v0: dd21469798
	it("a ctx.path.startsWith guard sees the normalized path", async () => {
		const a = honey<{}>().use((ctx, next) =>
			ctx.path.startsWith("/admin") ? new Response("no", { status: 403 }) : next(),
		)
		a.get("/admin/secret").handler((ctx) => ctx.res.text("ok", "secret"))
		for (const p of ["//admin/secret", "/./admin/secret", "/x/../admin/secret", "/%2e/admin/secret"]) {
			const raw = new Request("http://localhost/")
			Object.defineProperty(raw, "url", { value: `http://localhost${p}` })
			expect((await a.fetch(raw, {})).status, p).toBe(403)
		}
	})

	// v0: 860d347581
	it("dot segments never reach a wildcard param", async () => {
		const raw = new Request("http://localhost/")
		Object.defineProperty(raw, "url", { value: "http://localhost/files/a/../../admin/secret" })
		const res = await app().fetch(raw, {})
		/* resolved to /admin/secret, which the scope guards */
		expect(res.status).toBe(401)
	})

	// v0: 5893ed7b81
	it("an encoded slash is 400 before routing or middleware", async () => {
		const a = app()
		const res = await a.fetch(new Request("http://localhost/files/..%2fadmin%2fsecret"), {})
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error_key: string }).error_key).toBe("bad_request")
	})

	// v0: 37e860ba5a
	it("encodedSlashes('allow') decodes an encoded slash into the param, still scoped", async () => {
		const a = app().encodedSlashes("allow")
		const res = await a.fetch(new Request("http://localhost/files/a%2Fb"), {})
		expect(await res.json()).toEqual({ path: "/files/a%2Fb", rest: "a/b" })
	})
})

describe("pattern grammar", () => {
	// v0: 17759e784b
	it("encodes a literal the way the request path is encoded, so it can be requested", async () => {
		expect(normalizePattern("/é/a b/x^y")).toBe("/%C3%A9/a%20b/x%5Ey")
		expect(normalizePattern("/%C3%A9")).toBe("/%C3%A9")
		expect(() => parsePattern("/a/%2e%2E")).toThrow(/segments are not allowed/)
		const app = honey()
		app.get("/é/a b").handler((c) => c.res.text("ok", c.path))
		for (const target of ["/é/a b", "/%C3%A9/a%20b"]) {
			const res = await get(app, target)
			expect(res.status).toBe(200)
			expect(await res.text()).toBe("/%C3%A9/a%20b")
		}
	})
})

describe("mounting copies records and nodes", () => {
	// v0: 84fe069da7
	it("two parents mounting one sub keep their own scoped middleware", async () => {
		const deny = createMiddleware(async () => new Response("denied", { status: 403 }))
		const sub = honey()
		sub.get("/api/users").handler((c) => c.res.text("ok", "users"))
		const p1 = honey()
		p1.use("/api/admin", deny)
		p1.route(sub)
		const p2 = honey()
		p2.route(sub)
		p1.get("/api/admin").handler((c) => c.res.text("ok", "admin"))
		expect((await get(p1, "/api/admin")).status).toBe(403)
		expect((await get(p2, "/api/admin")).status).toBe(404)
		expect((await get(sub, "/api/admin")).status).toBe(404)
	})

	// v0: e5126955a5
	it("routes the sub registers after mounting stay its own", async () => {
		const sub = honey()
		sub.get("/a").handler((c) => c.res.text("ok", "a"))
		const parent = honey().route(sub)
		sub.get("/b").handler((c) => c.res.text("ok", "b"))
		expect((await get(parent, "/a")).status).toBe(200)
		expect((await get(parent, "/b")).status).toBe(404)
		expect((await get(sub, "/b")).status).toBe(200)
	})
})

describe(".routeTree() hydration", () => {
	// v0: 73c30e5a6e
	it("registration after the first request re-finalizes (epoch)", async () => {
		const app = honey<{}>()
		app.get("/a").handler((c) => c.res.text("ok", "a"))
		expect((await app.fetch(new Request("http://x/a"), {})).status).toBe(200)
		app.get("/b").handler((c) => c.res.text("ok", "b"))
		const res = await app.fetch(new Request("http://x/b"), {})
		expect(await res.text()).toBe("b")
	})
})

describe("router ≡ loaded tree ≡ naive reference matcher", () => {
	// v0: 21ddd9fda7
	it("405 lists every method that matches the path across branches", async () => {
		const app = honey()
		app.get("/u/me").handler((c) => c.res.text("ok", "me"))
		app.post("/u/:id").handler((c) => c.res.text("ok", "id"))
		const res = await app.fetch(new Request("http://x/u/me", { method: "PUT" }), {})
		expect(res.status).toBe(405)
		expect(
			res.headers
				.get("allow")
				?.split(",")
				.map((s) => s.trim())
				.sort(),
		).toEqual(["GET", "POST"])
	})
})

describe("route builder lifecycle — .boundary() one-shot", () => {
	// v0: 75cec192da
	it("boundary absent after use", () => {
		const errs = defineErrors({ internal_server_error: "internal_server_error" })
		const b = honey<{}>().errorFactory(errs).get("/test").boundary("internal_server_error")
		expectTypeOf(b).not.toHaveProperty("boundary")
	})
})

describe("route builder lifecycle — .use() stays multi-call", () => {
	// v0: 9d3ec7169b
	it("use available after use (multi-call)", () => {
		const mw1 = createMiddleware(async (_ctx, next) => next({ a: 1 }))
		const mw2 = createMiddleware(async (_ctx, next) => next({ b: 2 }))
		const b = honey<{}>().get("/test").use(mw1).use(mw2)
		expectTypeOf(b).toHaveProperty("use")
		expectTypeOf(b).toHaveProperty("handler")
	})
})
