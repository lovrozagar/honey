import { describe, expect, it, vi } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { HoneyRes } from "../response/response.ts"
import { SILENT } from "../telemetry/logger.ts"
import { PEER_ADDRESS } from "./peer.ts"
import {
	HoneyContext,
	isReservedCtxKey,
	NO_ROUTE,
	REQUEST,
	type RequestState,
	type RouteInfo,
	setCtxError,
} from "./context.ts"

function makeReq(url = "http://localhost/test", headers?: Record<string, string>): Request {
	return new Request(url, { headers })
}

function makeCtx(state?: Partial<RequestState<{ DB: string }>>, route: RouteInfo = NO_ROUTE, params = { id: "42" }) {
	return new HoneyContext(
		{ env: { DB: "test" }, executionCtx: undefined, path: "/test", req: makeReq(), ...state },
		route,
		params,
	)
}

function fail(): never {
	throw new Error("read too early")
}

/** A request whose headers and url throw when read: constructing a context must not touch them. */
function untouchable(): Request {
	return {
		get headers() {
			return fail()
		},
		get url() {
			return fail()
		},
	} as unknown as Request
}

describe("HoneyContext > constructor", () => {
	// v0: 354be6cfb9
	it("assigns env directly", () => {
		const env = { DB: "prod" }
		expect(makeCtx({ env }).env).toBe(env)
	})

	// v0: 1822552f2e
	it("assigns params directly", () => {
		const params = { id: "99" }
		expect(makeCtx(undefined, NO_ROUTE, params).params).toBe(params)
	})

	// v0: 11292ac903
	it("assigns req directly", () => {
		const req = makeReq("http://example.com/path")
		expect(makeCtx({ req }).req).toBe(req)
	})

	// v0: 3cf493112e
	it("assigns res as a HoneyRes instance", () => {
		const ctx = makeCtx()
		expect(ctx.res).toBeInstanceOf(HoneyRes)
		expect(typeof ctx.res.json).toBe("function")
		expect(typeof ctx.res.text).toBe("function")
	})

	it("reads path from the request state and pattern, meta and errors from the route", () => {
		const errors = { gone: () => new HoneyError({ errorKey: "gone", status: "gone" }) }
		const route: RouteInfo = { errors, id: "GET /users/:id", meta: Object.freeze({ tag: "a" }), pattern: "/users/:id" }
		const state: RequestState<{ DB: string }> = {
			env: { DB: "x" },
			executionCtx: undefined,
			path: "/users/1",
			req: makeReq(),
		}
		const ctx = new HoneyContext(state, route, { id: "1" })
		expect(ctx.path).toBe("/users/1")
		expect(ctx.routePattern).toBe("/users/:id")
		expect(ctx.meta).toEqual({ tag: "a" })
		expect(ctx.errors).toBe(errors)
		expect(ctx[REQUEST]).toBe(state)
	})

	// v0: 2eb112479d
	// v0: cd9c1d5b6d
	// v0: f6248f40b1
	it("reads nothing from the request until asked", () => {
		const ctx = makeCtx({ req: untouchable() })
		expect(() => ctx.cookies).toThrow("read too early")
		expect(() => ctx.headers).toThrow("read too early")
		expect(() => ctx.search).toThrow("read too early")
	})
})

describe("HoneyContext > defaults", () => {
	// v0: 6558a21332
	it("routePattern defaults to empty string", () => {
		expect(makeCtx().routePattern).toBe("")
	})

	// v0: 71f24601f6
	it("meta defaults to frozen empty object", () => {
		const ctx = makeCtx()
		expect(ctx.meta).toEqual({})
		expect(Object.isFrozen(ctx.meta)).toBe(true)
	})

	// v0: 40d9b79442
	it("executionCtx is undefined by default", () => {
		expect(makeCtx().executionCtx).toBeUndefined()
	})

	it("errors default to an empty frozen record and error to undefined", () => {
		const ctx = makeCtx()
		expect(ctx.errors).toEqual({})
		expect(Object.isFrozen(ctx.errors)).toBe(true)
		expect(ctx.error).toBeUndefined()
	})
})

describe("HoneyContext > log", () => {
	it("a context no app serves logs nowhere", () => {
		expect(makeCtx().log).toBe(SILENT)
	})
})

