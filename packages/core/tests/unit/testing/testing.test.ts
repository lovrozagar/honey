import { describe, expect, it } from "vitest"
import { honey } from "../../../src/index.ts"
import { testClient } from "../../../src/testing.ts"

function makeApp() {
	const h = honey<{ secret: string }>()
	h.get("/health").handler((ctx) => ctx.res.json("ok", { status: "ok" }))
	h.post("/echo").handler(async (ctx) => {
		const body = (await ctx.req.json()) as Record<string, unknown>
		return ctx.res.json("created", { data: body, secret: ctx.env.secret })
	})
	h.get("/search").handler((ctx) => ctx.res.json("ok", { search: ctx.search }))
	h.put("/items/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
	h.patch("/items/:id").handler((ctx) => ctx.res.text("ok", "patched"))
	h.delete("/items/:id").handler((ctx) => ctx.res.noContent())
	h.options("/preflight").handler((ctx) => ctx.res.noContent())
	h.head("/health").handler((ctx) => ctx.res.raw(new Response(null, { status: 200 })))
	return h
}

describe("testClient", () => {
	it("get(/path) → GET method", async () => {
		const client = testClient(makeApp(), { env: { secret: "s" } })
		const res = await client.get("/health")
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ status: "ok" })
	})

	it("post with json body", async () => {
		const client = testClient(makeApp(), { env: { secret: "abc" } })
		const res = await client.post("/echo", { json: { name: "test" } })
		expect(res.status).toBe(201)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.data).toEqual({ name: "test" })
		expect(body.secret).toBe("abc")
	})

	it("post with form body", async () => {
		const h = honey<{}>()
		h.post("/form").handler(async (ctx) => {
			const formData = await ctx.req.formData()
			return ctx.res.json("ok", { key: formData.get("key") })
		})
		const client = testClient(h, { env: {} })
		const res = await client.post("/form", { form: { key: "val" } })
		expect(res.status).toBe(200)
	})

	it("put, patch, delete → correct methods", async () => {
		const client = testClient(makeApp(), { env: { secret: "s" } })

		const putRes = await client.put("/items/42")
		expect(putRes.status).toBe(200)
		expect(((await putRes.json()) as Record<string, unknown>).id).toBe("42")

		const patchRes = await client.patch("/items/42")
		expect(patchRes.status).toBe(200)

		const deleteRes = await client.delete("/items/42")
		expect(deleteRes.status).toBe(204)
	})

	it("options method", async () => {
		const client = testClient(makeApp(), { env: { secret: "s" } })
		const res = await client.options("/preflight")
		expect(res.status).toBe(204)
	})

	it("head method", async () => {
		const client = testClient(makeApp(), { env: { secret: "s" } })
		const res = await client.head("/health")
		expect(res.status).toBe(200)
	})

	it("custom headers", async () => {
		const h = honey<{}>()
		h.get("/headers").handler((ctx) =>
			ctx.res.json("ok", { auth: ctx.req.headers.get("authorization") }),
		)
		const client = testClient(h, { env: {} })
		const res = await client.get("/headers", { headers: { authorization: "Bearer tok" } })
		const body = (await res.json()) as Record<string, unknown>
		expect(body.auth).toBe("Bearer tok")
	})

	it("search params appended to URL", async () => {
		const client = testClient(makeApp(), { env: { secret: "s" } })
		const res = await client.get("/search", { search: { page: "1", q: "hello" } })
		const body = (await res.json()) as Record<string, unknown>
		expect((body.search as Record<string, unknown>).page).toBe("1")
		expect((body.search as Record<string, unknown>).q).toBe("hello")
	})

	it("request escape hatch", async () => {
		const client = testClient(makeApp(), { env: { secret: "s" } })
		const res = await client.request("GET", "/health")
		expect(res.status).toBe(200)
	})

	it("env passed through", async () => {
		const client = testClient(makeApp(), { env: { secret: "magic" } })
		const res = await client.post("/echo", { json: {} })
		const body = (await res.json()) as Record<string, unknown>
		expect(body.secret).toBe("magic")
	})

	it("response is raw Web Response", async () => {
		const client = testClient(makeApp(), { env: { secret: "s" } })
		const res = await client.get("/health")
		expect(res).toBeInstanceOf(Response)
	})
})
