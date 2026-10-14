import { describe, expect, it } from "vitest"
import { serializeCookie } from "../context/cookie.ts"
import { isHoneyResponse, rawBodyOf } from "./builder.ts"
import { HoneyRes } from "./response.ts"

const res = new HoneyRes()

describe("HoneyRes > json", () => {
	// v0: a07820cbf9
	it("returns Response with application/json content-type", async () => {
		const response = res.json("ok", { id: 1 })
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("application/json")
		expect(await response.json()).toEqual({ id: 1 })
	})

	// v0: 7caa6b9ffb
	it("maps status key to correct HTTP status code", () => {
		expect(res.json("created", {}).status).toBe(201)
		expect(res.json("not_found", {}).status).toBe(404)
		expect(res.json("internal_server_error", {}).status).toBe(500)
	})

	// v0: e265953b21
	it("applies custom headers from options", () => {
		const response = res.json("ok", {}, { headers: { "x-custom": "val" } })
		expect(response.headers.get("x-custom")).toBe("val")
	})

	// v0: 53ca72f246
	it("applies cookies from options", () => {
		const response = res.json(
			"ok",
			{},
			{
				cookies: { session: { httpOnly: true, value: "abc123" } },
			},
		)
		const cookie = response.headers.get("set-cookie")
		expect(cookie).toContain("session=abc123")
		expect(cookie).toContain("HttpOnly")
	})
})

describe("HoneyRes > text", () => {
	// v0: 7f99cd7b75
	it("returns Response with text/plain content-type and status from key", async () => {
		const response = res.text("ok", "hello")
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
		expect(await response.text()).toBe("hello")
	})

	// v0: d211912876
	it("maps status key to HTTP status code", () => {
		expect(res.text("created", "done").status).toBe(201)
		expect(res.text("accepted", "queued").status).toBe(202)
	})
})

describe("HoneyRes > html", () => {
	// v0: 799e851332
	it("returns Response with text/html content-type and status from key", async () => {
		const response = res.html("ok", "<h1>hi</h1>")
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
		expect(await response.text()).toBe("<h1>hi</h1>")
	})
})

describe("HoneyRes > xml", () => {
	// v0: f695a4237e
	it("returns Response with application/xml content-type", async () => {
		const response = res.xml("ok", "<root><item>1</item></root>")
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("application/xml")
		expect(await response.text()).toBe("<root><item>1</item></root>")
	})
})

describe("HoneyRes > csv", () => {
	// v0: 3d9489273a
	it("returns Response with text/csv content-type", async () => {
		const response = res.csv("ok", "name,age\nAlice,30")
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8")
		expect(await response.text()).toBe("name,age\nAlice,30")
	})
})

describe("HoneyRes > noContent", () => {
	// v0: f0c7183d59
	it("returns 204 with null body", () => {
		const response = res.noContent()
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(204)
		expect(response.body).toBeNull()
	})
})

describe("HoneyRes > redirect", () => {
	// v0: 9100f11b22
	it("returns 302 with location header by default", () => {
		const response = res.redirect("/new")
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(302)
		expect(response.headers.get("location")).toBe("/new")
	})

	// v0: 09ae17016b
	it("supports custom status via opts", () => {
		const response = res.redirect("/new", { status: 307 })
		expect(response.status).toBe(307)
	})
})

describe("HoneyRes > raw", () => {
	// v0: a68f79eb2b
	it("returns the response as TypedResponse", async () => {
		const plain = new Response("proxied", { status: 200 })
		const response = res.raw(plain)
		expect(response).toBeInstanceOf(Response)
		expect(response.status).toBe(200)
		expect(await response.text()).toBe("proxied")
	})

	// v0: b4066894fa
	it("copies a response with immutable headers so they can be set", async () => {
		/* fetch(), Fetcher.fetch, cache.match, and Response.redirect return guarded headers */
		const guarded = Response.redirect("https://example.com/next", 302)
		expect(() => guarded.headers.set("x-request-id", "a")).toThrow(TypeError)
		const response = res.raw(guarded)
		response.headers.set("x-request-id", "a")
		expect(response.headers.get("x-request-id")).toBe("a")
		expect(response.status).toBe(302)
		expect(response.headers.get("location")).toBe("https://example.com/next")
	})

	// v0: 81e21b1f3b
	it("keeps status, statusText, headers, and the streamed body", async () => {
		const plain = new Response("asset", {
			headers: { "content-type": "application/json", etag: '"v1"' },
			status: 203,
			statusText: "From Asset",
		})
		const response = res.raw(plain)
		expect(response.status).toBe(203)
		expect(response.statusText).toBe("From Asset")
		expect(response.headers.get("content-type")).toBe("application/json")
		expect(response.headers.get("etag")).toBe('"v1"')
		expect(await response.text()).toBe("asset")
	})

	// v0: a7371abdfc
	it("returns a WebSocket upgrade unchanged", () => {
		const upgrade = new Response(null, { status: 200 })
		Object.defineProperty(upgrade, "status", { value: 101 })
		expect(res.raw(upgrade)).toBe(upgrade)
	})

	// v0: a7f88979aa
	it("returns a response Honey built unchanged", () => {
		const built = res.json("ok", { id: 1 })
		expect(res.raw(built)).toBe(built)
	})
})

