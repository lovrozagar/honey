import { describe, expect, it } from "vitest"
import { honey } from "../../src/routing/app.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { serializeCookie } from "../../src/context/cookie.ts"

describe("cookie name regex validation", () => {
	// v0: ece34ba16b
	it("alphanumeric name → valid", () => {
		expect(() => serializeCookie("session123", { value: "x" })).not.toThrow()
	})

	// v0: 12a8441d56
	it("name with hyphens and underscores → valid", () => {
		expect(() => serializeCookie("my-cookie_name", { value: "x" })).not.toThrow()
	})

	// v0: 359ff28b79
	it("name with spaces → invalid", () => {
		expect(() => serializeCookie("bad name", { value: "x" })).toThrow()
	})

	// v0: a229bb2e6e
	it("name with = → invalid", () => {
		expect(() => serializeCookie("bad=name", { value: "x" })).toThrow()
	})

	// v0: 0aeba08f6e
	it("name with ; → invalid", () => {
		expect(() => serializeCookie("bad;name", { value: "x" })).toThrow()
	})

	// v0: 156640eaba
	it("empty name → invalid", () => {
		expect(() => serializeCookie("", { value: "x" })).toThrow()
	})
})

describe("ctx.cookies caching", () => {
	// v0: 0d29d15044
	it("multiple accesses return same object reference", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => {
			const c1 = ctx.cookies
			const c2 = ctx.cookies
			return ctx.res.json("ok", { same: c1 === c2, val: c1.session })
		})

		const res = await app.fetch(
			new Request("http://localhost/test", {
				headers: { cookie: "session=abc" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.same).toBe(true)
		expect(data.val).toBe("abc")
	})
})

describe("cookie serialization — __Host- prefix", () => {
	// v0: 1a836ba61c
	it("__Host- cookie requires secure: true", () => {
		expect(() => serializeCookie("__Host-session", { value: "abc" })).toThrow("__Host- cookies require secure: true")
	})

	// v0: 08817ca50f
	it("__Host- cookie must not set domain", () => {
		expect(() => serializeCookie("__Host-session", { domain: "example.com", secure: true, value: "abc" })).toThrow(
			"__Host- cookies must not set domain",
		)
	})

	// v0: e3f7aa8a13
	it("__Host- cookie auto-sets path to /", () => {
		const cookie = serializeCookie("__Host-session", { secure: true, value: "abc" })
		expect(cookie).toContain("Path=/")
		expect(cookie).toContain("Secure")
	})

	// v0: 079fbe5355
	it("__Host- cookie with explicit path=/ works", () => {
		const cookie = serializeCookie("__Host-session", { path: "/", secure: true, value: "abc" })
		expect(cookie).toContain("Path=/")
	})

	// v0: 4e2862707c
	it("__Host- cookie with path=/sub rejects", () => {
		expect(() => serializeCookie("__Host-session", { path: "/sub", secure: true, value: "abc" })).toThrow(
			"__Host- cookies must have path",
		)
	})
})

describe("cookie serialization — __Secure- prefix", () => {
	// v0: db00d8ea00
	it("__Secure- cookie requires secure: true", () => {
		expect(() => serializeCookie("__Secure-tok", { value: "abc" })).toThrow("__Secure- cookies require secure: true")
	})

	// v0: 90472b5873
	it("__Secure- cookie with secure: true works", () => {
		const cookie = serializeCookie("__Secure-tok", { secure: true, value: "abc" })
		expect(cookie).toContain("__Secure-tok=abc")
		expect(cookie).toContain("Secure")
	})
})

describe("cookie serialization — SameSite=None", () => {
	// v0: ce5bc350cf
	it("SameSite=None without Secure → throws", () => {
		expect(() => serializeCookie("test", { sameSite: "none", value: "abc" })).toThrow(
			"SameSite=None cookies require secure: true",
		)
	})

	// v0: ef40476dcb
	it("SameSite=None with Secure → works", () => {
		const cookie = serializeCookie("test", { sameSite: "none", secure: true, value: "abc" })
		expect(cookie).toContain("SameSite=None")
		expect(cookie).toContain("Secure")
	})
})

describe("cookie serialization — special values", () => {
	// v0: dded716d7b
	it("cookie value with spaces is percent-encoded", () => {
		const cookie = serializeCookie("msg", { value: "hello world" })
		expect(cookie).toContain("msg=hello%20world")
	})

	// v0: b1ef864500
	it("cookie value with semicolons is percent-encoded", () => {
		const cookie = serializeCookie("data", { value: "a;b;c" })
		expect(cookie).toContain("data=a%3Bb%3Bc")
	})

	// v0: c672e080d0
	it("invalid cookie name throws", () => {
		expect(() => serializeCookie("bad name", { value: "x" })).toThrow("Invalid cookie name")
	})

	// v0: 691690c966
	it("maxAge 0 is valid (immediate expiry)", () => {
		const cookie = serializeCookie("session", { maxAge: 0, value: "x" })
		expect(cookie).toContain("Max-Age=0")
	})

	// v0: 76bcf6013e
	it("maxAge Infinity throws", () => {
		expect(() => serializeCookie("test", { maxAge: Infinity, value: "x" })).toThrow("Invalid cookie Max-Age")
	})

	// v0: 2cbe4d1b56
	it("maxAge NaN throws", () => {
		expect(() => serializeCookie("test", { maxAge: NaN, value: "x" })).toThrow("Invalid cookie Max-Age")
	})

	// v0: 1b05d3ca4e
	it("maxAge negative throws", () => {
		expect(() => serializeCookie("test", { maxAge: -1, value: "x" })).toThrow("Invalid cookie Max-Age")
	})

	// v0: cd2f470bf5
	it("expires date serialized", () => {
		const date = new Date("2030-01-01T00:00:00Z")
		const cookie = serializeCookie("test", { expires: date, value: "x" })
		expect(cookie).toContain("Expires=")
		expect(cookie).toContain("2030")
	})
})

describe("cookie value encoding", () => {
	// v0: 3b4d5015e7
	it("emoji in cookie value → percent-encoded", () => {
		const cookie = serializeCookie("emoji", { value: "🍯" })
		expect(cookie).not.toContain("🍯")
		expect(cookie).toContain("emoji=")
		/* should be percent-encoded */
		expect(cookie).toContain("%")
	})

	// v0: 74c631eef8
	it("plain ASCII value → no encoding needed", () => {
		const cookie = serializeCookie("simple", { value: "abc123" })
		expect(cookie).toBe("simple=abc123")
	})

	// v0: e91bf4dcee
	it("value with comma → percent-encoded", () => {
		const cookie = serializeCookie("list", { value: "a,b,c" })
		expect(cookie).toContain("list=a%2Cb%2Cc")
	})
})

describe("cookie value encoding — multi-byte", () => {
	// v0: d9c2c8b2f1
	it("CJK characters encoded correctly", () => {
		const cookie = serializeCookie("lang", { value: "日本語" })
		expect(cookie).toContain("lang=")
		/* should be percent-encoded, not raw CJK */
		expect(cookie).toContain("%")
		expect(cookie).not.toContain("日")
	})

	// v0: 1bf111f8c0
	it("mixed ASCII + emoji", () => {
		const cookie = serializeCookie("mood", { value: "happy🎉" })
		expect(cookie).toContain("happy")
		expect(cookie).toContain("%")
	})

	// v0: f5645f854e
	it("empty value → no encoding needed", () => {
		const cookie = serializeCookie("empty", { value: "" })
		expect(cookie).toBe("empty=")
	})

	// v0: 0e3854798a
	it("tab character encoded", () => {
		const cookie = serializeCookie("data", { value: "a\tb" })
		expect(cookie).toContain("%09")
	})
})

describe("cookie parsing edge cases", () => {
	// v0: 4ba5c0a7d6
	it("cookie with = in value → full value preserved", async () => {
		const app = honey<{}>()
		app.get("/read").handler((ctx) => ctx.res.json("ok", { token: ctx.cookies.token }))

		const res = await app.fetch(
			new Request("http://localhost/read", {
				headers: { cookie: "token=abc=def=ghi" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.token).toBe("abc=def=ghi")
	})

	// v0: 6b31db1278
	it("cookie with empty value → empty string", async () => {
		const app = honey<{}>()
		app.get("/read").handler((ctx) => ctx.res.json("ok", { val: ctx.cookies.empty }))

		const res = await app.fetch(
			new Request("http://localhost/read", {
				headers: { cookie: "empty=; other=val" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, string>
		expect(data.val).toBe("")
	})

	// v0: 6a1f31a18b
	it("cookie with no = sign → skipped", async () => {
		const app = honey<{}>()
		app.get("/read").handler((ctx) =>
			ctx.res.json("ok", {
				count: Object.keys(ctx.cookies).length,
				valid: ctx.cookies.valid,
			}),
		)

		const res = await app.fetch(
			new Request("http://localhost/read", {
				headers: { cookie: "malformed; valid=yes; also_bad" },
			}),
			{},
		)
		expect(res.status).toBe(200)
		const data = (await res.json()) as Record<string, unknown>
		expect(data.valid).toBe("yes")
		expect(data.count).toBe(1)
	})
})

describe("cookie maxAge validation", () => {
	// v0: c734f34a75
	it("maxAge NaN → throws", async () => {
		const app = honey<{}>()
		app.get("/cookie").handler((ctx) => ctx.res.json("ok", {}, { cookies: { s: { maxAge: NaN, value: "x" } } }))

		expect((await app.fetch(new Request("http://localhost/cookie"), {})).status).toBe(500)
	})

	// v0: d590069cbb
	it("maxAge Infinity → throws", async () => {
		const app = honey<{}>()
		app.get("/cookie").handler((ctx) => ctx.res.json("ok", {}, { cookies: { s: { maxAge: Infinity, value: "x" } } }))

		expect((await app.fetch(new Request("http://localhost/cookie"), {})).status).toBe(500)
	})

	// v0: 6d78df0457
	it("maxAge negative → throws", async () => {
		const app = honey<{}>()
		app.get("/cookie").handler((ctx) => ctx.res.json("ok", {}, { cookies: { s: { maxAge: -1, value: "x" } } }))

		expect((await app.fetch(new Request("http://localhost/cookie"), {})).status).toBe(500)
	})

	// v0: fabdb78fb9
	it("maxAge 0 → valid (immediate expiry)", async () => {
		const app = honey<{}>()
		app.get("/cookie").handler((ctx) => ctx.res.json("ok", {}, { cookies: { s: { maxAge: 0, value: "x" } } }))

		expect((await app.fetch(new Request("http://localhost/cookie"), {})).status).toBe(200)
	})
})

describe("cookie attributes", () => {
	// v0: df99fd5bfb
	it("httpOnly cookie → Set-Cookie contains HttpOnly", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}, { cookies: { sid: { httpOnly: true, value: "tok" } } }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const cookies = res.headers.getSetCookie()
		expect(cookies.some((c) => c.includes("HttpOnly"))).toBe(true)
	})

	// v0: b5e16f1644
	it("secure cookie → Set-Cookie contains Secure", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}, { cookies: { sid: { secure: true, value: "tok" } } }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const cookies = res.headers.getSetCookie()
		expect(cookies.some((c) => c.includes("Secure"))).toBe(true)
	})

	// v0: 0d85f532d3
	it("sameSite=strict → Set-Cookie contains SameSite=Strict", async () => {
		const app = honey<{}>()
		app
			.get("/test")
			.handler((ctx) => ctx.res.json("ok", {}, { cookies: { sid: { sameSite: "strict", value: "tok" } } }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const cookies = res.headers.getSetCookie()
		expect(cookies.some((c) => c.includes("SameSite=Strict"))).toBe(true)
	})

	// v0: 8f7e060744
	it("maxAge → Set-Cookie contains Max-Age", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) => ctx.res.json("ok", {}, { cookies: { sid: { maxAge: 3600, value: "tok" } } }))

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const cookies = res.headers.getSetCookie()
		expect(cookies.some((c) => c.includes("Max-Age=3600"))).toBe(true)
	})
})

describe("cookie attributes (2)", () => {
	// v0: d52cc14e31
	it("path + domain → Set-Cookie contains both", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: {
						sid: { domain: "example.com", path: "/app", value: "tok" },
					},
				},
			),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const cookies = res.headers.getSetCookie()
		const sid = cookies.find((c) => c.startsWith("sid="))
		expect(sid).toContain("Path=/app")
		expect(sid).toContain("Domain=example.com")
	})
})

