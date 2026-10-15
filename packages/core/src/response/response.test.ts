/**
 * HoneyRes, the ctx.res helpers, outside any request: each body helper's status, content type and
 * body; options (headers, cookies, status) on every helper; noContent and redirect; raw(); the Node
 * path that skips the native Response; and the raw-body record. Cookie serialization rules are
 * pinned in tests/integration/cookie-codec.test.ts.
 */
import { describe, expect, it } from "vitest"
import { isHoneyResponse, rawBodyOf } from "./builder.ts"
import { SILENT } from "../telemetry/logger.ts"
import { HoneyRes, type ResLink, type ResponseOptions } from "./response.ts"

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
	// v0: b416e4f748
	// v0: f431b4f8e3
	// v0: ed70e2ac27
	// v0: 806499f9d1
	// v0: 19127db454
	// v0: 7afdd6db20
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
	// v0: 9f79a93bb7
	// v0: 0bafb3f051
	// v0: 1969e321da
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

describe("body helpers: the options' content type, and json's serialization", () => {
	// v0: 9122573f2c
	it("a content type in the options replaces the helper's own, on the native and the Node path", () => {
		for (const helper of [new HoneyRes(), new HoneyRes(true)]) {
			const response = helper.json(
				"ok",
				{ data: 1 },
				{ headers: { "Content-Type": "application/json; charset=utf-8" } },
			)
			expect([...response.headers]).toEqual([["content-type", "application/json; charset=utf-8"]])
		}
	})

	// v0: 0d12f86daf
	// v0: 80b75f430a
	// v0: 33bc48b851
	// v0: d4ab685006
	// v0: 340e1c496f
	it("json writes what JSON.stringify writes, a fresh body on every call", async () => {
		const shaped = { secret: "hidden", toJSON: () => ({ public: "visible" }) }
		const data = { gone: undefined, inf: Number.POSITIVE_INFINITY, nan: Number.NaN, shaped }
		const [first, second] = [res.json("ok", data), res.json("ok", data)]
		expect([first === second, await first.text(), await second.text()]).toEqual([
			false,
			'{"inf":null,"nan":null,"shaped":{"public":"visible"}}',
			'{"inf":null,"nan":null,"shaped":{"public":"visible"}}',
		])
	})

	it("json of a value JSON.stringify leaves out writes an empty body, kept as an empty raw body on both paths", async () => {
		const answers = [res, new HoneyRes(true)].flatMap((helper) => [
			helper.json("ok", undefined),
			helper.json("ok", () => 1),
		])
		expect(await Promise.all(answers.map(async (r) => [rawBodyOf(r), await r.text()]))).toEqual([
			["", ""],
			["", ""],
			["", ""],
			["", ""],
		])
	})
})

describe("status", () => {
	// v0: 7caa6b9ffb
	// v0: d211912876
	// v0: 33cccc4f70
	// v0: 7bcc1bb352
	// v0: b17f54b76d
	// v0: e9968dbe32
	// v0: 2b61ec535b
	it.each([
		["ok", 200],
		["created", 201],
		["accepted", 202],
		["bad_request", 400],
		["unauthorized", 401],
		["forbidden", 403],
		["not_found", 404],
		["conflict", 409],
		["gone", 410],
		["internal_server_error", 500],
	] as const)("the status key %s answers %i on every helper; opts.status overrides it", (key, code) => {
		expect([res.json(key, {}).status, res.text(key, "x").status, res.html(key, "x").status]).toEqual([code, code, code])
		expect(res.text(key, "x", { status: 299 }).status).toBe(299)
	})

	// v0: b3c80a24ec
	it("a body on a null-body status throws, on the native and the Node path", () => {
		for (const helper of [new HoneyRes(), new HoneyRes(true)])
			for (const status of [101, 103, 204, 205, 304])
				expect(() => helper.json("ok", 1, { status })).toThrow(`A ${status} response cannot have a body`)
	})
})

