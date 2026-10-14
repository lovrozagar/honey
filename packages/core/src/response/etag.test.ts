import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import * as z from "zod"
import { type HoneyServer, serve } from "../adapters/node/serve.ts"
import { HoneyError } from "../errors/error.ts"
import { bodyLimit } from "../input/body-limit.ts"
import { cors } from "../middleware/cors.ts"
import { requestId } from "../middleware/request-id.ts"
import { secureHeaders } from "../middleware/secure-headers.ts"
import { serverTiming } from "../middleware/server-timing.ts"
import { honey } from "../routing/app.ts"
import { etag, ifNoneMatchHits } from "./etag.ts"

const servers: HoneyServer[] = []

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.shutdown(0)))
})

type App = { fetch(request: Request, env: {}): Response | Promise<Response> }

/** Serve `app` on a free loopback port; the base URL to reach it. */
async function listen(app: App): Promise<string> {
	const server = serve(app, { env: {}, hostname: "127.0.0.1", port: 0 })
	servers.push(server)
	await new Promise((resolve) => server.once("listening", resolve))
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const get = (path: string, headers?: Record<string, string>, method = "GET") =>
	new Request(`http://localhost${path}`, { headers, method })

/** The status, ETag and body text of an answer. */
async function seen(answer: Response | Promise<Response>): Promise<[number, string | null, string]> {
	const res = await answer
	return [res.status, res.headers.get("etag"), await res.text()]
}

/** The CORS, Vary and secure headers of an answer. */
const named = (res: Response) =>
	["access-control-allow-origin", "vary", "x-content-type-options"].map((name) => res.headers.get(name))

const WEAK = /^W\/"[A-Za-z0-9_-]{22}"$/
const STRONG = /^"[A-Za-z0-9_-]{22}"$/

describe("etag: a body honey built gets a validator", () => {
	// v0: 1bbd51da1b
	// v0: 6cf5f4b509
	// v0: 697841067d
	// v0: 6d593b3f41
	// v0: 46c6acc621
	// v0: 616843dc3f
	// v0: ac022fcb2b
	it("a GET answered 200 gets a weak validator by default, a strong one with weak: false, its body intact", async () => {
		const [weak, strong] = [honey<{}>().use(etag()), honey<{}>().use(etag({ weak: false }))]
		for (const app of [weak, strong]) app.get("/data").handler((ctx) => ctx.res.json("ok", { total: 3 }))
		const [w, s] = [await seen(weak.fetch(get("/data"), {})), await seen(strong.fetch(get("/data"), {}))]
		expect([w[0], WEAK.test(w[1] ?? ""), w[2], s[0], STRONG.test(s[1] ?? ""), s[2]]).toEqual([
			200,
			true,
			'{"total":3}',
			200,
			true,
			'{"total":3}',
		])
	})

	// v0: 40966ca2a3
	// v0: fc6b22a456
	// v0: 3874ad21f1
	it("the same body gets the same validator, a different body a different one", async () => {
		let version = 0
		const app = honey<{}>().use(etag())
		app.get("/stable").handler((ctx) => ctx.res.json("ok", { stable: true }))
		app.get("/changing").handler((ctx) => ctx.res.json("ok", { v: ++version }))
		const tag = async (path: string) => (await app.fetch(get(path), {})).headers.get("etag")
		const [a, b, c, d] = [await tag("/stable"), await tag("/stable"), await tag("/changing"), await tag("/changing")]
		expect([a === b, c === d, a === c]).toEqual([true, false, false])
	})

	// v0: 1a4019177d
	// v0: 5f5fc9d05d
	// v0: cef0e89b3e
	// v0: 9645e8daf6
	it("bytes, a JSON null, an answer under bodyLimit and a foreign body of declared length all get one", async () => {
		const app = honey<{}>()
			.use(bodyLimit({ maxSize: 50_000 }))
			.use(etag())
		app.get("/bin").handler((ctx) => ctx.res.binary("ok", new Uint8Array([1, 2, 3, 4, 5])))
		app.get("/null").handler((ctx) => ctx.res.json("ok", null))
		app.get("/sized").handler((ctx) => ctx.res.raw(new Response("hello", { headers: { "content-length": "5" } })))
		const answers = await Promise.all(["/bin", "/null", "/sized"].map((path) => seen(app.fetch(get(path), {}))))
		expect(answers.map(([status, tag, body]) => [status, WEAK.test(tag ?? ""), body])).toEqual([
			[200, true, "\u0001\u0002\u0003\u0004\u0005"],
			[200, true, "null"],
			[200, true, "hello"],
		])
	})
})

describe("etag: what gets no validator", () => {
	// v0: 52bc9e324b
	// v0: cc63f9d186
	// v0: ddbbc08890
	// v0: 70675800b8
	it("a POST, and any status but 200, even with If-None-Match: *", async () => {
		const app = honey<{}>().use(etag())
		app.post("/items").handler((ctx) => ctx.res.json("created", { id: 1 }))
		app.get("/created").handler((ctx) => ctx.res.json("created", { id: 1 }))
		app.get("/redirect").handler((ctx) => ctx.res.raw(new Response(null, { headers: { location: "/" }, status: 302 })))
		const star = { "if-none-match": "*" }
		const answers = await Promise.all([
			seen(app.fetch(get("/items", star, "POST"), {})),
			seen(app.fetch(get("/created", star), {})),
			seen(app.fetch(get("/redirect", star), {})),
		])
		expect(answers).toEqual([
			[201, null, '{"id":1}'],
			[201, null, '{"id":1}'],
			[302, null, ""],
		])
	})

	// v0: 842f5d97e2
	// v0: 46b7d17012
	// v0: 71fbb7300b
	// v0: ebd7d0529a
	// v0: cb5d14a8eb
	it("an error answer keeps its body and gets none", async () => {
		const app = honey<{}>().logger(false).use(etag())
		app.get("/fail").handler(() => {
			throw new Error("boom")
		})
		app.get("/forbidden").handler(() => {
			throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
		})
		const answers = await Promise.all(["/missing", "/fail", "/forbidden"].map((path) => seen(app.fetch(get(path), {}))))
		expect(answers.map(([status, tag, body]) => [status, tag, body.length > 0])).toEqual([
			[404, null, true],
			[500, null, true],
			[403, null, true],
		])
	})
})

describe("etag: an answer with no bytes", () => {
	// v0: a3173ed3fb
	// v0: 37ad6832db
	// v0: 7636f0177e
	// v0: 4dc7619b97
	// v0: fea9249d24
	it("an answer with no bytes: a 204, an empty text, a null body, a zero-length foreign body, each still readable", async () => {
		const app = honey<{}>().use(etag())
		app.get("/none").handler((ctx) => ctx.res.noContent())
		app.get("/empty").handler((ctx) => ctx.res.text("ok", ""))
		app.get("/null").handler((ctx) => ctx.res.raw(new Response(null, { status: 200 })))
		app
			.get("/zero")
			.handler((ctx) => ctx.res.raw(new Response(new Uint8Array(0), { headers: { "content-length": "0" } })))
		const answers = await Promise.all(
			["/none", "/empty", "/null", "/zero"].map((path) => seen(app.fetch(get(path), {}))),
		)
		expect(answers).toEqual([
			[204, null, ""],
			[200, null, ""],
			[200, null, ""],
			[200, null, ""],
		])
	})
})

describe("etag: a stream is never buffered", () => {
	// v0: f1332c7afd
	// v0: eb0e74b674
	// v0: 465791bf1c
	// v0: cbe2b801a4
	// v0: e7181ccbd9
	it("an endless event stream, a foreign stream and a chunked answer pass at once, with no validator", async () => {
		const app = honey<{}>().use(etag())
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				for (;;) {
					await stream.send({ data: "x", event: "tick" })
					await new Promise((resolve) => setTimeout(resolve, 5))
				}
			}),
		)
		app.get("/ndjson").handler((ctx) =>
			ctx.res.raw(
				new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{}\n")) }), {
					headers: { "content-type": "application/x-ndjson" },
				}),
			),
		)
		app
			.get("/chunked")
			.handler((ctx) => ctx.res.raw(new Response("chunked data", { headers: { "transfer-encoding": "chunked" } })))
		const answers = await Promise.all(["/events", "/ndjson", "/chunked"].map((path) => app.fetch(get(path), {})))
		expect(answers.map((res) => [res.status, res.headers.get("etag")])).toEqual([
			[200, null],
			[200, null],
			[200, null],
		])
		await Promise.all(answers.map((res) => res.body?.cancel()))
	})

	// v0: 448426b1ab
	// v0: 23beeac98c
	it("a generated or written stream arrives whole on the wire", async () => {
		const app = honey<{}>().use(etag())
		app.get("/gen").handler((ctx) =>
			ctx.res.generate(
				(function* () {
					yield "chunk1"
					yield "chunk2"
				})(),
				{ contentType: "text/plain" },
			),
		)
		app.get("/written").handler((ctx) =>
			ctx.res.stream(async (writable) => {
				const writer = writable.getWriter()
				await writer.write(new TextEncoder().encode("streamed"))
				await writer.close()
			}),
		)
		const base = await listen(app)
		const bodies = await Promise.all(["/gen", "/written"].map(async (path) => (await fetch(`${base}${path}`)).text()))
		expect(bodies).toEqual(["chunk1chunk2", "streamed"])
	})
})

