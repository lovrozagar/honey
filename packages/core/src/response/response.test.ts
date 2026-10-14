/**
 * HoneyRes, the ctx.res helpers, outside any request: each body helper's status, content type and
 * body; options (headers, cookies, status) on every helper; noContent and redirect; raw(); the Node
 * path that skips the native Response; and the raw-body record. Cookie serialization rules are
 * pinned in tests/integration/cookie-codec.test.ts.
 */
import { describe, expect, it } from "vitest"
import { isHoneyResponse, rawBodyOf } from "./builder.ts"
import { HoneyRes, type ResponseOptions } from "./response.ts"

const res = new HoneyRes()

/** Every body helper: what it is called with, its content type, and the body it writes. */
const HELPERS = [
	["json", (r: HoneyRes, o?: ResponseOptions) => r.json("ok", { id: 1 }, o), "application/json", '{"id":1}'],
	["text", (r: HoneyRes, o?: ResponseOptions) => r.text("ok", "hello", o), "text/plain; charset=utf-8", "hello"],
	[
		"html",
		(r: HoneyRes, o?: ResponseOptions) => r.html("ok", "<h1>hi</h1>", o),
		"text/html; charset=utf-8",
		"<h1>hi</h1>",
	],
	["xml", (r: HoneyRes, o?: ResponseOptions) => r.xml("ok", "<root/>", o), "application/xml", "<root/>"],
	["csv", (r: HoneyRes, o?: ResponseOptions) => r.csv("ok", "a,b\n1,2", o), "text/csv; charset=utf-8", "a,b\n1,2"],
] as const

describe("body helpers", () => {
	// v0: a07820cbf9
	// v0: 7f99cd7b75
	// v0: 799e851332
	// v0: f695a4237e
	// v0: 3d9489273a
	// v0: 0a58fdc5a5
	// v0: 4d2e62acfe
	// v0: 794aeec471
	// v0: 9b9d66294a
	// v0: 8f2b994e56
	it.each(HELPERS)(
		"%s answers 200 with its content type and body, with no request in sight",
		async (_n, call, type, body) => {
			const response = call(new HoneyRes())
			expect(response).toBeInstanceOf(Response)
			expect([response.status, Object.fromEntries(response.headers), await response.text()]).toEqual([
				200,
				{ "content-type": type },
				body,
			])
		},
	)

	// v0: e265953b21
	// v0: 53ca72f246
	// v0: d69dfbdd74
	// v0: 497c097810
	// v0: 25cda3810d
	// v0: 8b7e6d5a31
	it.each(HELPERS)(
		"%s with headers and cookies keeps its content type, adds the headers and each cookie",
		async (_n, call, type, body) => {
			const response = call(res, {
				cookies: { session: { httpOnly: true, value: "abc" }, theme: { value: "dark" } },
				headers: { "x-req-id": "42" },
			})
			expect(response.headers.get("content-type")).toBe(type)
			expect(response.headers.get("x-req-id")).toBe("42")
			expect(response.headers.getSetCookie()).toEqual(["session=abc; HttpOnly", "theme=dark"])
			expect(await response.text()).toBe(body)
		},
	)
})

describe("status", () => {
	// v0: 7caa6b9ffb
	// v0: d211912876
	// v0: 33cccc4f70
	// v0: 7bcc1bb352
	it.each([
		["created", 201],
		["accepted", 202],
		["not_found", 404],
		["internal_server_error", 500],
	] as const)("the status key %s answers %i on every helper; opts.status overrides it", (key, code) => {
		expect([res.json(key, {}).status, res.text(key, "x").status, res.html(key, "x").status]).toEqual([code, code, code])
		expect(res.text(key, "x", { status: 299 }).status).toBe(299)
	})

	it("a body on a null-body status throws, on the native and the Node path", () => {
		for (const helper of [new HoneyRes(), new HoneyRes(true)])
			for (const status of [101, 103, 204, 205, 304])
				expect(() => helper.json("ok", 1, { status })).toThrow(`A ${status} response cannot have a body`)
	})
})