describe("HoneyRes > cookie serialization", () => {
	// v0: 9cb78022d1
	it("encodes special characters in cookie value", () => {
		const cookie = serializeCookie("msg", { value: "hello world" })
		/* space is not a valid cookie-octet — must be percent-encoded */
		expect(cookie).not.toContain("hello world")
		expect(cookie).toContain("hello%20world")
	})

	// v0: 7750e4ac8f
	it("encodes semicolons in cookie value", () => {
		const cookie = serializeCookie("data", { value: "a;b" })
		expect(cookie).not.toContain("a;b")
		expect(cookie).toContain("a%3Bb")
	})

	// v0: 75c679a2fe
	it("preserves safe cookie-octet characters", () => {
		const cookie = serializeCookie("token", { value: "abc123-_.~" })
		expect(cookie).toBe("token=abc123-_.~")
	})
})

describe("HoneyRes > cookie name validation", () => {
	// v0: e02e3900ee
	it("valid name → no error", () => {
		expect(() => serializeCookie("valid_name", { value: "x" })).not.toThrow()
	})

	// v0: 451fc6704f
	it("valid name with special chars → no error", () => {
		expect(() => serializeCookie("also-valid.name", { value: "x" })).not.toThrow()
	})

	// v0: 55497e815c
	it("space in name → throws", () => {
		expect(() => serializeCookie("bad name", { value: "x" })).toThrow()
	})

	// v0: 37735249bb
	it("semicolon in name → throws", () => {
		expect(() => serializeCookie("bad;name", { value: "x" })).toThrow()
	})

	// v0: 01cbac5c85
	it("equals in name → throws", () => {
		expect(() => serializeCookie("bad=name", { value: "x" })).toThrow()
	})

	// v0: 612ba20416
	it("tab in name → throws", () => {
		expect(() => serializeCookie("bad\tname", { value: "x" })).toThrow()
	})

	// v0: 3bef1e472e
	it("empty name → throws", () => {
		expect(() => serializeCookie("", { value: "x" })).toThrow()
	})

	// v0: af8eee528a
	it("comma in name → throws", () => {
		expect(() => serializeCookie("bad,name", { value: "x" })).toThrow()
	})
})

describe("HoneyRes > cookie expires validation", () => {
	// v0: 8ec07e2fe0
	it("valid Date → Expires header present", () => {
		const cookie = serializeCookie("s", { expires: new Date("2030-01-01"), value: "x" })
		expect(cookie).toContain("Expires=")
		expect(cookie).not.toContain("Invalid Date")
	})

	// v0: b3e8705bfe
	it("invalid Date → throws", () => {
		expect(() => serializeCookie("s", { expires: new Date("invalid"), value: "x" })).toThrow()
	})
})

describe("HoneyRes > cookie path/domain injection prevention", () => {
	// v0: 3a6be2952e
	it("path with semicolon → throws", () => {
		expect(() => serializeCookie("s", { path: "/; Secure; HttpOnly", value: "x" })).toThrow()
	})

	// v0: 4fd3f7f538
	it("path with CRLF → throws", () => {
		expect(() => serializeCookie("s", { path: "/\r\nX-Injected: yes", value: "x" })).toThrow()
	})

	// v0: 760a6c9347
	it("domain with semicolon → throws", () => {
		expect(() => serializeCookie("s", { domain: "evil.com; Path=/", value: "x" })).toThrow()
	})

	// v0: 84a8323bad
	it("domain with CRLF → throws", () => {
		expect(() => serializeCookie("s", { domain: "evil.com\r\nX-Injected: yes", value: "x" })).toThrow()
	})

	// v0: 5a721126c3
	it("path with normal value → no error", () => {
		expect(() => serializeCookie("s", { path: "/api/v1", value: "x" })).not.toThrow()
	})

	// v0: 23b65028a6
	it("domain with normal value → no error", () => {
		expect(() => serializeCookie("s", { domain: ".example.com", value: "x" })).not.toThrow()
	})
})

describe("HoneyRes > cookie prefix validation", () => {
	// v0: 1ca1590427
	it("__Host- with secure + path=/ → valid", () => {
		expect(() => serializeCookie("__Host-session", { path: "/", secure: true, value: "abc" })).not.toThrow()
	})

	// v0: 72a3784846
	it("__Host- without secure → throws", () => {
		expect(() => serializeCookie("__Host-session", { value: "abc" })).toThrow("__Host-")
	})

	// v0: e559b68f33
	it("__Host- with domain → throws", () => {
		expect(() =>
			serializeCookie("__Host-session", {
				domain: "example.com",
				secure: true,
				value: "abc",
			}),
		).toThrow("__Host-")
	})

	// v0: e64fa6a7d3
	it("__Host- with path=/api → throws", () => {
		expect(() => serializeCookie("__Host-session", { path: "/api", secure: true, value: "abc" })).toThrow("__Host-")
	})

	// v0: 1889abf7bd
	it("__Host- with no path → auto-sets /", () => {
		const cookie = serializeCookie("__Host-session", { secure: true, value: "abc" })
		expect(cookie).toContain("Path=/")
	})

	// v0: 1fc20c6185
	it("__Secure- with secure → valid", () => {
		expect(() => serializeCookie("__Secure-token", { secure: true, value: "xyz" })).not.toThrow()
	})

	// v0: 7c486e5769
	it("__Secure- without secure → throws", () => {
		expect(() => serializeCookie("__Secure-token", { value: "xyz" })).toThrow("__Secure-")
	})

	// v0: 06320b684a
	it("normal cookie name → no prefix validation", () => {
		expect(() => serializeCookie("session", { value: "abc" })).not.toThrow()
	})
})

