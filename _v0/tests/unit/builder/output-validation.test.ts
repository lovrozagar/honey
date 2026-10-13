import { describe, expect, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"

describe("Output validation wiring", () => {
	it("valid output → 200 passes through", async () => {
		const h = honey<{}>()
		h.outputValidation("always")
		h.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "abc" }))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBe("abc")
	})

	it("invalid output data → 500 when outputValidation is 'always'", async () => {
		const h = honey<{}>()
		h.outputValidation("always")
		h.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => {
				/* intentionally return wrong data shape via raw escape hatch */
				return ctx.res.raw(
					new Response(JSON.stringify({ wrong: 123 }), {
						headers: { "content-type": "application/json" },
						status: 200,
					}),
				)
			})

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("output_validation_failed")
	})

	it("no output schema → skips validation", async () => {
		const h = honey<{}>()
		h.outputValidation("always")
		h.get("/test").handler((ctx) => ctx.res.json("ok", { anything: true }))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})

	it("outputValidation 'off' → skips even with schemas", async () => {
		const h = honey<{}>()
		h.outputValidation("off")
		h.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => {
				return ctx.res.raw(
					new Response(JSON.stringify({ wrong: 123 }), {
						headers: { "content-type": "application/json" },
						status: 200,
					}),
				)
			})

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
	})

	it("non-json content-type with only json output declared → content-type mismatch 500", async () => {
		const h = honey<{}>()
		h.outputValidation("always")
		h.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) =>
				ctx.res.raw(
					new Response("plain text", {
						headers: { "content-type": "text/plain" },
						status: 200,
					}),
				),
			)

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(500)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.error_key).toBe("output_content_type_mismatch")
	})

	it("non-json content-type with text declared → skips json schema validation", async () => {
		const h = honey<{}>()
		h.outputValidation("always")
		h.get("/test")
			.output({
				"application/json": { ok: z.object({ id: z.string() }) },
				"text/plain": { ok: z.string() },
			})
			.handler((ctx) => ctx.res.text("ok", "plain text"))

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe("plain text")
	})

	it("status code maps to correct schema", async () => {
		const h = honey<{}>()
		h.outputValidation("always")
		h.post("/test")
			.output({
				"application/json": {
					created: z.object({ id: z.string() }),
					ok: z.object({ items: z.string().array() }),
				},
			})
			.handler((ctx) => ctx.res.json("created", { id: "new-1" }))

		const res = await h.fetch(new Request("http://localhost/test", { method: "POST" }), {})
		expect(res.status).toBe(201)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.id).toBe("new-1")
	})

	it("unregistered status code with schema → passes (no schema for that status)", async () => {
		const h = honey<{}>()
		h.outputValidation("always")
		h.get("/test")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => {
				return ctx.res.raw(
					new Response(JSON.stringify({ data: "whatever" }), {
						headers: { "content-type": "application/json" },
						status: 202,
					}),
				)
			})

		const res = await h.fetch(new Request("http://localhost/test"), {})
		expect(res.status).toBe(202)
	})
})