describe("HoneyContext > background", () => {
	// v0: 6f98d422a8
	it("delegates to executionCtx.waitUntil when provided", () => {
		const executionCtx = { waitUntil: vi.fn<(p: Promise<unknown>) => void>() }
		const ctx = makeCtx({ executionCtx })
		const p = Promise.resolve("done")
		ctx.background(p)
		expect(executionCtx.waitUntil).toHaveBeenCalledOnce()
		expect(executionCtx.waitUntil.mock.calls[0]?.[0]).toBe(p)
		/* called on its owner: workerd's waitUntil throws "Illegal invocation" when detached */
		expect(executionCtx.waitUntil.mock.contexts[0]).toBe(executionCtx)
	})

	// v0: 07060dac4d
	it("swallows rejected promises when no waitUntil", async () => {
		const ctx = makeCtx({ executionCtx: {} })
		expect(ctx.background(Promise.reject(new Error("ignored")))).toBeUndefined()
		await new Promise((resolve) => setTimeout(resolve, 10))
	})
})

describe("HoneyContext > lazy cookies", () => {
	// v0: 967aa4ef67
	it("parsed correctly from cookie header", () => {
		expect(makeCtx({ req: makeReq("http://localhost/test", { cookie: "a=1; b=hello" }) }).cookies).toEqual({
			a: "1",
			b: "hello",
		})
	})

	// v0: ed507b99ce
	it("cached after first access (same reference)", () => {
		const ctx = makeCtx({ req: makeReq("http://localhost/test", { cookie: "x=y" }) })
		expect(ctx.cookies).toBe(ctx.cookies)
	})

	// v0: 5748715301
	it("empty object when no cookie header", () => {
		expect(makeCtx().cookies).toEqual({})
	})
})

describe("HoneyContext > lazy headers", () => {
	// v0: 703b2d9366
	it("converts Headers to Record correctly", () => {
		const h = makeCtx({
			req: makeReq("http://localhost/test", { "content-type": "application/json", "x-custom": "value" }),
		}).headers
		expect(h["content-type"]).toBe("application/json")
		expect(h["x-custom"]).toBe("value")
		expect(Object.getPrototypeOf(h)).toBeNull()
	})

	// v0: e0c7d6c087
	it("cached after first access", () => {
		const ctx = makeCtx({ req: makeReq("http://localhost/test", { "x-test": "1" }) })
		expect(ctx.headers).toBe(ctx.headers)
	})
})

describe("HoneyContext > lazy search", () => {
	// v0: 4e0d8b3717
	it("falls back to new URL(req.url) when no urlFn", () => {
		expect(makeCtx({ req: makeReq("http://localhost/test?key=fallback") }).search.key).toBe("fallback")
	})

	// v0: 10cbbf543a
	it("single param returns string value", () => {
		expect(makeCtx({ req: makeReq("http://localhost/test?name=alice") }).search.name).toBe("alice")
	})

	// v0: ce606c24d2
	it("multiple same params → search returns first value", () => {
		const ctx = makeCtx({ req: makeReq("http://localhost/test?tag=a&tag=b&tag=c") })
		expect(ctx.search.tag).toBe("a")
		expect(ctx.searchAll.tag).toEqual(["a", "b", "c"])
	})

	it("searchAll parses on its own when read first", () => {
		expect(makeCtx({ req: makeReq("http://localhost/test?q=1&q=2") }).searchAll.q).toEqual(["1", "2"])
	})

	// v0: 6398e2edc8
	it("cached after first access", () => {
		const ctx = makeCtx({ req: makeReq("http://localhost/test?q=1") })
		expect(ctx.search).toBe(ctx.search)
		expect(ctx.searchAll).toBe(ctx.searchAll)
	})

	it("keys are request data: no prototype, a fragment is not part of the query", () => {
		const ctx = makeCtx({ req: makeReq("http://localhost/test?__proto__=x&toString=y#frag=z") })
		expect(Object.getPrototypeOf(ctx.search)).toBeNull()
		expect(ctx.search.__proto__).toBe("x")
		expect(ctx.searchAll.toString).toEqual(["y"])
		expect(ctx.search.frag).toBeUndefined()
		expect(makeCtx().search).toEqual({})
	})
})

describe("HoneyContext > errors property", () => {
	// v0: 63a5f13246
	it("can be set after construction", () => {
		const ctx = makeCtx()
		const errors = { notFound: () => new Error("not found") }
		;(ctx as unknown as Record<string, unknown>).errors = errors
		expect(ctx.errors).toBe(errors)
	})
})