describe("etag: If-None-Match", () => {
	// v0: ae1feb3a09
	// v0: 58930b1de8
	// v0: 7e83182c09
	// v0: 18fd9e2f36
	// v0: d18a0c2de1
	// v0: fd328851d9
	// v0: 6822ed6be0
	it("a matching tag is a 304 with no body, the tag and the answer's headers; another tag the full 200", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { total: 3 }, { headers: { "x-a": "1" } }))
		const tag = (await app.fetch(get("/data"), {})).headers.get("etag") ?? ""
		const hit = await app.fetch(get("/data", { "if-none-match": tag }), {})
		const miss = await seen(app.fetch(get("/data", { "if-none-match": '"stale-hash"' }), {}))
		expect([
			hit.status,
			hit.headers.get("etag") === tag,
			hit.headers.get("content-type"),
			hit.headers.get("x-a"),
			await hit.text(),
			[miss[0], miss[1] === tag, miss[2]],
		]).toEqual([304, true, "application/json", "1", "", [200, true, '{"total":3}']])
	})

	// v0: 495593c236
	// v0: 2998aadc1b
	// v0: a48572d3c4
	// v0: 3bd47c8f8f
	// v0: 4f6605e1cf
	it("compares weakly, reads a list, spaces and quoted commas, and * matches any answer", async () => {
		const app = honey<{}>().use(etag({ weak: false }))
		app.get("/d").handler((ctx) => ctx.res.json("ok", { a: 1 }))
		const tag = (await app.fetch(get("/d"), {})).headers.get("etag") ?? ""
		const status = async (header: string) => (await app.fetch(get("/d", { "if-none-match": header }), {})).status
		expect(
			await Promise.all(
				[`W/${tag}`, `"fake1", ${tag}, "fake2"`, `"a,b", ${tag}`, `  ${tag}  `, "*", '"other"'].map(status),
			),
		).toEqual([304, 304, 304, 304, 304, 200])
	})
})

