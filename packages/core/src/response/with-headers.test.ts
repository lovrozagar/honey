import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createHoneyResponse, isHoneyResponse } from "./builder.ts"
import { addVary, type HeaderEdit, withHeaders } from "./with-headers.ts"

afterEach(() => {
	vi.unstubAllGlobals()
})

const stamp = (headers: HeaderEdit) => headers.set("x-stamped", "yes")
const inject = (headers: HeaderEdit) => headers.set("x-echo", "a\r\nx-injected: 1")

describe("withHeaders: which response it edits, and how", () => {
	// v0: 11b4d16e64
	it("a HoneyResponse is edited on its plain map: the same object, no native Headers built", () => {
		const response = createHoneyResponse({ headers: { "content-type": "application/json" }, raw: "{}", status: 200 })
		vi.stubGlobal("Headers", function NativeHeaders() {
			throw new Error("native Headers built")
		})
		const edited = withHeaders(response, stamp)
		vi.unstubAllGlobals()
		expect([edited === response, isHoneyResponse(edited), edited.headers.get("x-stamped")]).toEqual([true, true, "yes"])
	})

	// v0: 4482dfb319
	it("a native response with mutable headers is edited in place", () => {
		const response = new Response("x", { headers: { "x-a": "1" } })
		const edited = withHeaders(response, stamp)
		expect([edited === response, edited.headers.get("x-stamped"), edited.headers.get("x-a")]).toEqual([
			true,
			"yes",
			"1",
		])
	})

	// v0: e12d894fa2
	it("a response with immutable headers is copied: body, status, status text and headers kept, then edited", async () => {
		const redirect = Response.redirect("https://elsewhere.example/", 307)
		const edited = withHeaders(redirect, stamp)
		expect([
			edited === redirect,
			edited.status,
			edited.headers.get("location"),
			edited.headers.get("x-stamped"),
			redirect.headers.get("x-stamped"),
		]).toEqual([false, 307, "https://elsewhere.example/", "yes", null])
		const original = new Response("body bytes", { status: 201, statusText: "Made" })
		/* immutable as fetch() makes them: every write throws */
		const immutable = new Proxy(new Headers({ "x-a": "1" }), {
			get(target, key) {
				if (key === "set" || key === "delete" || key === "append") {
					return () => {
						throw new TypeError("immutable")
					}
				}
				const value = Reflect.get(target, key) as unknown
				return typeof value === "function" ? value.bind(target) : value
			},
		})
		Object.defineProperty(original, "headers", { value: immutable })
		const copied = withHeaders(original, stamp)
		expect([
			copied === original,
			await copied.text(),
			copied.status,
			copied.statusText,
			copied.headers.get("x-a"),
			copied.headers.get("x-stamped"),
		]).toEqual([false, "body bytes", 201, "Made", "1", "yes"])
	})
})

describe("withHeaders over a real fetch() response", () => {
	// v0: 48dc7f2688
	it("a fetch() response is copied with every Set-Cookie, its status text and its body", async () => {
		const server = createServer((_req, res) => {
			res.setHeader("set-cookie", ["a=1", "b=2"])
			res.statusMessage = "Fine"
			res.end("upstream")
		})
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
		try {
			const { port } = server.address() as AddressInfo
			const upstream = await fetch(`http://127.0.0.1:${port}/`)
			const out = withHeaders(upstream, stamp)
			expect([
				out === upstream,
				out.headers.get("x-stamped"),
				out.headers.getSetCookie(),
				out.statusText,
				await out.text(),
			]).toEqual([false, "yes", ["a=1", "b=2"], "Fine", "upstream"])
		} finally {
			server.close()
		}
	})
})

describe("withHeaders: what it never does", () => {
	// v0: 7175f64c43
	it("a 101 upgrade is never touched", () => {
		const upgraded = new Response(null)
		Object.defineProperty(upgraded, "status", { value: 101 })
		const edit = vi.fn()
		expect([withHeaders(upgraded, edit) === upgraded, edit.mock.calls.length]).toEqual([true, 0])
	})

	it("an edit that sets a header Fetch refuses throws, on the plain path as on the native one", () => {
		const honey = createHoneyResponse({ headers: {}, raw: "", status: 200 })
		const native = new Response("")
		expect(() => withHeaders(honey, inject)).toThrow(TypeError)
		expect(() => withHeaders(native, inject)).toThrow(TypeError)
	})
})

describe("addVary", () => {
	it.each([
		["no Vary yet", undefined, "Origin"],
		["an empty Vary", " ", "Origin"],
		["another token", "Accept-Encoding", "Accept-Encoding, Origin"],
		["the token already, in another case", "origin", "origin"],
		["a wildcard", "*", "*"],
	])("%s", (_name, before, after) => {
		const headers = new Headers(before === undefined ? {} : { vary: before })
		addVary(headers, "Origin")
		expect(headers.get("vary")).toBe(after.trim() === "" ? null : after)
	})
})
