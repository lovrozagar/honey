import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { generateOpenApi } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"

/* Inline reproducer for the transform-piped shape that createListQuerySchema builds.
 * Avoids a cross-workspace dep — honey tests stay self-contained. */
const inlineListQuerySchema = z
	.object({
		cursor: z.string().optional(),
		filter: z.string().optional(),
		limit: z.coerce.number().int().min(1).max(100).default(20),
		page: z.coerce.number().int().min(1).optional(),
		q: z.string().optional(),
		sort: z.string().optional(),
	})
	.transform((data) => ({
		cursor: data.cursor,
		filter: data.filter,
		filterAst: null as unknown as { field: string } | null,
		limit: data.limit,
		page: data.page,
		q: data.q,
		sort: data.sort,
	}))
	.pipe(
		z.object({
			cursor: z.union([z.string(), z.undefined()]),
			filter: z.union([z.string(), z.undefined()]),
			/* z.custom mirrors the unrepresentable type in comb's outputSchema */
			filterAst: z.custom<{ field: string } | null>(),
			limit: z.number(),
			page: z.union([z.number(), z.undefined()]),
			q: z.union([z.string(), z.undefined()]),
			sort: z.union([z.string(), z.undefined()]),
		}),
	)

function resolveRef(
	openApiSpec: { components?: { schemas?: Record<string, unknown> } },
	refOrSchema: Record<string, unknown>,
): Record<string, unknown> {
	const ref = refOrSchema.$ref as string | undefined
	if (!ref) return refOrSchema
	const name = ref.replace("#/components/schemas/", "")
	return (openApiSpec.components?.schemas?.[name] ?? refOrSchema) as Record<string, unknown>
}

describe("schemaToJsonSchema — io:input for transform-piped search schemas", () => {
	it("generateOpenApi emits query parameters for search schema with transform-pipe shape", async () => {
		const app = honey<{}>()
		app
			.get("/items")
			.input({ search: inlineListQuerySchema })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const spec = await generateOpenApi(app, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const params = (op?.parameters ?? []) as Array<Record<string, unknown>>

		const queryParams = params.filter((p) => p.in === "query")
		expect(queryParams.length).toBeGreaterThan(0)

		const names = queryParams.map((p) => p.name)
		for (const key of ["cursor", "filter", "limit", "page", "q", "sort"]) {
			expect(names).toContain(key)
		}
		for (const param of queryParams) {
			expect(param.in).toBe("query")
		}
	})

	it("response body schema (output) still has properties when using a plain z.object", async () => {
		const app = honey<{}>()
		app
			.get("/items")
			.input({ search: inlineListQuerySchema })
			.output({ "application/json": { ok: z.object({ id: z.string(), name: z.string() }) } })
			.handler((ctx) => ctx.res.json("ok", { id: "1", name: "n" }))

		const spec = await generateOpenApi(app, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const responses = op?.responses as Record<string, Record<string, unknown>>
		const content = responses["200"]?.content as Record<string, Record<string, unknown>>
		const rawSchema = content?.["application/json"]?.schema as Record<string, unknown>

		expect(rawSchema).toBeDefined()
		const responseSchema = resolveRef(spec, rawSchema)
		expect(responseSchema.properties).toBeDefined()
		const props = responseSchema.properties as Record<string, unknown>
		expect(props.id).toBeDefined()
		expect(props.name).toBeDefined()
	})

	it("unrepresentable z.custom in output schema triggers console.warn containing schemaToJsonSchema and error text", async () => {
		const warnSpy = vi.spyOn(console, "warn")
		warnSpy.mockImplementation(() => {})

		try {
			const app = honey<{}>()
			app
				.post("/custom-out")
				.output({
					"application/json": {
						ok: z.object({
							data: z.custom<{ raw: unknown }>(),
						}),
					},
				})
				.handler((ctx) => ctx.res.json("ok", { data: { raw: null } }))

			await generateOpenApi(app, { info: { title: "T", version: "1" } })

			const calls = warnSpy.mock.calls
			const relevant = calls.filter(
				(args) =>
					typeof args[0] === "string" &&
					args[0].includes("schemaToJsonSchema") &&
					args[0].includes("Custom types cannot be represented in JSON Schema"),
			)
			expect(relevant.length).toBeGreaterThan(0)
		} finally {
			warnSpy.mockRestore()
		}
	})
})
