import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"

describe("audit: validation.ts status code mismatch", () => {
	it("POST with wrong content-type to JSON-only route → 415 not 422", async () => {
		const app = honey()
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { name: ctx.input.json.name }))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: "name=test",
				headers: { "content-type": "text/plain" },
				method: "POST",
			}),
			{},
		)

		/* 415 Unsupported Media Type — server doesn't accept text/plain for this route */
		expect(res.status).toBe(415)
		const body = (await res.json()) as { error_key: string; status: number }
		expect(body.error_key).toBe("unsupported_media_type")
		expect(body.status).toBe(415)
	})

	it("POST with wrong content-type to form-only route → 415", async () => {
		const app = honey()
			.post("/upload")
			.input({ form: z.object({ file: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { file: ctx.input.form.file }))

		const res = await app.fetch(
			new Request("http://localhost/upload", {
				body: JSON.stringify({ file: "test" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)

		expect(res.status).toBe(415)
	})

	it("POST with correct content-type but invalid body → 400 (validation, not 415)", async () => {
		const app = honey()
			.post("/items")
			.input({ json: z.object({ name: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { name: ctx.input.json.name }))

		const res = await app.fetch(
			new Request("http://localhost/items", {
				body: JSON.stringify({ wrong: "field" }),
				headers: { "content-type": "application/json" },
				method: "POST",
			}),
			{},
		)

		/* 400 Bad Request — correct content-type, invalid body */
		expect(res.status).toBe(400)
	})
})

describe("audit: secure-headers mutates response headers", () => {
	it("secure-headers adds headers to response", async () => {
		const { secureHeaders } = await import("../../../src/secure-headers.ts")

		const app = honey()
			.use(secureHeaders())
			.get("/test")
			.handler((ctx) => ctx.res.text("ok", "hello"))

		const res = await app.fetch(new Request("http://localhost/test"), {})

		expect(res.status).toBe(200)
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
		expect(await res.text()).toBe("hello")
	})
})

describe("audit: etag middleware works on normal responses", () => {
	it("etag generates ETag and handles conditional GET", async () => {
		const { etag } = await import("../../../src/etag.ts")

		const app = honey()
			.use(etag())
			.get("/data")
			.handler((ctx) => ctx.res.json("ok", { value: 42 }))

		/* first request — should get ETag */
		const res1 = await app.fetch(new Request("http://localhost/data"), {})
		expect(res1.status).toBe(200)
		const etagValue = res1.headers.get("etag")
		expect(etagValue).toBeTruthy()

		/* conditional request with matching ETag → 304 */
		const res2 = await app.fetch(
			new Request("http://localhost/data", {
				headers: { "if-none-match": etagValue ?? "" },
			}),
			{},
		)
		expect(res2.status).toBe(304)
	})
})
