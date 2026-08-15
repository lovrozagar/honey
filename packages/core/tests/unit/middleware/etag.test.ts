import { describe, expect, it } from "vitest"
import { etag } from "../../../src/etag.ts"
import { honey } from "../../../src/index.ts"

function makeApp(opts?: Parameters<typeof etag>[0]) {
	const app = honey<{}>().use(etag(opts))
	app.get("/data").handler((ctx) => ctx.res.json("ok", { items: ["a", "b", "c"], total: 3 }))
	app.post("/create").handler((ctx) => ctx.res.json("created", { id: "1" }))
	app.get("/stream").handler((ctx) =>
		ctx.res.stream(async (writable) => {
			const writer = writable.getWriter()
			await writer.write(new TextEncoder().encode("chunk"))
			await writer.close()
		}),
	)
	return app
}

describe("etag middleware — internal", () => {
	it("GET response gets ETag header", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/data"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("etag")).toBeTruthy()
	})

	it("matching If-None-Match → 304 empty body", async () => {
		const app = makeApp()
		const first = await app.fetch(new Request("http://localhost/data"), {})
		const etagVal = first.headers.get("etag")
		expect(etagVal).toBeTruthy()

		const second = await app.fetch(
			new Request("http://localhost/data", {
				headers: { "if-none-match": etagVal ?? "" },
			}),
			{},
		)
		expect(second.status).toBe(304)
		expect(await second.text()).toBe("")
	})

	it("non-matching If-None-Match → 200 full body with new ETag", async () => {
		const app = makeApp()
		const res = await app.fetch(
			new Request("http://localhost/data", {
				headers: { "if-none-match": '"stale-hash"' },
			}),
			{},
		)
		expect(res.status).toBe(200)
		expect(res.headers.get("etag")).toBeTruthy()
		const body = (await res.json()) as Record<string, unknown>
		expect(body.total).toBe(3)
	})

	it("POST → no ETag", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/create", { method: "POST" }), {})
		expect(res.status).toBe(201)
		expect(res.headers.get("etag")).toBeNull()
	})

	it("same response body → same ETag (deterministic)", async () => {
		const app = makeApp()
		const r1 = await app.fetch(new Request("http://localhost/data"), {})
		const r2 = await app.fetch(new Request("http://localhost/data"), {})
		expect(r1.headers.get("etag")).toBe(r2.headers.get("etag"))
	})

	it("ETag format is weak validator by default", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/data"), {})
		const etagVal = res.headers.get("etag") ?? ""
		expect(etagVal.startsWith('W/"')).toBe(true)
		expect(etagVal.endsWith('"')).toBe(true)
	})

	it("strong validator when weak: false", async () => {
		const app = makeApp({ weak: false })
		const res = await app.fetch(new Request("http://localhost/data"), {})
		const etagVal = res.headers.get("etag") ?? ""
		expect(etagVal.startsWith('"')).toBe(true)
		expect(etagVal.startsWith('W/"')).toBe(false)
	})

	it("streaming response → ETag skipped", async () => {
		const app = makeApp()
		const res = await app.fetch(new Request("http://localhost/stream"), {})
		expect(res.status).toBe(200)
		expect(res.headers.get("etag")).toBeNull()
	})
})

describe("etag middleware — consumer", () => {
	it("JSON API cache hit: first GET → 200, second → 304", async () => {
		const app = makeApp()
		const first = await app.fetch(new Request("http://localhost/data"), {})
		expect(first.status).toBe(200)
		const tag = first.headers.get("etag")

		const second = await app.fetch(
			new Request("http://localhost/data", {
				headers: { "if-none-match": tag ?? "" },
			}),
			{},
		)
		expect(second.status).toBe(304)
	})

	it("304 response preserves original headers", async () => {
		const app = makeApp()
		const first = await app.fetch(new Request("http://localhost/data"), {})
		const tag = first.headers.get("etag")

		const second = await app.fetch(
			new Request("http://localhost/data", {
				headers: { "if-none-match": tag ?? "" },
			}),
			{},
		)
		expect(second.headers.get("content-type")).toBeTruthy()
	})
})
