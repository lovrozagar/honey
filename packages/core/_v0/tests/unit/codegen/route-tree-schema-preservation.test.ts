import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateOpenApi, generateRouteTreeFromApp, prepareCodegen } from "../../../src/codegen.ts"
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

function buildFixtureApp() {
	const app = honey<{}>()
	app
		.post("/v1/projects/:project_id/suggest-schema")
		.input({
			json: z.object({ url: z.string().url() }),
			params: z.object({ project_id: z.string() }),
		})
		.output({ "application/json": { ok: z.object({ schema: z.string() }) } })
		.handler((ctx) => ctx.res.json("ok", { schema: "stub" }))
	return app
}

describe("route tree intern omits JSON Schema", () => {
	it("omits iv/os keys for routes that declare schemas", async () => {
		await prepareCodegen()
		const app = buildFixtureApp()
		const code = generateRouteTreeFromApp(app)

		expect(code).not.toMatch(/\biv:/)
		expect(code).not.toMatch(/\bos:/)
		expect(code).not.toMatch(/\biv:\s*I\d+/)
		expect(code).not.toMatch(/\bos:\s*O\d+/)
		expect(code).not.toContain('"additionalProperties"')
		expect(code).not.toContain('"application/json"')
	})

	it("generateOpenApi from the live app keeps 200 response and requestBody", async () => {
		await prepareCodegen()
		const app = buildFixtureApp()
		const spec = await generateOpenApi(app, {
			info: { title: "T", version: "1" },
		})

		const op = spec.paths["/v1/projects/{project_id}/suggest-schema"]?.post as Record<string, unknown> | undefined
		expect(op).toBeDefined()

		const responses = op?.responses as Record<string, Record<string, unknown>>
		expect(responses["200"]).toBeDefined()
		const content = responses["200"].content as Record<string, Record<string, unknown>>

		const rawResponseSchema = content["application/json"].schema as Record<string, unknown>
		const resolvedResponseSchema = resolveRef(spec, rawResponseSchema)
		expect(resolvedResponseSchema).toMatchObject({
			properties: { schema: { type: "string" } },
			type: "object",
		})

		const body = op?.requestBody as Record<string, unknown>
		expect(body).toBeDefined()
		const bodyContent = body.content as Record<string, Record<string, unknown>>
		const rawBodySchema = bodyContent["application/json"].schema as Record<string, unknown>
		const resolvedBodySchema = resolveRef(spec, rawBodySchema)
		expect(resolvedBodySchema).toMatchObject({
			properties: { url: expect.any(Object) },
			type: "object",
		})

		const parameters = op?.parameters as Array<Record<string, unknown>>
		const projectIdParam = parameters.find((p) => p.name === "project_id")
		expect(projectIdParam?.schema).toMatchObject({ type: "string" })
	})

	it("omits iv/os keys when a route declares no schemas", async () => {
		await prepareCodegen()
		const app = honey<{}>()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)
		expect(code).not.toMatch(/\biv:/)
		expect(code).not.toMatch(/\bos:/)
	})

	it("intern does not emit input source keys", async () => {
		await prepareCodegen()
		const app = honey<{}>()
		app
			.post("/multi")
			.input({
				cookies: z.object({ sid: z.string() }),
				headers: z.object({ "x-req": z.string() }),
				json: z.object({ body: z.string() }),
				params: z.object({}),
				search: z.object({ q: z.string() }),
			})
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)
		expect(code).not.toContain('"json"')
		expect(code).not.toContain('"cookies"')
		expect(code).not.toMatch(/\biv:/)
	})

	it("intern does not emit redirect output shape", async () => {
		await prepareCodegen()
		const app = honey<{}>()
		app
			.get("/r")
			.output({ redirect: { found: true, moved_permanently: true } })
			.handler((ctx) => ctx.res.redirect("found", "/somewhere"))

		const code = generateRouteTreeFromApp(app)
		expect(code).not.toContain('"redirect"')
		expect(code).not.toContain('"moved_permanently"')
		expect(code).not.toMatch(/\bos:/)
	})

	it("intern does not emit output content types", async () => {
		await prepareCodegen()
		const app = honey<{}>()
		app
			.get("/page")
			.output({
				"application/json": { ok: z.object({ ok: z.boolean() }) },
				"text/html": { ok: z.string() },
			})
			.handler((ctx) => ctx.res.html("ok", "<p>ok</p>"))

		const code = generateRouteTreeFromApp(app)
		expect(code).not.toContain('"application/json"')
		expect(code).not.toContain('"text/html"')
	})

	it("intern does not serialise transform-piped search schemas", async () => {
		await prepareCodegen()
		const app = honey<{}>()

		app
			.get("/items")
			.input({ search: inlineListQuerySchema })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)

		expect(code).not.toContain('"cursor"')
		expect(code).not.toMatch(/\biv:\s*I\d+/)
		expect(code).not.toMatch(/\biv:/)
	})

	it("generateOpenApi from the live app keeps query params", async () => {
		await prepareCodegen()
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
		for (const key of ["cursor", "filter", "limit", "sort"]) {
			expect(names).toContain(key)
		}
	})
})
