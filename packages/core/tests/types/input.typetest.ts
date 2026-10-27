/**
 * `.input()` as typed: ctx.input carries each declared source as its schema produced it, beside
 * what middleware and context() add; a readableStream() body is left off it and a readableStream()
 * non-body source is the raw record; json and form are exclusive; a ws route takes the non-body
 * sources only; and the route map and InferRouteCtx carry the input. Checked by typecheck.
 */
import { describe, expectTypeOf, it } from "vitest"
import * as z from "zod"
import type { FieldError } from "../../src/errors/error.ts"
import {
	type InferInputMap,
	type InputEntry,
	type InputSchemas,
	type ReadableStreamSchema,
	readableStream,
} from "../../src/input/input.ts"
import { createMiddleware } from "../../src/middleware/middleware.ts"
import { honey } from "../../src/routing/app.ts"
import type { InferRouteCtx, InferRouteInput, InferRoutes } from "../../src/routing/app-types.ts"
import type { InferOutput, StandardSchemaLike } from "../../src/validation/standard-schema.ts"
import type { NormalizedIssue } from "../../src/validation/validate-input.ts"
import { ws } from "../../src/ws/route.ts"

const withDb = createMiddleware((_ctx, next) => next({ db: { query: (sql: string) => [sql] } }))
const withAuth = createMiddleware((_ctx, next) => next({ userId: "u-1" }))

