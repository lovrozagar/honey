import { type } from "arktype"
import { Schema } from "effect"
import * as v from "valibot"
import { describe, expect, it } from "vitest"
import * as yup from "yup"
import { z } from "zod"
import { honey } from "../../src/index.ts"

/*
 * Every validator the README lists, installed for real, through `.input()` on each request
 * source: a valid request reaches the handler with the parsed (and transformed) value, an
 * invalid one is a 400 naming the field, and a missing required field is a 400 too. Codegen
 * coverage for these libraries lives in tests/unit/codegen; this is the runtime path.
 */

type Schemas = {
	/** `{ name: string, age: integer >= 0 }` */
	body: unknown
	/** `{ q: string }`, required */
	search: unknown
	/** `{ "x-tenant": string }`, required */
	headers: unknown
	/** `{ name: string }` whose output trims and upper-cases the name */
	transform: unknown
}

const ss = Schema.standardSchemaV1

const LIBRARIES: Record<string, Schemas> = {
	arktype: {
		body: type({ age: "number.integer >= 0", name: "string" }),
		headers: type({ "x-tenant": "string" }),
		search: type({ q: "string" }),
		transform: type({ name: type("string").pipe((s) => s.trim().toUpperCase()) }),
	},
	effect: {
		body: ss(Schema.Struct({ age: Schema.Int.pipe(Schema.nonNegative()), name: Schema.String })),
		headers: ss(Schema.Struct({ "x-tenant": Schema.String })),
		search: ss(Schema.Struct({ q: Schema.String })),
		transform: ss(
			Schema.Struct({
				name: Schema.transform(Schema.String, Schema.String, {
					decode: (s) => s.trim().toUpperCase(),
					encode: (s) => s,
				}),
			}),
		),
	},
	valibot: {
		body: v.object({ age: v.pipe(v.number(), v.integer(), v.minValue(0)), name: v.string() }),
		headers: v.object({ "x-tenant": v.string() }),
		search: v.object({ q: v.string() }),
		transform: v.object({
			name: v.pipe(
				v.string(),
				v.transform((s) => s.trim().toUpperCase()),
			),
		}),
	},
	yup: {
		body: yup.object({ age: yup.number().integer().min(0).required(), name: yup.string().required() }),
		headers: yup.object({ "x-tenant": yup.string().required() }),
		search: yup.object({ q: yup.string().required() }),
		transform: yup.object({
			name: yup
				.string()
				.required()
				.transform((s: string) => s.trim().toUpperCase()),
		}),
	},
	zod: {
		body: z.object({ age: z.number().int().min(0), name: z.string() }),
		headers: z.object({ "x-tenant": z.string() }),
		search: z.object({ q: z.string() }),
		transform: z.object({ name: z.string().transform((s) => s.trim().toUpperCase()) }),
	},
}

type Body = { error_key?: string; fields?: Record<string, Array<{ path: string }>> }

function buildApp(s: Schemas) {
	const app = honey()
	app
		.post("/body")
		.input({ json: s.body as never })
		.handler((c) => c.res.json("ok", c.input.json as object))
	app
		.get("/search")
		.input({ search: s.search as never })
		.handler((c) => c.res.json("ok", c.input.search as object))
	app
		.get("/headers")
		.input({ headers: s.headers as never })
		.handler((c) => c.res.json("ok", c.input.headers as object))
	app
		.post("/transform")
		.input({ json: s.transform as never })
		.handler((c) => c.res.json("ok", c.input.json as object))
	return app
}

const json = (path: string, body: unknown) =>
	new Request(`http://x${path}`, {
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		method: "POST",
	})

for (const [lib, schemas] of Object.entries(LIBRARIES)) {
	describe(`.input() with ${lib}`, () => {
		const app = buildApp(schemas)
		const send = async (req: Request) => {
			const res = await app.fetch(req, {})
			return { body: (await res.json()) as Body & Record<string, unknown>, status: res.status }
		}

		it("json: valid reaches the handler, invalid and missing fields are a 400 naming the field", async () => {
			expect(await send(json("/body", { age: 3, name: "a" }))).toEqual({ body: { age: 3, name: "a" }, status: 200 })
			const bad = await send(json("/body", { age: "x", name: "a" }))
			expect(bad.status).toBe(400)
			expect(bad.body.error_key).toBe("validation_failed")
			expect(bad.body.fields?.age?.[0]?.path).toBe("json.age")
			const negative = await send(json("/body", { age: -1, name: "a" }))
			expect(negative.status).toBe(400)
			expect(Object.keys(negative.body.fields ?? {})).toEqual(["age"])
			const missing = await send(json("/body", { age: 1 }))
			expect(missing.status).toBe(400)
			expect(Object.keys(missing.body.fields ?? {})).toEqual(["name"])
		})

		it("search and headers validate the request's own values", async () => {
			expect(await send(new Request("http://x/search?q=hello"))).toEqual({ body: { q: "hello" }, status: 200 })
			const noQ = await send(new Request("http://x/search"))
			expect(noQ.status).toBe(400)
			expect(noQ.body.fields?.q?.[0]?.path).toBe("search.q")
			const tenant = await send(new Request("http://x/headers", { headers: { "x-tenant": "acme" } }))
			expect(tenant.status).toBe(200)
			expect(tenant.body["x-tenant"]).toBe("acme")
			expect((await send(new Request("http://x/headers"))).status).toBe(400)
		})

		it("the handler gets the schema's output, not the raw input", async () => {
			expect(await send(json("/transform", { name: "  ada " }))).toEqual({ body: { name: "ADA" }, status: 200 })
		})
	})
}