describe("noContent and redirect", () => {
	// v0: f0c7183d59
	it("noContent answers 204 with no body, and takes headers and cookies", () => {
		expect([res.noContent().status, res.noContent().body]).toEqual([204, null])
		const empty = res.noContent({ cookies: { a: { value: "1" } }, headers: { "x-a": "1" } })
		expect([empty.headers.get("x-a"), empty.headers.getSetCookie()]).toEqual(["1", ["a=1"]])
	})

	// v0: 9100f11b22
	// v0: 09ae17016b
	it("redirect answers 302 to the location, or the status the options give", () => {
		const found = res.redirect("/new")
		expect([found.status, found.headers.get("location")]).toEqual([302, "/new"])
		expect(res.redirect("/new", { status: 307 }).status).toBe(307)
	})
})

describe("raw()", () => {
	// v0: a68f79eb2b
	// v0: 81e21b1f3b
	it("keeps a plain response's status, statusText, headers and streamed body", async () => {
		const plain = new Response("asset", {
			headers: { "content-type": "application/json", etag: '"v1"' },
			status: 203,
			statusText: "From Asset",
		})
		const response = res.raw(plain)
		expect(response).toBeInstanceOf(Response)
		expect([response.status, response.statusText, response.headers.get("etag"), await response.text()]).toEqual([
			203,
			"From Asset",
			'"v1"',
			"asset",
		])
	})

	// v0: b4066894fa
	it("copies a response whose headers are immutable, so middleware can still set them", () => {
		/* fetch(), Fetcher.fetch, cache.match and Response.redirect return guarded headers */
		const guarded = Response.redirect("https://example.com/next", 302)
		expect(() => guarded.headers.set("x-request-id", "a")).toThrow(TypeError)
		const response = res.raw(guarded)
		response.headers.set("x-request-id", "a")
		expect([response.status, response.headers.get("location"), response.headers.get("x-request-id")]).toEqual([
			302,
			"https://example.com/next",
			"a",
		])
	})

	// v0: a7371abdfc
	// v0: a7f88979aa
	it("returns a WebSocket upgrade, or a response Honey built, unchanged", () => {
		const upgrade = new Response(null, { status: 200 })
		Object.defineProperty(upgrade, "status", { value: 101 })
		expect(res.raw(upgrade)).toBe(upgrade)
		const built = res.json("ok", { id: 1 })
		expect(res.raw(built)).toBe(built)
	})
})

describe("the Node path", () => {
	const nodeRes = new HoneyRes(true)

	// v0: aea1af3ba3
	it("json and text skip the native Response but read like one", async () => {
		const json = nodeRes.json("ok", { message: "Hello, World!" })
		expect([isHoneyResponse(json), Object.getPrototypeOf(json) === Response.prototype]).toEqual([true, false])
		expect([json.status, json.headers.get("content-type"), await json.json()]).toEqual([
			200,
			"application/json",
			{ message: "Hello, World!" },
		])
		const text = nodeRes.text("created", "hi")
		expect([isHoneyResponse(text), text.status, await text.text()]).toEqual([true, 201, "hi"])
	})

	it("lower-cases option headers and appends cookies after a set-cookie header", async () => {
		const response = nodeRes.json("ok", 1, {
			cookies: { b: { value: "2" } },
			headers: { "Set-Cookie": "a=1", "X-A": "1" },
		})
		expect([response.headers.get("x-a"), response.headers.getSetCookie(), await response.json()]).toEqual([
			"1",
			["a=1", "b=2"],
			1,
		])
		expect(nodeRes.text("ok", "x", { cookies: { c: { value: "3" } } }).headers.getSetCookie()).toEqual(["c=3"])
	})

	it("noContent and redirect build an empty bag, and the shared content-type maps stay unchanged", async () => {
		const empty = nodeRes.noContent({ headers: { "x-a": "1" } })
		expect([isHoneyResponse(empty), empty.status, empty.headers.get("x-a"), await empty.text()]).toEqual([
			true,
			204,
			"1",
			"",
		])
		const moved = nodeRes.redirect("/next", { status: 301 })
		expect([moved.status, moved.headers.get("location")]).toEqual([301, "/next"])
		nodeRes.json("ok", 1, { headers: { "x-a": "1" } })
		expect(nodeRes.json("ok", 1).headers.get("x-a")).toBeNull()
	})
})

describe("the raw-body record", () => {
	it("records the body a helper wrote, without a property on the response", () => {
		const response = res.json("ok", { id: 1 })
		expect(rawBodyOf(response)).toBe('{"id":1}')
		expect(Object.getOwnPropertySymbols(response)).toEqual([])
		expect(rawBodyOf(res.html("ok", "<p/>", { headers: { "x-a": "1" } }))).toBe("<p/>")
	})
})