describe("ctx.input: each declared source, as its schema produced it", () => {
	// v0: a18775314c
	// v0: efbdd5d766
	// v0: f58a7e2d11
	// v0: 30bb7ae4c0
	// v0: 487bb2d797
	// v0: f0760bf795
	// v0: 06f369abe3
	// v0: 450936df41
	it("types every source the route declares, and only those", () => {
		honey<{}>()
			.post("/t/:id")
			.input({
				cookies: z.object({ session: z.string() }),
				headers: z.object({ authorization: z.string() }),
				json: z.object({ age: z.number(), name: z.string() }),
				params: z.object({ id: z.coerce.number() }),
				search: z.object({ page: z.coerce.number().default(1) }),
			})
			.handler((ctx) => {
				expectTypeOf(ctx.input.json).toEqualTypeOf<{ age: number; name: string }>()
				expectTypeOf(ctx.input.params.id).toEqualTypeOf<number>()
				expectTypeOf(ctx.input.search.page).toEqualTypeOf<number>()
				expectTypeOf(ctx.input.headers.authorization).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.cookies.session).toEqualTypeOf<string>()
				expectTypeOf(ctx.input).not.toHaveProperty("form")
				return ctx.res.text("ok", "ok")
			})
		honey<{}>()
			.get("/s")
			.input({ search: z.object({ q: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.input).toEqualTypeOf<{ readonly search: { q: string } }>()
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("ctx.input beside the rest of the ctx", () => {
	// v0: 1cc17afe94
	// v0: 06e85b323e
	// v0: 9a127e8035
	it("sits beside what middleware and context() add, at chain and route level, whatever one-shots follow", () => {
		honey<{}>()
			.context({ region: "eu" })
			.use(withDb)
			.get("/t")
			.use(withAuth)
			.input({ search: z.object({ q: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.db.query).toEqualTypeOf<(sql: string) => string[]>()
				expectTypeOf(ctx.userId).toEqualTypeOf<string>()
				expectTypeOf(ctx.region).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.search.q).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
		honey<{}>()
			.post("/users/:id")
			.input({ json: z.object({ name: z.string() }) })
			.meta({ summary: "x" })
			.handler((ctx) => {
				expectTypeOf(ctx.params.id).toEqualTypeOf<string>()
				expectTypeOf(ctx.input.json.name).toEqualTypeOf<string>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("is declared once: .input() is gone from the builder after it ran", () => {
		const route = honey<{}>()
			.get("/t")
			.input({ search: z.object({ q: z.string() }) })
		expectTypeOf(route).not.toHaveProperty("input")
	})
})

describe("ctx.input: a form body", () => {
	// v0: fab8b17479
	it("is its schema's output, with no json beside it", () => {
		honey<{}>()
			.post("/upload")
			.input({ form: z.object({ file: z.string(), name: z.string() }) })
			.handler((ctx) => {
				expectTypeOf(ctx.input.form).toEqualTypeOf<{ file: string; name: string }>()
				expectTypeOf(ctx.input).not.toHaveProperty("json")
				return ctx.res.text("ok", "ok")
			})
	})
})

describe("ctx.input: readableStream() entries and the body", () => {
	// v0: 0262e59589
	// v0: ab11da732c
	it("readableStream() keeps the schema's own type on its wrapper, read-only", () => {
		const schema = z.object({ a: z.string() })
		expectTypeOf(readableStream(schema)).toEqualTypeOf<ReadableStreamSchema<typeof schema>>()
		expectTypeOf<ReadableStreamSchema<typeof schema>>().toEqualTypeOf<{
			readonly _tag: "readableStream"
			readonly schema: typeof schema
		}>()
		expectTypeOf<ReadableStreamSchema<typeof schema>>().not.toEqualTypeOf<{
			_tag: "readableStream"
			schema: typeof schema
		}>()
		expectTypeOf<ReadableStreamSchema<typeof schema>["_tag"]>().toEqualTypeOf<"readableStream">()
	})

	it("leaves a readableStream() body off ctx.input, and types a non-body one as the raw record", () => {
		honey<{}>()
			.post("/t")
			.input({ json: readableStream(z.object({ a: z.string() })), search: readableStream(z.object({ q: z.number() })) })
			.handler((ctx) => {
				expectTypeOf(ctx.input).not.toHaveProperty("json")
				expectTypeOf(ctx.input.search).toEqualTypeOf<Record<string, string | string[]>>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("takes json or form, never both", () => {
		const route = honey<{}>().post("/t")
		const both = { form: z.object({}), json: z.object({}) }
		expectTypeOf(route.input).toBeCallableWith({ json: z.object({}) })
		// @ts-expect-error a request carries one body
		route.input(both)
	})

	// v0: c53ccb1580
	// v0: bb6cbfa160
	it("takes a zod schema, an object or a scalar, as a Standard Schema", () => {
		expectTypeOf(z.object({ id: z.string() })).toExtend<StandardSchemaLike>()
		expectTypeOf(z.string()).toExtend<StandardSchemaLike>()
	})
})

describe("ctx.input.binary: the bytes and the declared media type", () => {
	it("types the bytes, and the type as the declared literals, a range as its family", () => {
		honey<{}>()
			.post("/a")
			.input({ binary: ["image/png", "image/jpeg"] })
			.handler((ctx) => {
				expectTypeOf(ctx.input.binary).toEqualTypeOf<{
					readonly bytes: Uint8Array<ArrayBuffer>
					readonly type: "image/jpeg" | "image/png"
				}>()
				return ctx.res.text("ok", "ok")
			})
		honey<{}>()
			.post("/b")
			.input({ binary: "image/*" })
			.handler((ctx) => {
				expectTypeOf(ctx.input.binary.type).toEqualTypeOf<`image/${string}`>()
				return ctx.res.text("ok", "ok")
			})
	})

	it("takes binary alone as the body: not beside json or form", () => {
		const route = honey<{}>().post("/t")
		const beside = { binary: "image/png", json: z.object({}) } as const
		expectTypeOf(route.input).toBeCallableWith({ binary: "image/png" })
		// @ts-expect-error a request carries one body
		route.input(beside)
	})
})

describe("InputSchemas: what .input() takes", () => {
	// v0: e94ad8f161
	// v0: 555fe2e577
	// v0: d2b0b4068a
	// v0: 7175a6b05d
	// v0: 583b5c74f5
	// v0: 0cff8adf72
	// v0: 2996e4cbbe
	// v0: f2b1aae5de
	// v0: 1ad1059cc5
	// v0: 11b375a687
	it("InputSchemas: one body at most, beside any non-body source; nothing at all is a declaration too", () => {
		const entry = {} as InputEntry
		const nonBody = { cookies: entry, headers: entry, params: entry, search: entry }
		expectTypeOf({}).toExtend<InputSchemas>()
		expectTypeOf(nonBody).toExtend<InputSchemas>()
		expectTypeOf({ json: entry }).toExtend<InputSchemas>()
		expectTypeOf({ form: entry }).toExtend<InputSchemas>()
		expectTypeOf({ ...nonBody, json: entry }).toExtend<InputSchemas>()
		expectTypeOf({ ...nonBody, form: entry }).toExtend<InputSchemas>()
		expectTypeOf({
			form: z.object({ file: z.string() }),
			headers: z.object({ authorization: z.string() }),
		}).toExtend<InputSchemas>()
		expectTypeOf({ json: z.object({ name: z.string() }), search: z.object({ q: z.string() }) }).toExtend<InputSchemas>()
		expectTypeOf({ form: entry, json: entry }).not.toExtend<InputSchemas>()
	})
})

describe("the schema types: what a source infers to", () => {
	// v0: 6619ee856f
	// v0: e448f057bf
	// v0: 735fc1fbbe
	// v0: 8cdfa9dce0
	// v0: adcedfe554
	// v0: e0da22630a
	// v0: cec09f24b5
	// v0: 8f4536625a
	it("InferOutput is a scalar's, an array's or an object's output; unknown for what is not a schema", () => {
		const array = z.string().array()
		const nested = z.object({ address: z.object({ city: z.string(), zip: z.string() }), name: z.string() })
		const optional = z.object({ name: z.string(), nickname: z.string().optional() })
		expectTypeOf<InferOutput<z.ZodString>>().toEqualTypeOf<string>()
		expectTypeOf<InferOutput<z.ZodNumber>>().toEqualTypeOf<number>()
		expectTypeOf<InferOutput<z.ZodBoolean>>().toEqualTypeOf<boolean>()
		expectTypeOf<InferOutput<typeof array>>().toEqualTypeOf<string[]>()
		expectTypeOf<InferOutput<typeof nested>>().toEqualTypeOf<{ address: { city: string; zip: string }; name: string }>()
		expectTypeOf<InferOutput<typeof optional>>().toEqualTypeOf<{ name: string; nickname?: string | undefined }>()
		expectTypeOf<InferOutput<string>>().toEqualTypeOf<unknown>()
	})

	// v0: 897ec0db70
	// v0: e9c3623de0
	// v0: 8cad8aed91
	// v0: 94b6b4dddf
	// v0: 9679f901ed
	// v0: 9f8c6aab51
	it("InferOutput keeps an enum, a literal, a nullable, a union, a record and a tuple exact", () => {
		const choice = z.enum(["a", "b", "c"])
		const hello = z.literal("hello")
		const nullable = z.string().nullable()
		const union = z.union([z.string(), z.number()])
		const record = z.record(z.string(), z.number())
		const tuple = z.tuple([z.string(), z.number()])
		expectTypeOf<InferOutput<typeof choice>>().toEqualTypeOf<"a" | "b" | "c">()
		expectTypeOf<InferOutput<typeof hello>>().toEqualTypeOf<"hello">()
		expectTypeOf<InferOutput<typeof nullable>>().toEqualTypeOf<string | null>()
		expectTypeOf<InferOutput<typeof union>>().toEqualTypeOf<string | number>()
		expectTypeOf<InferOutput<typeof record>>().toEqualTypeOf<Record<string, number>>()
		expectTypeOf<InferOutput<typeof tuple>>().toEqualTypeOf<[string, number]>()
	})

	// v0: 2298554af0
	// v0: d5fbb8ed26
	// v0: 377b56f48d
	it("InferInputMap maps each declared source to its output, leaving out one declared undefined", () => {
		const schemas = { json: z.object({ name: z.string() }), search: z.object({ q: z.string() }) }
		expectTypeOf<InferInputMap<typeof schemas>>().toEqualTypeOf<{
			readonly json: { name: string }
			readonly search: { q: string }
		}>()
		expectTypeOf<InferInputMap<{ json: typeof schemas.json; search: undefined }>>().toEqualTypeOf<{
			readonly json: { name: string }
		}>()
		expectTypeOf<InferInputMap<{}>>().toEqualTypeOf<{}>()
	})
})

describe("the validation types", () => {
	// v0: 294de3c4fe
	// v0: cc05c6d53e
	it("a field error and a normalized issue carry what a client and a formatter read", () => {
		expectTypeOf<FieldError>().toEqualTypeOf<{ error_key: string; message: string; path: string }>()
		expectTypeOf<NormalizedIssue>().toEqualTypeOf<{
			readonly code: string
			readonly message: string
			readonly meta: { readonly field?: string }
			readonly path: readonly PropertyKey[]
		}>()
	})
})

describe("ws .input(): the non-body sources only", () => {
	it("types ctx.input on the socket's callbacks; a body source is refused", () => {
		const app = honey<{}>()
		ws(app, "/live/:room")
			.input({ params: z.object({ room: z.string() }), search: z.object({ token: z.string() }) })
			.handler({
				onOpen: (ctx) => {
					expectTypeOf(ctx.input.search.token).toEqualTypeOf<string>()
					expectTypeOf(ctx.input.params.room).toEqualTypeOf<string>()
				},
			})
		// @ts-expect-error an upgrade has no body
		ws(app, "/b").input({ json: z.object({}) })
	})
})

describe("the route map and InferRouteCtx carry the input", () => {
	// v0: 3d10541706
	// v0: f51c6362b8
	// v0: 33e035d172
	// v0: 2caae9959c
	// v0: 15a2a6865f
	// v0: 8e529bc027
	// v0: 5446e8b926
	// v0: 2135b4ce73
	it("$routes keeps each route; InferRouteCtx and InferRouteInput carry its validated input beside middleware", () => {
		const app = honey<{}>()
			.use(withDb)
			.use(withAuth)
			.get("/users/:id")
			.handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
			.post("/users")
			.input({ json: z.object({ name: z.string() }), search: z.object({ limit: z.coerce.number() }) })
			.handler((ctx) => ctx.res.json("created", { name: ctx.input.json.name }))
		expectTypeOf<InferRoutes<typeof app>>().toHaveProperty("/users/:id")
		expectTypeOf<InferRoutes<typeof app>>().toHaveProperty("/users")
		expectTypeOf<InferRouteCtx<typeof app, "/users", "post">>().toMatchTypeOf<{
			db: { query: (sql: string) => string[] }
			input: { json: { name: string }; search: { limit: number } }
			userId: string
		}>()
		expectTypeOf<InferRouteInput<typeof app, "/users", "post">>().toEqualTypeOf<{
			readonly json: { name: string }
			readonly search: { limit: number }
		}>()
	})
})