describe("HoneyContext > meta", () => {
	// v0: 3587f0ccc3
	it("is frozen (Object.isFrozen)", () => {
		expect(Object.isFrozen(makeCtx().meta)).toBe(true)
	})

	// v0: 74a5d9783d
	it("accepts custom meta and preserves it", () => {
		const meta = Object.freeze({ version: "1.0" })
		expect(makeCtx(undefined, { errors: null, id: "", meta, pattern: "" }).meta).toBe(meta)
	})
})

describe("HoneyContext > the error slot", () => {
	it("setCtxError records the error behind the response", () => {
		const ctx = makeCtx()
		const err = new HoneyError({ errorKey: "gone", status: "gone" })
		setCtxError(ctx, err)
		expect(ctx.error).toBe(err)
	})
})

describe("HoneyContext > signal", () => {
	it("follows the request's own signal", () => {
		const controller = new AbortController()
		const ctx = makeCtx({ req: new Request("http://localhost/", { signal: controller.signal }) })
		const signal = ctx.signal
		expect(ctx.signal).toBe(signal)
		expect(signal.aborted).toBe(false)
		controller.abort("gone")
		expect(signal.aborted).toBe(true)
		expect(signal.reason).toBe("gone")
	})

	it("is aborted at once when the request already was, and stands alone for a shim without one", () => {
		const controller = new AbortController()
		controller.abort("early")
		expect(makeCtx({ req: new Request("http://localhost/", { signal: controller.signal }) }).signal.reason).toBe(
			"early",
		)
		const shim = {
			get signal() {
				throw new Error("no signal")
			},
		} as unknown as Request
		expect(makeCtx({ req: shim }).signal.aborted).toBe(false)
		expect(makeCtx({ req: {} as Request }).signal.aborted).toBe(false)
	})
})

describe("HoneyContext > ip", () => {
	it("is the canonical peer, read only when asked and once per request", () => {
		const req = makeReq("http://app.internal/who")
		let reads = 0
		Object.defineProperty(req, PEER_ADDRESS, {
			get: () => {
				reads++
				return "::ffff:203.0.113.7"
			},
		})
		const ctx = makeCtx({ req })
		expect(reads).toBe(0)
		expect([ctx.ip, ctx.ip]).toEqual(["203.0.113.7", "203.0.113.7"])
		expect(reads).toBe(1)
	})

	it("is null when the runtime reports no peer", () => {
		expect(makeCtx().ip).toBeNull()
	})
})

describe("HoneyContext > res is linked to the request", () => {
	it("sse() resumes from the request's Last-Event-ID, and its stream ends when the request does", async () => {
		const client = new AbortController()
		const req = new Request("http://app.internal/events", { headers: { "last-event-id": "41" }, signal: client.signal })
		const seen: unknown[] = []
		const response = makeCtx({ req }).res.sse(async (stream) => {
			seen.push(stream.lastEventId)
			await new Promise((resolve) => stream.signal.addEventListener("abort", resolve))
			seen.push("producer ended")
		})
		const reader = (response.body as ReadableStream<Uint8Array>).getReader()
		const pending = reader.read()
		await new Promise((resolve) => setTimeout(resolve, 5))
		client.abort()
		expect([await pending, seen]).toEqual([{ done: true, value: undefined }, ["41", "producer ended"]])
	})
})

describe("isReservedCtxKey", () => {
	// v0: dc8083501c
	it("names every framework-owned context field", () => {
		for (const key of [
			"background",
			"cookies",
			"env",
			"error",
			"errors",
			"executionCtx",
			"headers",
			"meta",
			"params",
			"path",
		]) {
			expect(isReservedCtxKey(key), key).toBe(true)
		}
		for (const key of ["ip", "log", "req", "res", "routePattern", "search", "searchAll", "signal"])
			expect(isReservedCtxKey(key), key).toBe(true)
		expect(isReservedCtxKey("user")).toBe(false)
		expect(isReservedCtxKey("toString")).toBe(false)
	})
})

