import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"
import type { TypedResponse } from "../../../src/response.ts"
import { HoneyRes } from "../../../src/response.ts"

describe("TypedResponse branding", () => {
	const res = new HoneyRes()

	it("json returns TypedResponse<'application/json', SK>", () => {
		const r = res.json("ok", { id: "1" })
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"application/json", "ok">>()
	})

	it("json with 'created' status key", () => {
		const r = res.json("created", { id: "1" })
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"application/json", "created">>()
	})

	it("text returns TypedResponse<'text/plain', SK>", () => {
		const r = res.text("ok", "hello")
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"text/plain", "ok">>()
	})

	it("html returns TypedResponse<'text/html', SK>", () => {
		const r = res.html("ok", "<h1>hi</h1>")
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"text/html", "ok">>()
	})

	it("csv returns TypedResponse<'text/csv', SK>", () => {
		const r = res.csv("ok", "a,b,c")
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"text/csv", "ok">>()
	})

	it("binary returns TypedResponse<'application/octet-stream', SK>", () => {
		const r = res.binary("ok", new Uint8Array([1, 2, 3]))
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"application/octet-stream", "ok">>()
	})

	it("xml returns TypedResponse<'application/xml', SK>", () => {
		const r = res.xml("ok", "<root />")
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"application/xml", "ok">>()
	})

	it("noContent returns TypedResponse<'none', 'no_content'>", () => {
		const r = res.noContent()
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"none", "no_content">>()
	})

	it("redirect returns TypedResponse<'none', 'found'>", () => {
		const r = res.redirect("/login")
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"none", "found">>()
	})

	it("sse returns TypedResponse<'text/event-stream', 'ok'>", () => {
		const r = res.sse(async () => {})
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"text/event-stream", "ok">>()
	})

	it("stream returns TypedResponse<'application/octet-stream', 'ok'>", () => {
		const r = res.stream(async () => {})
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"application/octet-stream", "ok">>()
	})

	it("raw returns TypedResponse with generic brands", () => {
		const r = res.raw(new Response("test"))
		expectTypeOf(r).toEqualTypeOf<TypedResponse<string, string>>()
	})
})

describe("output-constrained status keys", () => {
	it("json status key constrained to declared output keys", () => {
		honey<{}>()
			.get("/users")
			.output({
				"application/json": {
					created: z.object({ id: z.string() }),
					ok: z.object({ id: z.string() }),
				},
			})
			.handler((ctx) => {
				/* "ok" and "created" are the only valid status keys */
				const r = ctx.res.json("ok", { id: "1" })
				expectTypeOf(r).toEqualTypeOf<TypedResponse<"application/json", "ok">>()
				return r
			})
	})
})

describe("TypedResponse edge cases", () => {
	it("redirect with custom status returns TypedResponse<'none', 'found'>", () => {
		const res = new HoneyRes()
		const r = res.redirect("/login", { status: 301 })
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"none", "found">>()
	})

	it("generate returns TypedResponse<string, 'ok'>", () => {
		const res = new HoneyRes()
		const gen = (async function* () {
			yield "chunk"
		})()
		const r = res.generate(gen)
		expectTypeOf(r).toEqualTypeOf<TypedResponse<string, "ok">>()
	})

	it("json with error status key", () => {
		const res = new HoneyRes()
		const r = res.json("bad_request", { error: "invalid" })
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"application/json", "bad_request">>()
	})

	it("text with created status key", () => {
		const res = new HoneyRes()
		const r = res.text("created", "done")
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"text/plain", "created">>()
	})

	it("binary with accepted status key", () => {
		const res = new HoneyRes()
		const r = res.binary("accepted", new Uint8Array())
		expectTypeOf(r).toEqualTypeOf<TypedResponse<"application/octet-stream", "accepted">>()
	})
})

describe("multi-status output with different body shapes", () => {
	it("handler can return different status keys with matching body types", () => {
		honey<{}>()
			.get("/users/:id")
			.output({
				"application/json": {
					not_found: z.object({ error: z.string() }),
					ok: z.object({ id: z.string(), name: z.string() }),
				},
			})
			.handler((ctx) => {
				const okRes = ctx.res.json("ok", { id: "1", name: "test" })
				expectTypeOf(okRes).toEqualTypeOf<TypedResponse<"application/json", "ok">>()

				const errRes = ctx.res.json("not_found", { error: "not found" })
				expectTypeOf(errRes).toEqualTypeOf<TypedResponse<"application/json", "not_found">>()

				return okRes
			})
	})
})