describe("noContent and redirect", () => {
	// v0: f0c7183d59
	// v0: 4bb2aaa052
	// v0: 056eba13d8
	// v0: 019a8e1ca2
	// v0: a468a75bef
	it("noContent answers 204 with no body, and takes headers and cookies", () => {
		expect([res.noContent().status, res.noContent().body]).toEqual([204, null])
		const empty = res.noContent({ cookies: { a: { value: "1" } }, headers: { "x-a": "1" } })
		expect([empty.headers.get("x-a"), empty.headers.getSetCookie()]).toEqual(["1", ["a=1"]])
	})

	// v0: 9100f11b22
	// v0: 09ae17016b
	// v0: 73664f5f7b
	// v0: eeed2976ab
	// v0: 21b10a6514
	// v0: 082ea36bd9
	// v0: 1e20ef1b3f
	// v0: d2fb3a1809
	// v0: 6698aaeaa5
	// v0: 40feefa5e3
	// v0: c80f1d7ea9
	it("redirect answers 302 to the location with no body, or the status the options give", () => {
		const found = res.redirect("/new")
		expect([found.status, found.headers.get("location"), found.body]).toEqual([302, "/new", null])
		const moved = [301, 307, 308].map((status) => res.redirect("/new", { status }))
		expect(moved.map((r) => [r.status, r.headers.get("location")])).toEqual([
			[301, "/new"],
			[307, "/new"],
			[308, "/new"],
		])
	})
})

describe("raw()", () => {
	// v0: a68f79eb2b
	// v0: 81e21b1f3b
	// v0: 840d82ead0
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
		class Custom extends Response {}
		const custom = res.raw(new Custom("custom", { status: 201 }))
		expect([custom.status, await custom.text()]).toEqual([201, "custom"])
	})

	// v0: b4066894fa
	// v0: 8d3e7dd310
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

