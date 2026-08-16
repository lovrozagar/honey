import { execSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as z from "zod"
import { generateOpenApi, generateTypes } from "../../../src/codegen.ts"
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

/* Inline comb 0.2.0 list-query shape: z.lazy recursive objects in pipe output. */
type FieldSelection = {
	relations: Record<string, FieldSelection | null>
	scalars: string[]
}

const fieldSelectionSchema: z.ZodType<FieldSelection, FieldSelection> = z.lazy(() =>
	z.object({
		relations: z.record(z.string(), fieldSelectionSchema.nullable()),
		scalars: z.array(z.string()),
	}),
)

const parsedFieldsSchema = z.object({ root: fieldSelectionSchema })

type FilterGroup = {
	conditions: Array<{ field: string; operator: string; value: unknown }>
	logic: "and" | "or"
	subgroups: FilterGroup[]
}

const filterGroupSchema: z.ZodType<FilterGroup, FilterGroup> = z.lazy(() =>
	z.object({
		conditions: z.array(
			z.object({
				field: z.string(),
				operator: z.string(),
				value: z.unknown(),
			}),
		),
		logic: z.enum(["and", "or"]),
		subgroups: z.array(filterGroupSchema),
	}),
)

const filterAstSchema = z.object({ root: filterGroupSchema })

const lazyListQuerySchema = z
	.object({
		filter: z.string().optional(),
		limit: z.coerce.number().int().min(1).max(100).default(20),
		select: z.string().optional(),
	})
	.transform((data) => ({
		filterAst: null as z.infer<typeof filterAstSchema> | null,
		limit: data.limit,
		parsedFields: null as z.infer<typeof parsedFieldsSchema> | null,
		parsedSort: [{ direction: "desc" as const, field: "created_at" }],
	}))
	.pipe(
		z.object({
			filterAst: filterAstSchema.nullable(),
			limit: z.number(),
			parsedFields: parsedFieldsSchema.nullable(),
			parsedSort: z.array(
				z.object({
					direction: z.enum(["asc", "desc"]),
					field: z.literal("created_at"),
				}),
			),
		}),
	)

function assertAssignability(source: string): void {
	const dir = mkdtempSync(join(tmpdir(), "honey-lazy-types-"))
	try {
		writeFileSync(join(dir, "check.ts"), source)
		writeFileSync(
			join(dir, "tsconfig.json"),
			JSON.stringify({
				compilerOptions: {
					exactOptionalPropertyTypes: true,
					module: "esnext",
					moduleResolution: "bundler",
					noEmit: true,
					skipLibCheck: true,
					strict: true,
					target: "esnext",
				},
				files: ["check.ts"],
			}),
		)
		try {
			execSync(`bunx tsc --noEmit -p ${dir}`, { encoding: "utf8", stdio: "pipe" })
		} catch (raw) {
			const e = raw as { stderr?: string; stdout?: string }
			expect.fail(`tsc errors:\n${(e.stdout ?? "") + (e.stderr ?? "")}`)
		}
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

describe("schemaToJsonSchema — z.lazy list-query pipe output", () => {
	it("OpenAPI query params stay io:input (select/filter/limit), not parsedFields", async () => {
		const app = honey<{}>()
		app
			.get("/items")
			.input({ search: lazyListQuerySchema })
			.handler((c) => {
				const _fields = c.input.search.parsedFields
				return c.res.text("ok", "ok")
			})

		const spec = await generateOpenApi(app, { info: { title: "T", version: "1" } })
		const op = spec.paths["/items"]?.get as Record<string, unknown>
		const params = (op?.parameters ?? []) as Array<Record<string, unknown>>
		const queryParams = params.filter((p) => p.in === "query")
		const names = queryParams.map((p) => p.name)

		for (const key of ["filter", "limit", "select"]) {
			expect(names).toContain(key)
		}
		for (const leaked of ["parsedFields", "filterAst", "parsedSort"]) {
			expect(names).not.toContain(leaked)
		}
	})

	it("generateTypes emits recursive parsedFields/filterAst, not { root: unknown }", () => {
		const app = honey<{}>()
		app
			.get("/items")
			.input({ search: lazyListQuerySchema })
			.handler((c) => {
				const _fields = c.input.search.parsedFields
				return c.res.text("ok", "ok")
			})

		const types = generateTypes(app, {})
		expect(types).not.toContain("root: unknown")
		expect(types).toMatch(/type _Lazy\d+ = \{ relations: Record<string, _Lazy\d+ \| null>; scalars: string\[] \}/)
		expect(types).toMatch(
			/type _Lazy\d+ = \{ conditions: \{ field: string; operator: string; value: unknown }\[]; logic: "and" \| "or"; subgroups: _Lazy\d+\[] \}/,
		)
		expect(types).toMatch(/parsedFields: \{ root: _Lazy\d+ } \| null/)
		expect(types).toMatch(/filterAst: \{ root: _Lazy\d+ } \| null/)

		const aliases = [...types.matchAll(/^type (_Lazy\d+) = (.+)$/gm)]
		expect(aliases.length).toBeGreaterThanOrEqual(2)
		const parsedFields = types.match(/parsedFields: ([^;]+)/)?.[1]
		const filterAst = types.match(/filterAst: ([^;]+)/)?.[1]
		expect(parsedFields).toBeDefined()
		expect(filterAst).toBeDefined()

		assertAssignability(`${aliases.map((m) => m[0]).join("\n")}

type GeneratedFields = ${parsedFields}
type GeneratedFilter = ${filterAst}

type ParsedFields = {
	root: { scalars: string[]; relations: Record<string, ParsedFields["root"] | null> }
}

type FilterAST = {
	root: {
		conditions: Array<{ field: string; operator: string; value: unknown }>
		logic: "and" | "or"
		subgroups: FilterAST["root"][]
	}
}

type FieldsExt = ParsedFields extends GeneratedFields ? true : false
const _fieldsExt: FieldsExt = true
type FieldsAssign = GeneratedFields extends ParsedFields | null ? true : false
const _fieldsAssign: FieldsAssign = true

type FilterExt = FilterAST extends GeneratedFilter ? true : false
const _filterExt: FilterExt = true
type FilterAssign = GeneratedFilter extends FilterAST | null ? true : false
const _filterAssign: FilterAssign = true

const _fieldsSatisfies = null as GeneratedFields satisfies ParsedFields | null
const _filterSatisfies = null as GeneratedFilter satisfies FilterAST | null
`)
	})
})
