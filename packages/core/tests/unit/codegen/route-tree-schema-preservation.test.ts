import { describe, expect, it } from "vitest"
import * as z from "zod"
import { generateOpenApi, generateRouteTreeFromApp, prepareCodegen } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import type { RouteTree } from "../../../src/tree.ts"

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

/* esbuild strips types and rewrites the honey/tree import to an absolute path
 * so the emitted module can be evaluated at test time without tsc. */
async function evalTreeModule(code: string): Promise<{ routeTree: RouteTree }> {
	const { transform } = await import("esbuild")
	const rewritten = code.replace(
		/from\s+"honey\/tree"/g,
		`from ${JSON.stringify(new URL("../../../src/tree.ts", import.meta.url).pathname)}`,
	)
	const { code: js } = await transform(rewritten, {
		format: "esm",
		loader: "ts",
		target: "esnext",
	})
	const dataUrl = `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
	return (await import(dataUrl)) as { routeTree: RouteTree }
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

describe("route tree schema preservation", () => {
	it("emits non-null iv/os in handler constants for routes that declare schemas", async () => {
		await prepareCodegen()
		const app = buildFixtureApp()
		const code = generateRouteTreeFromApp(app)

		expect(code).not.toMatch(/iv:\s*null,\s*os:\s*null/)
		expect(code).toMatch(/iv:\s*\{/)
		expect(code).toMatch(/os:\s*\{/)
		expect(code).toContain('"application/json"')
		expect(code).toContain('"ok"')
		expect(code).toContain('"project_id"')
		expect(code).toContain('"url"')
	})

	it("round-trips through generateOpenApi with 200 response and requestBody (gateway flow)", async () => {
		await prepareCodegen()
		const app = buildFixtureApp()
		const code = generateRouteTreeFromApp(app)
		const { routeTree } = await evalTreeModule(code)

		const gateway = honey<{}>().routeTree(routeTree)
		const spec = await generateOpenApi(gateway, {
			info: { title: "T", version: "1" },
		})

		const op = spec.paths["/v1/projects/{project_id}/suggest-schema"]?.post as
			| Record<string, unknown>
			| undefined
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

	it("routes with no declared schemas still emit iv: null / os: null", async () => {
		await prepareCodegen()
		const app = honey<{}>()
		app.get("/health").handler((ctx) => ctx.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)
		expect(code).toMatch(/H0:[^\n]*iv:\s*null[^\n]*os:\s*null/)
	})

	it("preserves all input sources: json, search, params, headers, cookies", async () => {
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
		expect(code).toContain('"json"')
		expect(code).toContain('"search"')
		expect(code).toContain('"params"')
		expect(code).toContain('"headers"')
		expect(code).toContain('"cookies"')
	})

	it("preserves redirect output shape (status keys, no schema)", async () => {
		await prepareCodegen()
		const app = honey<{}>()
		app
			.get("/r")
			.output({ redirect: { found: true, moved_permanently: true } })
			.handler((ctx) => ctx.res.redirect("found", "/somewhere"))

		const code = generateRouteTreeFromApp(app)
		expect(code).toContain('"redirect"')
		expect(code).toContain('"found":true')
		expect(code).toContain('"moved_permanently":true')
	})

	it("preserves multiple output content types (application/json + text/html)", async () => {
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
		expect(code).toContain('"application/json"')
		expect(code).toContain('"text/html"')
	})

	it("serialises transform-piped search schema into iv block with query property names", async () => {
		await prepareCodegen()
		const app = honey<{}>()

		app
			.get("/items")
			.input({ search: inlineListQuerySchema })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)

		expect(code).toContain('"cursor"')
		expect(code).toContain('"filter"')
		expect(code).toContain('"limit"')
		expect(code).toContain('"sort"')
		expect(code).toMatch(/iv:\s*\{/)
	})

	it("round-trip via evalTreeModule preserves query params in generateOpenApi output (gateway flow)", async () => {
		await prepareCodegen()
		const app = honey<{}>()

		app
			.get("/items")
			.input({ search: inlineListQuerySchema })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		const code = generateRouteTreeFromApp(app)
		const { routeTree } = await evalTreeModule(code)

		const gateway = honey<{}>().routeTree(routeTree)
		const spec = await generateOpenApi(gateway, { info: { title: "T", version: "1" } })

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
