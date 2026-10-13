import { describe, expect, it } from "vitest"
import { z } from "zod"
import * as codegenPublic from "../../../src/codegen.ts"
import { generateOpenApi } from "../../../src/codegen.ts"
import { resetCodegenJsonSchemaLoadersForTests } from "../../../src/codegen-loaders.ts"
import { honey } from "../../../src/index.ts"

describe('zod JSON Schema without import("zod")', () => {
	it("does not export the test loader reset from codegen.ts", () => {
		expect(Object.hasOwn(codegenPublic, "resetCodegenJsonSchemaLoadersForTests")).toBe(false)
	})

	it("emits object properties via ~standard.jsonSchema when the module loader is empty", async () => {
		resetCodegenJsonSchemaLoadersForTests()

		const app = honey()
			.get("/x")
			.output({ "application/json": { ok: z.object({ id: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const spec = await generateOpenApi(app, { info: { title: "t", version: "1" } })
		const named = spec.components?.schemas?.ListXResponse200 as Record<string, unknown> | undefined
		const inline = spec.paths["/x"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema as
			| Record<string, unknown>
			| undefined

		const schema = named ?? inline
		expect(schema).toBeDefined()
		expect(schema?.vendor).toBeUndefined()
		expect(schema?.types).toBeUndefined()
		expect(schema?.type).toBe("object")
		expect(schema?.properties).toMatchObject({ id: { type: "string" } })
		expect(schema?.required).toEqual(["id"])
	})

	it("walks _zod.def when instance converters are missing", async () => {
		resetCodegenJsonSchemaLoadersForTests()
		const raw = z.object({ id: z.string() })
		const stripped = Object.create(raw) as typeof raw
		Object.defineProperty(stripped, "~standard", {
			value: { vendor: "zod", version: 1 },
		})
		Object.defineProperty(stripped, "toJSONSchema", { value: undefined })

		const app = honey()
			.get("/y")
			.output({ "application/json": { ok: stripped } })
			.handler((ctx) => ctx.res.json("ok", { id: "1" }))

		const spec = await generateOpenApi(app, { info: { title: "t", version: "1" } })
		const named = spec.components?.schemas?.ListYResponse200 as Record<string, unknown> | undefined
		const inline = spec.paths["/y"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema as
			| Record<string, unknown>
			| undefined
		const schema = named ?? inline
		expect(schema?.type).toBe("object")
		expect(schema?.properties).toMatchObject({ id: { type: "string" } })
	})

	it("def-walker keeps email/uuid/minLength/minimum from Zod bag", async () => {
		resetCodegenJsonSchemaLoadersForTests()
		const raw = z.object({
			email: z.string().email(),
			id: z.string().uuid(),
			n: z.number().min(1).max(10),
			tag: z.string().min(3),
		})
		const stripped = Object.create(raw) as typeof raw
		Object.defineProperty(stripped, "~standard", {
			value: { vendor: "zod", version: 1 },
		})
		Object.defineProperty(stripped, "toJSONSchema", { value: undefined })

		const app = honey()
			.get("/z")
			.output({ "application/json": { ok: stripped } })
			.handler((ctx) =>
				ctx.res.json("ok", { email: "a@b.c", id: "00000000-0000-4000-8000-000000000000", n: 2, tag: "abc" }),
			)

		const spec = await generateOpenApi(app, { info: { title: "t", version: "1" } })
		const named = spec.components?.schemas?.ListZResponse200 as Record<string, unknown> | undefined
		const inline = spec.paths["/z"]?.get?.responses?.["200"]?.content?.["application/json"]?.schema as
			| Record<string, unknown>
			| undefined
		const props = ((named ?? inline)?.properties ?? {}) as Record<string, Record<string, unknown>>
		expect(props.email).toMatchObject({ format: "email", type: "string" })
		expect(props.id).toMatchObject({ format: "uuid", type: "string" })
		expect(props.tag).toMatchObject({ minLength: 3, type: "string" })
		expect(props.n).toMatchObject({ maximum: 10, minimum: 1, type: "number" })
	})
})
