import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import { honey } from "../../../src/index.ts"
import type {
	AllowedResMethods,
	ContentTypeMethodMap,
	ExtractJsonSchemas,
	ExtractSchemas,
	InferInputMap,
	InferJsonOutputMap,
	InferMeta,
	InferOutput,
	InferRouteMeta,
	InputSchemasDef,
	MergeRoute,
	OutputSchemaDef,
	RouteRecord,
	StandardSchemaLike,
	UniversalResMethods,
} from "../../../src/types.ts"

describe("InferOutput", () => {
	it("extracts string from z.string()", () => {
		expectTypeOf<InferOutput<z.ZodString>>().toEqualTypeOf<string>()
	})

	it("extracts number from z.number()", () => {
		expectTypeOf<InferOutput<z.ZodNumber>>().toEqualTypeOf<number>()
	})

	it("extracts boolean from z.boolean()", () => {
		expectTypeOf<InferOutput<z.ZodBoolean>>().toEqualTypeOf<boolean>()
	})

	it("extracts object shape from z.object()", () => {
		const schema = z.object({ id: z.string(), name: z.string() })
		expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<{
			id: string
			name: string
		}>()
	})

	it("extracts array element type", () => {
		const schema = z.string().array()
		expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<string[]>()
	})

	it("returns unknown for non-schema", () => {
		expectTypeOf<InferOutput<string>>().toEqualTypeOf<unknown>()
	})
})

describe("InferInputMap", () => {
	it("maps schema keys to inferred output types", () => {
		const schemas = {
			json: z.object({ name: z.string() }),
			search: z.object({ q: z.string() }),
		}
		type Result = InferInputMap<typeof schemas>
		expectTypeOf<Result>().toEqualTypeOf<{
			json: { name: string }
			search: { q: string }
		}>()
	})

	it("drops undefined keys", () => {
		const schemas = {
			json: z.object({ name: z.string() }),
			search: undefined,
		}
		type Result = InferInputMap<typeof schemas>
		expectTypeOf<Result>().toEqualTypeOf<{ json: { name: string } }>()
	})

	it("empty object yields empty type", () => {
		type Result = InferInputMap<{}>
		expectTypeOf<Result>().toEqualTypeOf<{}>()
	})
})

describe("InputSchemasDef", () => {
	it("accepts json + search", () => {
		const _valid: InputSchemasDef = {
			json: z.object({ name: z.string() }),
			search: z.object({ q: z.string() }),
		}
		void _valid
	})

	it("accepts form + headers", () => {
		const _valid: InputSchemasDef = {
			form: z.object({ file: z.string() }),
			headers: z.object({ authorization: z.string() }),
		}
		void _valid
	})

	it("allows empty object", () => {
		const _valid: InputSchemasDef = {}
		void _valid
	})
})

describe("OutputSchemaDef", () => {
	it("accepts JSON output with status keys", () => {
		const _valid: OutputSchemaDef = {
			"application/json": {
				ok: z.object({ id: z.string() }),
			},
		}
		void _valid
	})

	it("accepts multiple content types", () => {
		const _valid: OutputSchemaDef = {
			"application/json": { ok: z.object({ id: z.string() }) },
			"text/plain": { ok: z.string() },
		}
		void _valid
	})

	it("accepts SSE output", () => {
		const _valid: OutputSchemaDef = {
			"text/event-stream": { ok: z.object({ data: z.string() }) },
		}
		void _valid
	})
})

describe("StandardSchemaLike", () => {
	it("accepts Zod schemas", () => {
		const schema = z.string()
		expectTypeOf(schema).toMatchTypeOf<StandardSchemaLike>()
	})

	it("accepts Zod object schemas", () => {
		const schema = z.object({ id: z.string() })
		expectTypeOf(schema).toMatchTypeOf<StandardSchemaLike>()
	})
})

describe("InferOutput edge cases", () => {
	it("nested object", () => {
		const schema = z.object({
			address: z.object({ city: z.string(), zip: z.string() }),
			name: z.string(),
		})
		expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<{
			address: { city: string; zip: string }
			name: string
		}>()
	})

	it("optional field", () => {
		const schema = z.object({
			name: z.string(),
			nickname: z.string().optional(),
		})
		expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<{
			name: string
			nickname?: string | undefined
		}>()
	})

	it("union type", () => {
		const schema = z.union([z.string(), z.number()])
		expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<string | number>()
	})

	it("enum type", () => {
		const schema = z.enum(["a", "b", "c"])
		expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<"a" | "b" | "c">()
	})

	it("literal type", () => {
		const schema = z.literal("hello")
		expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<"hello">()
	})

	it("tuple type", () => {
		const schema = z.tuple([z.string(), z.number()])
		expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<[string, number]>()
	})

	it("record type", () => {
		const schema = z.record(z.string(), z.number())
		expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<Record<string, number>>()
	})

	it("nullable type", () => {
		const schema = z.string().nullable()
		expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<string | null>()
	})
})

describe("ContentTypeMethodMap", () => {
	it("maps content types to method names", () => {
		expectTypeOf<ContentTypeMethodMap>().toEqualTypeOf<{
			"application/json": "json"
			"application/octet-stream": "binary"
			"application/xml": "xml"
			"text/csv": "csv"
			"text/event-stream": "sse"
			"text/html": "html"
			"text/plain": "text"
		}>()
	})
})