describe("HoneyContext — lazy parsing", () => {
	// v0: 726d3a4875
	it("search built from URL on first access, cached (first value per key)", () => {
		const ctx = makeCtx({ req: makeReq("http://localhost/test?a=1&b=2&a=3") })
		const first = ctx.search
		expect(first).toEqual({ a: "1", b: "2" })
		expect(ctx.search).toBe(first)
	})

	// v0: 3304c135a8
	it("headers lowercased on first access, cached", () => {
		const ctx = makeCtx({ req: makeReq("http://localhost/test", { "X-Custom": "val" }) })
		expect(ctx.headers["x-custom"]).toBe("val")
		expect(ctx.headers).toBe(ctx.headers)
	})

	// v0: a94cba5f31
	it("cookies parsed on first access, cached", () => {
		const ctx = makeCtx({ req: makeReq("http://localhost/test", { cookie: "a=1; b=2" }) })
		expect(ctx.cookies).toEqual({ a: "1", b: "2" })
		expect(ctx.cookies).toBe(ctx.cookies)
	})

	// v0: 60203bf331
	it("search returns first value, searchAll returns all", () => {
		const ctx = makeCtx({ req: makeReq("http://localhost/test?tag=a&tag=b&page=1") })
		expect(ctx.search).toEqual({ page: "1", tag: "a" })
		expect(ctx.searchAll).toEqual({ page: ["1"], tag: ["a", "b"] })
	})
})

describe("HoneyContext — background", () => {
	// v0: aaa3a51277
	it("delegates to executionCtx.waitUntil", () => {
		const waitUntil = vi.fn<(p: Promise<unknown>) => void>()
		const p = Promise.resolve()
		makeCtx({ executionCtx: { waitUntil } }).background(p)
		expect(waitUntil).toHaveBeenCalledWith(p)
	})

	// v0: 1938d91347
	it("fire-and-forget without waitUntil", () => {
		expect(() => makeCtx().background(Promise.reject(new Error("test")))).not.toThrow()
	})
})

describe("HoneyContext — response helpers", () => {
	// v0: 4276efecb7
	it("json(ok, data) → 200 application/json", () => {
		const res = makeCtx().res.json("ok", { id: 1 })
		expect([res.status, res.headers.get("content-type")]).toEqual([200, "application/json"])
	})

	// v0: 0cd028f1d7
	it("json(created, data) → 201", () => {
		expect(makeCtx().res.json("created", {}).status).toBe(201)
	})

	// v0: 1da781408a
	it("json with custom headers", () => {
		expect(
			makeCtx()
				.res.json("ok", {}, { headers: { "x-custom": "val" } })
				.headers.get("x-custom"),
		).toBe("val")
	})

	// v0: b89138f0aa
	it("text(hello) → 200 text/plain", async () => {
		const res = makeCtx().res.text("ok", "hello")
		expect(res.headers.get("content-type")).toContain("text/plain")
		expect([res.status, await res.text()]).toEqual([200, "hello"])
	})

	// v0: d7abc8456b
	it("noContent → 204", () => {
		expect(makeCtx().res.noContent().status).toBe(204)
	})

	// v0: f73edeefbf
	it("redirect(/x) → 302", () => {
		const res = makeCtx().res.redirect("/x")
		expect([res.status, res.headers.get("location")]).toEqual([302, "/x"])
	})

	// v0: 511cc3ba03
	it("redirect with status 307", () => {
		expect(makeCtx().res.redirect("/x", { status: 307 }).status).toBe(307)
	})
})

describe("HoneyContext — response helpers: html and cookies", () => {
	// v0: 70311d6b4b
	it("html → 200 text/html", async () => {
		const res = makeCtx().res.html("ok", "<h1>hi</h1>")
		expect(res.headers.get("content-type")).toContain("text/html")
		expect(await res.text()).toBe("<h1>hi</h1>")
	})

	// v0: dcabf119de
	it("cookie serialization", () => {
		const session = {
			domain: ".example.com",
			httpOnly: true,
			maxAge: 86400,
			path: "/",
			sameSite: "strict",
			secure: true,
			value: "abc",
		} as const
		const cookie = makeCtx().res.json("ok", {}, { cookies: { session } }).headers.get("set-cookie")
		for (const part of [
			"session=abc",
			"HttpOnly",
			"Secure",
			"Max-Age=86400",
			"SameSite=Strict",
			"Domain=.example.com",
			"Path=/",
		]) {
			expect(cookie).toContain(part)
		}
	})

	// v0: e54fcf4bd5
	it("cookie deletion: maxAge 0", () => {
		expect(
			makeCtx()
				.res.json("ok", {}, { cookies: { session: { maxAge: 0, value: "" } } })
				.headers.get("set-cookie"),
		).toContain("Max-Age=0")
	})
})
