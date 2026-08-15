import { describe, expect, it, vi } from "vitest"
import { HoneyContext } from "../../../src/context.ts"

function makeReq(url = "http://localhost/test", headers?: Record<string, string>): Request {
	return new Request(url, { headers })
}

function makeCtx(overrides?: Partial<ConstructorParameters<typeof HoneyContext>[0]>) {
	return new HoneyContext({
		env: { DB: "test" },
		params: { id: "42" },
		req: makeReq(),
		...overrides,
	})
}

describe("HoneyContext", () => {
	describe("constructor", () => {
		it("assigns env directly", () => {
			const env = { DB: "prod" }
			const ctx = makeCtx({ env })
			expect(ctx.env).toBe(env)
		})

		it("assigns params directly", () => {
			const params = { id: "99" }
			const ctx = makeCtx({ params })
			expect(ctx.params).toBe(params)
		})

		it("assigns req directly", () => {
			const req = makeReq("http://example.com/path")
			const ctx = makeCtx({ req })
			expect(ctx.req).toBe(req)
		})

		it("assigns res as a HoneyRes instance", () => {
			const ctx = makeCtx()
			expect(ctx.res).toBeDefined()
			expect(typeof ctx.res.json).toBe("function")
			expect(typeof ctx.res.text).toBe("function")
		})
	})

	describe("defaults", () => {
		it("path defaults to empty string", () => {
			const ctx = makeCtx()
			expect(ctx.path).toBe("")
		})

		it("routePattern defaults to empty string", () => {
			const ctx = makeCtx()
			expect(ctx.routePattern).toBe("")
		})

		it("meta defaults to frozen empty object", () => {
			const ctx = makeCtx()
			expect(ctx.meta).toEqual({})
			expect(Object.isFrozen(ctx.meta)).toBe(true)
		})

		it("executionCtx is undefined by default", () => {
			const ctx = makeCtx()
			expect(ctx.executionCtx).toBeUndefined()
		})
	})

	describe("background", () => {
		it("delegates to executionCtx.waitUntil when provided", () => {
			const waitUntil = vi.fn<(p: Promise<unknown>) => void>()
			const ctx = makeCtx({ executionCtx: { waitUntil } })
			const p = Promise.resolve("done")
			ctx.background(p)
			expect(waitUntil).toHaveBeenCalledOnce()
			/* verify the promise was passed through */
			expect(waitUntil.mock.calls[0][0]).toBe(p)
		})

		it("swallows rejected promises when no waitUntil", async () => {
			const ctx = makeCtx()
			/* should not throw — bgSwallow catches the rejection */
			ctx.background(Promise.reject(new Error("ignored")))
			/* allow microtask to process the rejection */
			await new Promise((resolve) => setTimeout(resolve, 10))
		})
	})

	describe("lazy cookies", () => {
		it("not parsed until accessed", () => {
			const ctx = makeCtx({ req: makeReq("http://localhost/test", { cookie: "a=1" }) })
			expect(ctx._lzCookies).toBeNull()
		})

		it("parsed correctly from cookie header", () => {
			const ctx = makeCtx({ req: makeReq("http://localhost/test", { cookie: "a=1; b=hello" }) })
			expect(ctx.cookies).toEqual({ a: "1", b: "hello" })
		})

		it("cached after first access (same reference)", () => {
			const ctx = makeCtx({ req: makeReq("http://localhost/test", { cookie: "x=y" }) })
			const first = ctx.cookies
			const second = ctx.cookies
			expect(first).toBe(second)
		})

		it("empty object when no cookie header", () => {
			const ctx = makeCtx()
			expect(ctx.cookies).toEqual({})
		})
	})

	describe("lazy headers", () => {
		it("not parsed until accessed", () => {
			const ctx = makeCtx()
			expect(ctx._lzHeaders).toBeNull()
		})

		it("converts Headers to Record correctly", () => {
			const ctx = makeCtx({
				req: makeReq("http://localhost/test", {
					"content-type": "application/json",
					"x-custom": "value",
				}),
			})
			const h = ctx.headers
			expect(h["content-type"]).toBe("application/json")
			expect(h["x-custom"]).toBe("value")
		})

		it("cached after first access", () => {
			const ctx = makeCtx({
				req: makeReq("http://localhost/test", { "x-test": "1" }),
			})
			const first = ctx.headers
			const second = ctx.headers
			expect(first).toBe(second)
		})
	})

	describe("lazy search", () => {
		it("not parsed until accessed", () => {
			const ctx = makeCtx()
			expect(ctx._lzSearch).toBeNull()
		})

		it("uses urlFn when provided", () => {
			const urlFn = vi.fn<() => URL>(() => new URL("http://localhost/test?from=urlFn"))
			const ctx = makeCtx({
				req: makeReq("http://localhost/test?from=request"),
				urlFn,
			})
			expect(ctx.search.from).toBe("urlFn")
			expect(urlFn).toHaveBeenCalledOnce()
		})

		it("falls back to new URL(req.url) when no urlFn", () => {
			const ctx = makeCtx({ req: makeReq("http://localhost/test?key=fallback") })
			expect(ctx.search.key).toBe("fallback")
		})

		it("single param returns string value", () => {
			const ctx = makeCtx({ req: makeReq("http://localhost/test?name=alice") })
			expect(ctx.search.name).toBe("alice")
		})

		it("multiple same params → search returns first value", () => {
			const ctx = makeCtx({ req: makeReq("http://localhost/test?tag=a&tag=b&tag=c") })
			expect(ctx.search.tag).toBe("a")
			expect(ctx.searchAll.tag).toEqual(["a", "b", "c"])
		})

		it("cached after first access", () => {
			const ctx = makeCtx({ req: makeReq("http://localhost/test?q=1") })
			const first = ctx.search
			const second = ctx.search
			expect(first).toBe(second)
		})
	})

	describe("errors property", () => {
		it("can be set after construction", () => {
			const ctx = makeCtx()
			const errors = { notFound: () => new Error("not found") }
			;(ctx as unknown as Record<string, unknown>).errors = errors
			expect(ctx.errors).toBe(errors)
		})
	})

	describe("meta", () => {
		it("is frozen (Object.isFrozen)", () => {
			const ctx = makeCtx()
			expect(Object.isFrozen(ctx.meta)).toBe(true)
		})

		it("accepts custom meta and preserves it", () => {
			const meta = Object.freeze({ version: "1.0" })
			const ctx = makeCtx({ meta })
			expect(ctx.meta).toBe(meta)
		})
	})
})