describe("AllowedResMethods", () => {
	it("json output allows only json method", () => {
		type Methods = AllowedResMethods<{ "application/json": unknown }>
		expectTypeOf<Methods>().toEqualTypeOf<"json">()
	})

	it("json + text output allows both methods", () => {
		type Methods = AllowedResMethods<{
			"application/json": unknown
			"text/plain": unknown
		}>
		expectTypeOf<Methods>().toEqualTypeOf<"json" | "text">()
	})

	it("SSE output allows sse method", () => {
		type Methods = AllowedResMethods<{ "text/event-stream": unknown }>
		expectTypeOf<Methods>().toEqualTypeOf<"sse">()
	})

	it("all content types allows all methods", () => {
		type Methods = AllowedResMethods<{
			"application/json": unknown
			"application/octet-stream": unknown
			"application/xml": unknown
			"text/csv": unknown
			"text/event-stream": unknown
			"text/html": unknown
			"text/plain": unknown
		}>
		expectTypeOf<Methods>().toEqualTypeOf<"binary" | "csv" | "html" | "json" | "sse" | "text" | "xml">()
	})
})

describe("ExtractSchemas", () => {
	it("extracts JSON schemas from output def", () => {
		type Schemas = ExtractSchemas<{ "application/json": { created: z.ZodString; ok: z.ZodNumber } }, "application/json">
		expectTypeOf<Schemas>().toEqualTypeOf<{
			created: z.ZodString
			ok: z.ZodNumber
		}>()
	})

	it("returns never for missing content type", () => {
		type Schemas = ExtractSchemas<{ "text/plain": { ok: z.ZodString } }, "application/json">
		expectTypeOf<Schemas>().toBeNever()
	})
})

describe("ExtractJsonSchemas", () => {
	it("shorthand for ExtractSchemas with application/json", () => {
		type Schemas = ExtractJsonSchemas<{
			"application/json": { ok: z.ZodObject<{ id: z.ZodString }> }
		}>
		expectTypeOf<Schemas>().toEqualTypeOf<{
			ok: z.ZodObject<{ id: z.ZodString }>
		}>()
	})
})

describe("InferJsonOutputMap", () => {
	it("infers output types from JSON schema map", () => {
		type Map = InferJsonOutputMap<{
			created: z.ZodObject<{ id: z.ZodString }>
			ok: z.ZodObject<{ id: z.ZodString; name: z.ZodString }>
		}>
		expectTypeOf<Map>().toEqualTypeOf<{
			created: { id: string }
			ok: { id: string; name: string }
		}>()
	})
})

describe("UniversalResMethods", () => {
	it("contains exactly noContent, raw, redirect, stream", () => {
		expectTypeOf<UniversalResMethods>().toEqualTypeOf<"noContent" | "raw" | "redirect" | "stream">()
	})
})

describe("RouteRecord", () => {
	it("creates path → method → record shape", () => {
		type RR = RouteRecord<"GET", "/users", { json: { name: string } }, {}>
		expectTypeOf<RR>().toEqualTypeOf<{
			"/users": {
				get: {
					ctx: unknown
					errors: never
					input: { json: { name: string } }
					output: {}
				}
			}
		}>()
	})

	it("lowercases method", () => {
		type RR = RouteRecord<"POST", "/items", {}, {}, unknown, "not_found">
		type Method = keyof RR["/items"]
		expectTypeOf<Method>().toEqualTypeOf<"post">()
	})
})

describe("MergeRoute", () => {
	it("adds new route to empty routes", () => {
		type Routes = MergeRoute<{}, "/users", "GET", {}, {}, unknown>
		expectTypeOf<Routes>().toMatchTypeOf<{
			"/users": { get: { ctx: unknown; input: {}; output: {} } }
		}>()
	})

	it("merges new method onto existing path", () => {
		type R1 = MergeRoute<{}, "/users", "GET", {}, {}, unknown>
		type R2 = MergeRoute<R1, "/users", "POST", { json: { name: string } }, {}, unknown>
		type Methods = keyof R2["/users"]
		expectTypeOf<"get">().toMatchTypeOf<Methods>()
		expectTypeOf<"post">().toMatchTypeOf<Methods>()
	})

	it("same path+method produces intersection (developer error scenario)", () => {
		type R1 = MergeRoute<{}, "/test", "GET", {}, { a: true }, unknown>
		type R2 = MergeRoute<R1, "/test", "GET", {}, { b: true }, unknown>
		expectTypeOf<R2["/test"]["get"]["output"]>().toEqualTypeOf<{ a: true } & { b: true }>()
	})

	it("preserves errors in merged route", () => {
		type R = MergeRoute<{}, "/test", "GET", {}, {}, unknown, {}, "not_found" | "forbidden">
		type Errors = R["/test"]["get"]["errors"]
		expectTypeOf<Errors>().toEqualTypeOf<"forbidden" | "not_found">()
	})
})

describe("InferMeta", () => {
	it("extracts meta type from app", () => {
		const app = honey<{}>()
		type Meta = InferMeta<typeof app>
		expectTypeOf<Meta>().toBeNever()
	})
})

describe("InferRouteMeta", () => {
	it("route meta not stored in route record (returns never)", () => {
		const app = honey<{}>()
			.get("/docs")
			.meta({ summary: "List docs", tags: ["docs"] })
			.handler((ctx) => ctx.res.text("ok", "ok"))

		type Meta = InferRouteMeta<typeof app, "/docs", "get">
		expectTypeOf<Meta>().toBeNever()
	})

	it("returns never for route without .meta()", () => {
		const app = honey<{}>()
			.get("/health")
			.handler((ctx) => ctx.res.text("ok", "ok"))

		type Meta = InferRouteMeta<typeof app, "/health", "get">
		expectTypeOf<Meta>().toBeNever()
	})
})