describe("HoneyRes — custom headers + cookies branches", () => {
	const honeyRes = new HoneyRes()
	const opts = {
		cookies: { token: { httpOnly: true, value: "abc" } },
		headers: { "x-req-id": "42" },
	}

	// v0: d69dfbdd74
	it("csv() with custom headers + cookies", async () => {
		const response = honeyRes.csv("ok", "a,b\n1,2", opts)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8")
		expect(response.headers.get("x-req-id")).toBe("42")
		expect(response.headers.get("set-cookie")).toContain("token=abc")
		expect(await response.text()).toBe("a,b\n1,2")
	})

	// v0: 497c097810
	it("html() with custom headers + cookies", async () => {
		const response = honeyRes.html("ok", "<p>hi</p>", opts)
		expect(response.status).toBe(200)
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8")
		expect(response.headers.get("x-req-id")).toBe("42")
		expect(response.headers.get("set-cookie")).toContain("token=abc")
		expect(await response.text()).toBe("<p>hi</p>")
	})
})

describe("HoneyResponse", () => {
	// v0: aea1af3ba3
	it("json/text skip native Response when nodeOut is set", async () => {
		const nodeRes = new HoneyRes(true)
		const json = nodeRes.json("ok", { message: "Hello, World!" })
		expect(isHoneyResponse(json)).toBe(true)
		expect(Object.getPrototypeOf(json) === Response.prototype).toBe(false)
		expect(json.status).toBe(200)
		expect(json.headers.get("content-type")).toBe("application/json")
		expect(await json.json()).toEqual({ message: "Hello, World!" })

		const text = nodeRes.text("created", "hi")
		expect(isHoneyResponse(text)).toBe(true)
		expect(text.status).toBe(201)
		expect(await text.text()).toBe("hi")
	})
})

describe("HoneyRes on Node builds the bag with options", () => {
	const nodeRes = new HoneyRes(true)

	it("lower-cases option headers and appends cookies after a set-cookie header", async () => {
		const opts = { cookies: { b: { value: "2" } }, headers: { "Set-Cookie": "a=1", "X-A": "1" } }
		const response = nodeRes.json("ok", 1, opts)
		expect(response.headers.get("x-a")).toBe("1")
		expect(response.headers.getSetCookie()).toEqual(["a=1", "b=2"])
		expect(await response.json()).toBe(1)
		expect(nodeRes.text("ok", "x", { cookies: { c: { value: "3" } } }).headers.getSetCookie()).toEqual(["c=3"])
	})

	it("noContent and redirect build an empty bag", async () => {
		const empty = nodeRes.noContent({ headers: { "x-a": "1" } })
		expect(isHoneyResponse(empty)).toBe(true)
		expect(empty.status).toBe(204)
		expect(empty.headers.get("x-a")).toBe("1")
		expect(await empty.text()).toBe("")
		const moved = nodeRes.redirect("/next", { status: 301 })
		expect(moved.status).toBe(301)
		expect(moved.headers.get("location")).toBe("/next")
	})

	it("the shared content-type maps stay unchanged", () => {
		nodeRes.json("ok", 1, { headers: { "x-a": "1" } })
		expect(nodeRes.json("ok", 1).headers.get("x-a")).toBeNull()
	})
})

describe("HoneyRes status and raw body", () => {
	it("a body on a null-body status throws on every path", () => {
		for (const helper of [new HoneyRes(), new HoneyRes(true)]) {
			for (const status of [101, 103, 204, 205, 304]) {
				expect(() => helper.json("ok", 1, { status })).toThrow(`A ${status} response cannot have a body`)
			}
		}
	})

	it("opts.status overrides the status key", () => {
		expect(res.text("ok", "x", { status: 299 }).status).toBe(299)
	})

	it("records the raw body without a property on the response", () => {
		const response = res.json("ok", { id: 1 })
		expect(rawBodyOf(response)).toBe('{"id":1}')
		expect(Object.getOwnPropertySymbols(response)).toEqual([])
		expect(rawBodyOf(res.html("ok", "<p/>", { headers: { "x-a": "1" } }))).toBe("<p/>")
	})

	it("noContent applies options on the native path", () => {
		const empty = res.noContent({ cookies: { a: { value: "1" } }, headers: { "x-a": "1" } })
		expect(empty.headers.get("x-a")).toBe("1")
		expect(empty.headers.getSetCookie()).toEqual(["a=1"])
	})
})
