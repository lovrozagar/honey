import { describe, expect, it } from "vitest"
import {
	createHoneyResponse,
	HoneyResponse,
	isHoneyResponse,
	isNodeOutbound,
	NODE_OUTBOUND,
	rawBodyOf,
	replaceResponse,
	withRawBody,
} from "./builder.ts"
import { HoneyOutHeaders } from "./out-headers.ts"

function streamOf(text: string): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(c) {
			c.enqueue(new TextEncoder().encode(text))
			c.close()
		},
	})
}

function bag(init: { raw?: string | Uint8Array | null; stream?: ReadableStream<Uint8Array> | null } = {}) {
	return new HoneyResponse({ headers: { "content-type": "text/plain", "x-a": "1" }, status: 200, ...init })
}

describe("HoneyResponse reads like a Fetch Response", () => {
	// v0: f9ca57d13f
	it("clone() tees: the original and the clone both read the whole stream", async () => {
		const original = createHoneyResponse({ headers: {}, status: 200, stream: streamOf("streamed") })
		const copy = original.clone()
		expect(await copy.text()).toBe("streamed")
		expect(await original.text()).toBe("streamed")
	})

	// v0: f2de8a85e5
	it("a second read throws instead of returning an empty body", async () => {
		const res = createHoneyResponse({ headers: {}, raw: "once", status: 200 })
		expect(await res.text()).toBe("once")
		await expect(res.text()).rejects.toThrow(TypeError)
		await expect(res.arrayBuffer()).rejects.toThrow(TypeError)
		expect(res.bodyUsed).toBe(true)
		expect(() => res.clone()).toThrow(TypeError)
	})

	it("carries the Fetch Response fields", () => {
		const res = new HoneyResponse({ headers: {}, status: 404, statusText: "Nope" })
		expect(res).toMatchObject({
			ok: false,
			redirected: false,
			status: 404,
			statusText: "Nope",
			type: "default",
			url: "",
		})
		expect(new HoneyResponse({ headers: {}, status: 299 }).ok).toBe(true)
		expect(new HoneyResponse({ headers: {}, status: 199 }).statusText).toBe("")
		expect(isHoneyResponse(res)).toBe(true)
		expect(isHoneyResponse(new Response())).toBe(false)
		expect(isHoneyResponse(null)).toBe(false)
	})

	it("body is a stream of the raw body, null without one, built once", async () => {
		const res = bag({ raw: "hi" })
		expect(res.body).toBe(res.body)
		expect(await new Response(res.body).text()).toBe("hi")
		expect(bag().body).toBeNull()
		expect(await new Response(bag({ raw: new Uint8Array([104, 105]) }).body).text()).toBe("hi")
	})
})

describe("HoneyResponse body readers", () => {
	it("reads text, json, bytes, blob and arrayBuffer from raw text or bytes", async () => {
		expect(await bag({ raw: new Uint8Array([104, 105]) }).text()).toBe("hi")
		expect(await bag({ raw: '{"a":1}' }).json()).toEqual({ a: 1 })
		expect(await bag({ raw: "" }).json()).toBeNull()
		expect(await bag({ raw: "hi" }).bytes()).toEqual(new Uint8Array([104, 105]))
		expect(new Uint8Array(await bag({ raw: new Uint8Array([1, 2]) }).arrayBuffer())).toEqual(new Uint8Array([1, 2]))
		const blob = await bag({ raw: "hi" }).blob()
		expect(blob.type).toBe("text/plain")
		expect(await blob.text()).toBe("hi")
		expect((await new HoneyResponse({ headers: {}, raw: "x", status: 200 }).blob()).type).toBe("")
	})

	it("reads a streamed body, and an empty one", async () => {
		expect(await bag({ stream: streamOf("s") }).text()).toBe("s")
		expect(new Uint8Array(await bag({ stream: streamOf("s") }).arrayBuffer())).toEqual(new Uint8Array([115]))
		expect(await bag().text()).toBe("")
		expect((await bag().arrayBuffer()).byteLength).toBe(0)
	})

	it("a locked stream counts as read", async () => {
		const res = bag({ stream: streamOf("s") })
		res.body?.getReader()
		await expect(res.text()).rejects.toThrow("Body has already been used")
	})

	it("reads form data", async () => {
		const res = new HoneyResponse({
			headers: { "content-type": "application/x-www-form-urlencoded" },
			raw: "a=1",
			status: 200,
		})
		expect((await res.formData()).get("a")).toBe("1")
	})
})