describe("cookie attributes (3)", () => {
	// v0: 4eddca8e68
	it("multiple cookies with different attributes", async () => {
		const app = honey<{}>()
		app.get("/test").handler((ctx) =>
			ctx.res.json(
				"ok",
				{},
				{
					cookies: {
						csrf: { sameSite: "strict", value: "csrf-tok" },
						session: {
							httpOnly: true,
							maxAge: 86400,
							secure: true,
							value: "sess-tok",
						},
					},
				},
			),
		)

		const res = await app.fetch(new Request("http://localhost/test"), {})
		const cookies = res.headers.getSetCookie()
		expect(cookies.length).toBe(2)

		const session = cookies.find((c) => c.startsWith("session="))
		expect(session).toContain("HttpOnly")
		expect(session).toContain("Secure")
		expect(session).toContain("Max-Age=86400")

		const csrf = cookies.find((c) => c.startsWith("csrf="))
		expect(csrf).toContain("SameSite=Strict")
	})
})

describe("cookies preserved in error responses", () => {
	// v0: 4e6984c802
	it("middleware sets cookie → error thrown → cookie still in response", async () => {
		/* the boundary turns the throw into a response first, so the middleware's post-next() cookie lands on it */
		const setCookieMw = createMiddleware(async (_ctx, next) => {
			const res = await next()
			res.headers.append("set-cookie", serializeCookie("sid", { httpOnly: true, value: "kept" }))
			return res
		})
		const app = honey<{}>()
		app
			.use(setCookieMw)
			.get("/fail")
			.handler(() => {
				throw new Error("boom")
			})
		const res = await app.fetch(new Request("http://localhost/fail"), {})
		expect(res.status).toBe(500)
		expect(res.headers.get("set-cookie")).toBe("sid=kept; HttpOnly")
		expect(((await res.json()) as Record<string, unknown>).error_key).toBe("internal_server_error")
	})
})
