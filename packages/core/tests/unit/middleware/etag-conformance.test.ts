import { describe, expect, it } from "vitest"
import { etag, ifNoneMatchHits } from "../../../src/etag.ts"
import { honey } from "../../../src/index.ts"

const get = (path: string, headers?: Record<string, string>) => new Request(`http://localhost${path}`, { headers })

describe("etag — streaming bodies are never buffered (H8)", () => {
	it("an endless SSE stream responds immediately without an ETag", async () => {
		const app = honey<{}>().use(etag())
		app.get("/events").handler((ctx) =>
			ctx.res.sse(async (stream) => {
				/* Effectively endless for this test: buffering it would time out. */
				for (let i = 0; i < 400; i++) {
					await stream.send({ data: String(i) })
					await new Promise((r) => setTimeout(r, 5))
				}
			}),
		)
		const res = await Promise.race([
			app.fetch(get("/events"), {}),
			new Promise<null>((r) => setTimeout(() => r(null), 1000)),
		])
		expect(res).not.toBeNull()
		expect(res?.headers.get("etag")).toBeNull()
		await res?.body?.cancel()
	})

	it("a native stream response with a content type is passed through", async () => {
		const app = honey<{}>().use(etag())
		app.get("/ndjson").handler(
			() =>
				new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{}\n")) }), {
					headers: { "content-type": "application/x-ndjson" },
				}),
		)
		const res = await app.fetch(get("/ndjson"), {})
		expect(res.headers.get("etag")).toBeNull()
		await res.body?.cancel()
	})
})

describe("etag — conformance", () => {
	it("never overwrites a handler-set ETag, and uses it for 304", async () => {
		const app = honey<{}>().use(etag())
		app.get("/v").handler(() => new Response("body", { headers: { etag: '"v42"' } }))
		const first = await app.fetch(get("/v"), {})
		expect(first.headers.get("etag")).toBe('"v42"')
		expect(await first.text()).toBe("body")
		const second = await app.fetch(get("/v", { "if-none-match": 'W/"v42"' }), {})
		expect(second.status).toBe(304)
	})

	it("If-None-Match uses weak comparison and parses lists", async () => {
		const app = honey<{}>().use(etag({ weak: false }))
		app.get("/d").handler((ctx) => ctx.res.json("ok", { a: 1 }))
		const tag = (await app.fetch(get("/d"), {})).headers.get("etag") ?? ""
		expect(tag.startsWith('"')).toBe(true)
		const weakForm = `W/${tag}`
		expect((await app.fetch(get("/d", { "if-none-match": weakForm }), {})).status).toBe(304)
		expect((await app.fetch(get("/d", { "if-none-match": `"a,b", ${tag}` }), {})).status).toBe(304)
		expect((await app.fetch(get("/d", { "if-none-match": `"other"` }), {})).status).toBe(200)
	})

	it("only 200 responses get an ETag or a 304", async () => {
		const app = honey<{}>().use(etag())
		app.get("/created").handler((ctx) => ctx.res.json("created", { id: 1 }))
		app.get("/redirect").handler(() => new Response(null, { headers: { location: "/" }, status: 302 }))
		const created = await app.fetch(get("/created", { "if-none-match": "*" }), {})
		expect(created.status).toBe(201)
		expect(created.headers.get("etag")).toBeNull()
		const redirect = await app.fetch(get("/redirect", { "if-none-match": "*" }), {})
		expect(redirect.status).toBe(302)
	})

	it("a zero-length native body comes back readable", async () => {
		const app = honey<{}>().use(etag())
		app.get("/empty").handler(() => new Response(new Uint8Array(0), { headers: { "content-length": "0" } }))
		const res = await app.fetch(get("/empty"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("")
	})

	it("a native body with content-length is hashed and returned intact", async () => {
		const app = honey<{}>().use(etag())
		app.get("/sized").handler(() => new Response("hello", { headers: { "content-length": "5" } }))
		const res = await app.fetch(get("/sized"), {})
		expect(res.headers.get("etag")).toMatch(/^W\/"[A-Za-z0-9_-]{22}"$/)
		expect(await res.text()).toBe("hello")
	})
})

describe("ifNoneMatchHits", () => {
	it("matches *, weak and strong forms", () => {
		expect(ifNoneMatchHits("*", '"x"')).toBe(true)
		expect(ifNoneMatchHits('W/"x"', '"x"')).toBe(true)
		expect(ifNoneMatchHits('"x"', 'W/"x"')).toBe(true)
		expect(ifNoneMatchHits('"y", W/"x"', '"x"')).toBe(true)
		expect(ifNoneMatchHits('"xx"', '"x"')).toBe(false)
		expect(ifNoneMatchHits(null, '"x"')).toBe(false)
	})
})