describe("HoneyResponse headers and copies", () => {
	it("headers is a lazy HoneyOutHeaders; plainHeaders follows writes through it", () => {
		const res = bag({ raw: "x" })
		expect(res.plainHeaders).toEqual({ "content-type": "text/plain", "x-a": "1" })
		expect(res.headers).toBeInstanceOf(HoneyOutHeaders)
		expect(res.headers).toBe(res.headers)
		res.headers.set("x-b", "2")
		expect(res.plainHeaders).toEqual({ "content-type": "text/plain", "x-a": "1", "x-b": "2" })
		expect(res.rawBody).toBe("x")
	})

	it("clone() of a raw body copies it; of no body is empty", async () => {
		expect(await bag({ raw: "x" }).clone().text()).toBe("x")
		expect(await bag().clone().text()).toBe("")
	})

	it("derive() keeps what it is not given", async () => {
		const res = bag({ raw: "x" })
		const same = res.derive({})
		expect(same.status).toBe(200)
		expect(same.plainHeaders).toEqual(res.plainHeaders)
		expect(await same.text()).toBe("x")
		const native = new Headers({ "x-n": "1" })
		native.append("set-cookie", "a=1")
		expect(res.derive({ headers: native, raw: "y", status: 201 }).plainHeaders).toEqual({
			"set-cookie": ["a=1"],
			"x-n": "1",
		})
		expect(res.derive({ headers: new HoneyOutHeaders({ "x-o": "1" }) }).plainHeaders).toEqual({ "x-o": "1" })
		expect(res.derive({ headers: { "x-p": "1" } }).plainHeaders).toEqual({ "x-p": "1" })
		expect(await res.derive({ stream: streamOf("s") }).text()).toBe("x")
	})
})

describe("replaceResponse", () => {
	// v0: c551b10135
	it("keeps headers and statusText when only the status changes on a native response", () => {
		const native = new Response("x", { headers: { "x-keep": "1" }, status: 200, statusText: "Fine" })
		const same = replaceResponse(native, { body: "y" })
		expect(same.headers.get("x-keep")).toBe("1")
		expect(same.statusText).toBe("Fine")
		const moved = replaceResponse(new Response("x", { headers: { "x-keep": "1" } }), { status: 201 })
		expect(moved.status).toBe(201)
		expect(moved.headers.get("x-keep")).toBe("1")
	})

	// v0: 941994b43f
	it("returns a 101 unchanged", () => {
		const upgrade = { headers: new Headers(), status: 101 } as unknown as Response
		expect(replaceResponse(upgrade, { headers: { "x-a": "1" } })).toBe(upgrade)
	})

	it("keeps a HoneyResponse a HoneyResponse for every buffered body kind", async () => {
		const res = createHoneyResponse({ headers: { "x-a": "1" }, raw: "x", status: 200 })
		const cases: [BodyInit | null | undefined, string][] = [
			[undefined, "x"],
			["text", "text"],
			[new Uint8Array([98]), "b"],
			[new Uint8Array([99]).buffer, "c"],
			[null, ""],
		]
		for (const [body, text] of cases) {
			const next = replaceResponse(res, { body, status: 202 })
			expect(isHoneyResponse(next)).toBe(true)
			expect(next.status).toBe(202)
			expect(next.headers.get("x-a")).toBe("1")
			expect(await next.text()).toBe(text)
		}
	})

	it("a stream body, or new headers, on a native response rebuild it natively", async () => {
		const res = createHoneyResponse({ headers: { "x-a": "1" }, raw: "x", status: 200 })
		const streamed = replaceResponse(res, { body: streamOf("s") })
		expect(isHoneyResponse(streamed)).toBe(false)
		expect(streamed.headers.get("x-a")).toBe("1")
		expect(await streamed.text()).toBe("s")
		const native = replaceResponse(new Response("x"), { headers: new Headers({ "x-h": "1" }) })
		expect(native.headers.get("x-h")).toBe("1")
		expect(replaceResponse(new Response("x"), { headers: { "x-r": "1" } }).headers.get("x-r")).toBe("1")
	})
})

describe("raw body and the Node outbound flag", () => {
	it("rawBodyOf reads the side table, a HoneyResponse, or nothing", () => {
		const native = withRawBody(new Response("x"), "x")
		expect(rawBodyOf(native)).toBe("x")
		expect(Object.getOwnPropertySymbols(native)).toEqual([])
		expect(rawBodyOf(createHoneyResponse({ headers: {}, raw: "y", status: 200 }))).toBe("y")
		expect(rawBodyOf(new Response("z"))).toBeNull()
	})

	it("isNodeOutbound reads the request flag", () => {
		const request = new Request("http://localhost/")
		expect(isNodeOutbound(request)).toBe(false)
		Object.defineProperty(request, NODE_OUTBOUND, { value: true })
		expect(isNodeOutbound(request)).toBe(true)
	})
})