describe("etag: how tags match", () => {
	// v0: b32dd577d7
	it("ifNoneMatchHits: *, weak and strong forms, a list; an absent header never hits", () => {
		expect([
			ifNoneMatchHits("*", '"x"'),
			ifNoneMatchHits('W/"x"', '"x"'),
			ifNoneMatchHits('"x"', 'W/"x"'),
			ifNoneMatchHits('"y", W/"x"', '"x"'),
			ifNoneMatchHits('"xx"', '"x"'),
			ifNoneMatchHits(null, '"x"'),
			ifNoneMatchHits("garbage", '"x"'),
		]).toEqual([true, true, true, true, false, false, false])
	})

	// v0: 11ea33dd3e
	it("a validator the handler set is never replaced and decides the 304", async () => {
		const app = honey<{}>().use(etag())
		app.get("/v").handler((ctx) => ctx.res.raw(new Response("body", { headers: { etag: '"v42"' } })))
		const first = await seen(app.fetch(get("/v"), {}))
		const second = await seen(app.fetch(get("/v", { "if-none-match": 'W/"v42"' }), {}))
		expect([first, second]).toEqual([
			[200, '"v42"', "body"],
			[304, '"v42"', ""],
		])
	})
})

describe("etag beside other middleware", () => {
	// v0: 058a9d652e
	// v0: 47fadf3741
	// v0: f6283147e7
	// v0: 4dc9c5373b
	it("CORS outside etag reaches the 304 too, with Vary; secure headers stay; the Node bag is kept", async () => {
		const app = honey<{}>()
			.use(cors({ origin: "http://app.com" }))
			.use(etag())
			.use(secureHeaders())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { message: "Hello" }))
		const base = await listen(app)
		const first = await fetch(`${base}/data`, { headers: { origin: "http://app.com" } })
		const tag = first.headers.get("etag") ?? ""
		const second = await fetch(`${base}/data`, { headers: { "if-none-match": tag, origin: "http://app.com" } })
		expect([
			[first.status, WEAK.test(tag), ...named(first), await first.json()],
			[second.status, second.headers.get("etag") === tag, ...named(second), await second.text()],
		]).toEqual([
			[200, true, "http://app.com", "Origin", "nosniff", { message: "Hello" }],
			[304, true, "http://app.com", "Origin", "nosniff", ""],
		])
	})

	// v0: 081548c2f4
	// v0: 730effe754
	it("with CORS and bodyLimit: a POST reads and validates its body untagged, a GET is tagged and answers 304", async () => {
		const app = honey<{}>()
			.use(cors({ origin: "*" }))
			.use(bodyLimit({ maxSize: 50_000 }))
			.use(etag())
		app
			.post("/api")
			.input({ json: z.object({ key: z.string() }) })
			.handler((ctx) => ctx.res.json("created", ctx.input.json))
		app.get("/api").handler((ctx) => ctx.res.json("ok", { data: true }))
		const base = await listen(app)
		const origin = { origin: "http://app.com" }
		const posted = await fetch(`${base}/api`, {
			body: '{"key":"value"}',
			headers: { ...origin, "content-type": "application/json" },
			method: "POST",
		})
		const got = await fetch(`${base}/api`, { headers: origin })
		const tag = got.headers.get("etag") ?? ""
		const again = await fetch(`${base}/api`, { headers: { ...origin, "if-none-match": tag } })
		expect([
			[
				posted.status,
				posted.headers.get("access-control-allow-origin"),
				posted.headers.get("etag"),
				await posted.json(),
			],
			[got.status, got.headers.get("access-control-allow-origin"), WEAK.test(tag)],
			again.status,
		]).toEqual([[201, "*", null, { key: "value" }], [200, "*", true], 304])
	})
})