describe("output constrains method availability per content type", () => {
	it("text/plain output — only text method + universals", () => {
		honey<{}>()
			.get("/msg")
			.output({ "text/plain": { ok: z.string() } })
			.handler((ctx) => {
				expectTypeOf(ctx.res.text).toBeFunction()
				expectTypeOf(ctx.res.noContent).toBeFunction()
				expectTypeOf(ctx.res.redirect).toBeFunction()
				expectTypeOf(ctx.res.raw).toBeFunction()
				expectTypeOf(ctx.res.stream).toBeFunction()
				expectTypeOf(ctx.res).not.toHaveProperty("json")
				expectTypeOf(ctx.res).not.toHaveProperty("html")
				return ctx.res.text("ok", "hello")
			})
	})

	it("text/csv output — only csv method + universals", () => {
		honey<{}>()
			.get("/export")
			.output({ "text/csv": { ok: z.string() } })
			.handler((ctx) => {
				expectTypeOf(ctx.res.csv).toBeFunction()
				expectTypeOf(ctx.res).not.toHaveProperty("json")
				expectTypeOf(ctx.res).not.toHaveProperty("text")
				return ctx.res.csv("ok", "a,b,c")
			})
	})

	it("application/xml output — only xml method + universals", () => {
		honey<{}>()
			.get("/feed")
			.output({ "application/xml": { ok: z.string() } })
			.handler((ctx) => {
				expectTypeOf(ctx.res.xml).toBeFunction()
				expectTypeOf(ctx.res).not.toHaveProperty("json")
				expectTypeOf(ctx.res).not.toHaveProperty("html")
				return ctx.res.xml("ok", "<root/>")
			})
	})

	it("binary output — only binary method + universals", () => {
		honey<{}>()
			.get("/file")
			.output({ "application/octet-stream": { ok: z.instanceof(Uint8Array) } })
			.handler((ctx) => {
				expectTypeOf(ctx.res.binary).toBeFunction()
				expectTypeOf(ctx.res).not.toHaveProperty("json")
				expectTypeOf(ctx.res).not.toHaveProperty("text")
				return ctx.res.binary("ok", new Uint8Array())
			})
	})
})

describe("TypedResponse brand isolation", () => {
	it("json and text responses have different brands", () => {
		const res = new HoneyRes()
		const jsonRes = res.json("ok", {})
		const textRes = res.text("ok", "hello")

		expectTypeOf(jsonRes).not.toMatchTypeOf<TypedResponse<"text/plain", "ok">>()
		expectTypeOf(textRes).not.toMatchTypeOf<TypedResponse<"application/json", "ok">>()
	})

	it("same CT different SK have different brands", () => {
		const res = new HoneyRes()
		const okRes = res.json("ok", {})
		const createdRes = res.json("created", {})

		expectTypeOf(okRes).not.toMatchTypeOf<TypedResponse<"application/json", "created">>()
		expectTypeOf(createdRes).not.toMatchTypeOf<TypedResponse<"application/json", "ok">>()
	})

	it("TypedResponse extends Response", () => {
		const res = new HoneyRes()
		const r = res.json("ok", {})
		expectTypeOf(r).toMatchTypeOf<Response>()
	})
})

describe("multi-CT output with different status keys", () => {
	it("json + html with different status keys — both methods available", () => {
		honey<{}>()
			.get("/report")
			.output({
				"application/json": {
					ok: z.object({ data: z.string().array() }),
				},
				"text/html": {
					ok: z.string(),
				},
			})
			.handler((ctx) => {
				expectTypeOf(ctx.res.json).toBeFunction()
				expectTypeOf(ctx.res.html).toBeFunction()
				expectTypeOf(ctx.res).not.toHaveProperty("text")
				expectTypeOf(ctx.res).not.toHaveProperty("csv")
				expectTypeOf(ctx.res).not.toHaveProperty("binary")
				return ctx.res.json("ok", { data: ["a"] })
			})
	})

	it("json + csv + binary — three methods available", () => {
		honey<{}>()
			.get("/export")
			.output({
				"application/json": { ok: z.object({ rows: z.number() }) },
				"application/octet-stream": { ok: z.instanceof(Uint8Array) },
				"text/csv": { ok: z.string() },
			})
			.handler((ctx) => {
				expectTypeOf(ctx.res.json).toBeFunction()
				expectTypeOf(ctx.res.csv).toBeFunction()
				expectTypeOf(ctx.res.binary).toBeFunction()
				expectTypeOf(ctx.res).not.toHaveProperty("text")
				expectTypeOf(ctx.res).not.toHaveProperty("html")
				expectTypeOf(ctx.res).not.toHaveProperty("xml")
				return ctx.res.json("ok", { rows: 10 })
			})
	})
})