describe("raw(): a body already read", () => {
	it("is refused, on a plain response, one Honey built, and the Node path, naming the fix", async () => {
		const plain = new Response("cached")
		const built = res.json("ok", { cached: true })
		const node = new HoneyRes(true).json("ok", { cached: true })
		for (const used of [plain, built, node]) {
			await used.text()
			expect(() => res.raw(used)).toThrow("raw(): this response's body was already read")
		}
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

	// v0: 669a65fbb2
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

/** What a request hands ctx.res: its headers and a signal the test aborts. */
function link(headers: Record<string, string> = {}): ResLink & { abort(reason?: unknown): void } {
	const request = new AbortController()
	return {
		abort: (reason) => request.abort(reason),
		log: SILENT,
		req: new Request("http://h/", { headers }),
		signal: request.signal,
	}
}

describe("stream(): a body written through a WritableStream", () => {
	// v0: 8f920de9aa
	// v0: e753f85ea8
	// v0: 6e218a132d
	// v0: d3b9d3791a
	// v0: 3534671b97
	// v0: 840b8074ed
	it("takes strings, ArrayBuffers and views, in order, under octet-stream by default", async () => {
		const response = res.stream(async (writable) => {
			const writer = writable.getWriter()
			await writer.write("a")
			await writer.write(new TextEncoder().encode("b").buffer)
			await writer.write(new Uint8Array([99]))
			await writer.write(new DataView(new TextEncoder().encode("d").buffer))
			await writer.close()
		})
		expect([response.status, response.headers.get("content-type"), await response.text()]).toEqual([
			200,
			"application/octet-stream",
			"abcd",
		])
	})

	// v0: 578c554fa4
	// v0: eadb867a34
	it("takes a status, headers (content-type included) and cookies", async () => {
		const response = res.stream(async () => {}, {
			cookies: { s: { value: "1" } },
			headers: { "content-type": "text/plain", "x-a": "1" },
			status: 201,
		})
		const seen = [response.status, response.headers.get("content-type"), response.headers.get("x-a")]
		expect([...seen, response.headers.getSetCookie()]).toEqual([201, "text/plain", "1", ["s=1"]])
	})
})

describe("stream(): flushing and failing", () => {
	// v0: 5a3089f3ab
	it("flushes queued writes when the callback returns without closing", async () => {
		const response = res.stream(async (writable) => {
			const writer = writable.getWriter()
			void writer.write("x")
			void writer.write("y")
		})
		expect(await response.text()).toBe("xy")
	})

	it("a chunk that is not text or bytes breaks the body with a TypeError", async () => {
		const response = res.stream(async (writable) => {
			await writable.getWriter().write(42)
		})
		await expect(response.text()).rejects.toThrow(
			"ctx.res.stream() chunks must be strings, ArrayBuffers or typed arrays",
		)
	})

	// v0: c3d2114a90
	// v0: 8e2a54c2c6
	// v0: 1fbac3e84b
	// v0: e4fbd9a78a
	// v0: 43f007dbec
	it("a callback that throws, even while holding the writer, breaks the body after what it wrote", async () => {
		const response = res.stream(async (writable) => {
			const writer = writable.getWriter()
			await writer.write("partial")
			throw new Error("callback failed")
		})
		const reader = (response.body as ReadableStream<Uint8Array>).getReader()
		expect(new TextDecoder().decode((await reader.read()).value)).toBe("partial")
		await expect(reader.read()).rejects.toThrow("callback failed")
	})

	it("aborting the writable breaks the body", async () => {
		const response = res.stream(async (writable) => {
			await writable.abort(new Error("gave up"))
		})
		await expect(response.text()).rejects.toThrow("gave up")
	})
})

async function* ndjson() {
	yield '{"n":1}\n'
	yield '{"n":2}\n'
}

function* failing() {
	yield "before"
	throw new Error("boom")
}

async function* endless() {
	for (;;) yield "tick"
}

describe("generate(): a body pulled from a generator", () => {
	// v0: 824712583d
	// v0: 5fee202827
	// v0: d6f8f70709
	// v0: 4b5023e1fc
	// v0: f97c4880f6
	// v0: 23a6d10f34
	// v0: 6941ca3642
	it("yields every value, under octet-stream unless a content type is given, with a status", async () => {
		const plain = res.generate((function* () {})())
		const typed = res.generate(ndjson(), { contentType: "application/x-ndjson", status: 202 })
		expect([
			[plain.status, plain.headers.get("content-type"), await plain.text()],
			[typed.status, typed.headers.get("content-type"), await typed.text()],
		]).toEqual([
			[200, "application/octet-stream", ""],
			[202, "application/x-ndjson", '{"n":1}\n{"n":2}\n'],
		])
	})

	// v0: 400a47a12e
	// v0: e9c54e748f
	it("a generator that throws breaks the body after the values before it", async () => {
		await expect(res.generate(failing()).text()).rejects.toThrow("boom")
	})
})

describe("sse(): the event stream response", () => {
	// v0: 6d6d110a3d
	// v0: 9d3394f383
	it("answers text/event-stream, no-cache, with a status, headers and cookies, never Connection", async () => {
		const response = res.sse(
			async (stream) => {
				await stream.send({ data: "hi", event: "msg" })
			},
			{ cookies: { s: { value: "1" } }, headers: { "x-a": "1" }, status: 200 },
		)
		const headers = Object.fromEntries(response.headers)
		expect([response.status, headers, await response.text()]).toEqual([
			200,
			{ "cache-control": "no-cache", "content-type": "text/event-stream", "set-cookie": "s=1", "x-a": "1" },
			"event: msg\ndata: hi\n\n",
		])
	})
})

describe("ctx.res linked to its request", () => {
	it("sse() resumes from the Last-Event-ID header; an explicit lastEventId wins; a bare res has none", async () => {
		const seen: unknown[] = []
		const record = async (stream: { lastEventId: string | undefined }) => void seen.push(stream.lastEventId)
		const linked = new HoneyRes(false, link({ "last-event-id": "41" }))
		await linked.sse(record).text()
		await linked.sse(record, { lastEventId: "7" }).text()
		await res.sse(record).text()
		expect(seen).toEqual(["41", "7", undefined])
	})

	// v0: 1c5f096151
	it("every producer ends when the request's signal aborts", async () => {
		const request = link()
		const linked = new HoneyRes(false, request)
		const bodies = [
			linked.sse((stream) => new Promise((resolve) => stream.signal.addEventListener("abort", () => resolve()))),
			linked.stream((_writable, signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve()))),
			linked.generate(endless()),
		].map((response) => (response.body as ReadableStream<Uint8Array>).getReader())
		const started = bodies.map((reader) => reader.read())
		await new Promise((resolve) => setTimeout(resolve, 5))
		request.abort(new DOMException("gone", "AbortError"))
		await Promise.all(started)
		expect(await Promise.all(bodies.map(async (reader) => (await reader.read()).done))).toEqual([true, true, true])
	})
})
