import { type } from "arktype"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { bodyLimit } from "../../../src/body-limit.ts"
import { honey } from "../../../src/index.ts"
import { validateInput } from "../../../src/validation.ts"

const get = (url: string) => new Request(`http://localhost${url}`)

describe("duplicate search keys: one policy for search and form", () => {
	it("zod: array-typed keys always get arrays, scalar-typed keys the first value", async () => {
		const schema = z.object({
			ids: z.array(z.string()),
			role: z.string(),
			u: z.union([z.string(), z.array(z.string())]),
		})
		const one = await validateInput({ search: schema }, get("/?ids=1&role=user&u=a"), {})
		expect(one.search).toEqual({ ids: ["1"], role: "user", u: "a" })
		const many = await validateInput({ search: schema }, get("/?ids=1&ids=2&role=user&role=admin&u=a&u=b"), {})
		expect(many.search).toEqual({ ids: ["1", "2"], role: "user", u: ["a", "b"] })
	})

	it("zod: optional and coerced fields keep their shape", async () => {
		const schema = z.object({ page: z.coerce.number().optional(), tags: z.array(z.string()).default([]) })
		const r = await validateInput({ search: schema }, get("/?page=2&page=9&tags=x"), {})
		expect(r.search).toEqual({ page: 2, tags: ["x"] })
	})

	it("arktype describes itself too", async () => {
		const schema = type({ ids: "string[]", role: "string" })
		const r = await validateInput({ search: schema }, get("/?ids=1&role=user&role=admin"), {})
		expect(r.search).toEqual({ ids: ["1"], role: "user" })
	})

	it("valibot has no Standard JSON Schema: one value is a scalar, repeats are an array", async () => {
		const schema = v.object({ ids: v.union([v.string(), v.array(v.string())]) })
		expect((await validateInput({ search: schema }, get("/?ids=1"), {})).search).toEqual({ ids: "1" })
		expect((await validateInput({ search: schema }, get("/?ids=1&ids=2"), {})).search).toEqual({ ids: ["1", "2"] })
	})

	it("validated search and ctx.search agree on the first value", async () => {
		const app = honey<{}>()
		app
			.get("/s")
			.input({ search: z.object({ role: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", { raw: ctx.search["role"], validated: ctx.input.search.role }))
		const res = await app.fetch(get("/s?role=user&role=admin"), {})
		expect(await res.json()).toEqual({ raw: "user", validated: "user" })
	})

	it("urlencoded form follows the same policy", async () => {
		const schema = z.object({ role: z.string(), tags: z.array(z.string()) })
		const req = new Request("http://localhost/", {
			body: "role=user&role=admin&tags=a",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
		})
		expect((await validateInput({ form: schema }, req, {})).form).toEqual({ role: "user", tags: ["a"] })
	})
})

describe("body parse failures are 400 malformed_body", () => {
	const app = honey<{}>()
	app
		.post("/j")
		.input({ json: z.object({ a: z.number() }) })
		.handler((ctx) => ctx.res.json("ok", ctx.input.json))
	app
		.post("/f")
		.input({ form: z.object({ a: z.string() }) })
		.handler((ctx) => ctx.res.json("ok", ctx.input.form))

	it("broken multipart → 400", async () => {
		const res = await app.fetch(
			new Request("http://localhost/f", {
				body: "--x\r\nnot a part",
				headers: { "content-type": "multipart/form-data; boundary=x" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error_key: string }).error_key).toBe("malformed_body")
	})

	it("an upper-case or +json media type is parsed as JSON", async () => {
		for (const ct of ["Application/JSON", "application/vnd.api+json"]) {
			const res = await app.fetch(
				new Request("http://localhost/j", { body: '{"a":1}', headers: { "content-type": ct }, method: "POST" }),
				{},
			)
			expect(res.status).toBe(200)
		}
	})

	it("application/jsonx is not JSON → 415", async () => {
		const res = await app.fetch(
			new Request("http://localhost/j", {
				body: '{"a":1}',
				headers: { "content-type": "application/jsonx" },
				method: "POST",
			}),
			{},
		)
		expect(res.status).toBe(415)
	})

	it("a bodyLimit overflow while reading stays 413, not malformed_body", async () => {
		const limited = honey<{}>().use(bodyLimit({ maxSize: 8 }))
		limited
			.post("/j")
			.input({ json: z.object({ a: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json))
		const big = JSON.stringify({ a: "x".repeat(100) })
		const stream = new ReadableStream({
			start(c) {
				c.enqueue(new TextEncoder().encode(big))
				c.close()
			},
		})
		const res = await limited.fetch(
			new Request("http://localhost/j", {
				body: stream,
				duplex: "half",
				headers: { "content-type": "application/json" },
				method: "POST",
			} as RequestInit),
			{},
		)
		expect(res.status).toBe(413)
	})
})

describe("body schemas on GET/HEAD are rejected at registration", () => {
	it("throws naming the route", () => {
		expect(() =>
			honey<{}>()
				.get("/x")
				.input({ json: z.object({}) })
				.handler((ctx) => ctx.res.text("ok", "ok")),
		).toThrow(/GET \/x declares a json body schema/)
	})

	it("every other method validates its body, DELETE included", async () => {
		const app = honey<{}>()
		app
			.delete("/d")
			.input({ json: z.object({ reason: z.string() }) })
			.handler((ctx) => ctx.res.json("ok", ctx.input.json))
		const bad = await app.fetch(
			new Request("http://localhost/d", {
				body: '{"reason":1}',
				headers: { "content-type": "application/json" },
				method: "DELETE",
			}),
			{},
		)
		expect(bad.status).toBe(400)
		const none = await app.fetch(new Request("http://localhost/d", { method: "DELETE" }), {})
		expect(none.status).toBe(415)
	})
})