describe("etag on the wire", () => {
	// v0: b43feb38d8
	// v0: 414a75178f
	// v0: ccaf6c7013
	// v0: 0671a18e4d
	// v0: cc7ac8806e
	it("cookies, a 1KB body and every other header survive; a matching tag answers 304 with an empty body", async () => {
		const app = honey<{}>().use(secureHeaders()).use(requestId()).use(serverTiming()).use(etag())
		const items = Array.from({ length: 100 }, (_, i) => ({ id: i, name: `item-${i}` }))
		app.get("/health").handler((ctx) =>
			ctx.res.json("ok", items, {
				cookies: { session: { httpOnly: true, path: "/", value: "tok-1" }, theme: { path: "/", value: "dark" } },
			}),
		)
		const base = await listen(app)
		const first = await fetch(`${base}/health`)
		const tag = first.headers.get("etag") ?? ""
		const second = await fetch(`${base}/health`, { headers: { "if-none-match": tag } })
		expect([
			first.status,
			WEAK.test(tag),
			first.headers.getSetCookie(),
			((await first.json()) as unknown[]).length,
			first.headers.get("x-content-type-options"),
			/^[0-9a-f-]{36}$/.test(first.headers.get("x-request-id") ?? ""),
			first.headers.get("server-timing")?.includes("total;dur="),
			[second.status, await second.text()],
		]).toEqual([
			200,
			true,
			["session=tok-1; Path=/; HttpOnly", "theme=dark; Path=/"],
			100,
			"nosniff",
			true,
			true,
			[304, ""],
		])
	})

	// v0: 1057ea273a
	// v0: f523c319bb
	it("HEAD gets the tag GET gets, and no body", async () => {
		const app = honey<{}>().use(etag())
		app.get("/data").handler((ctx) => ctx.res.json("ok", { items: [1, 2, 3] }))
		const base = await listen(app)
		const [got, head] = await Promise.all([fetch(`${base}/data`), fetch(`${base}/data`, { method: "HEAD" })])
		expect([
			head.status,
			WEAK.test(head.headers.get("etag") ?? ""),
			head.headers.get("etag") === got.headers.get("etag"),
			await head.text(),
		]).toEqual([200, true, true, ""])
	})
})
