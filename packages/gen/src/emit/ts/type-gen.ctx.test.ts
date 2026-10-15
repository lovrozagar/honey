/**
 * `generateTypes` ctx: `BaseCtx` from the extracted env, middleware and taps; each route's own
 * middleware additions; its parsed `ctx.input` (O3); the ctx shape mirroring v1 `HandlerCtx` (O9).
 */
import * as tsMorph from "ts-morph"
import { describe, expect, it } from "vitest"
import type { ExtractedTypes } from "../../extract/extract.ts"
import { extracted, type HoneyApp, honeyDoc, object } from "./__fixtures__/honey-doc.ts"
import { typechecker } from "./__fixtures__/typecheck.ts"
import { generateTypes } from "./type-gen.ts"

const typecheck = typechecker(tsMorph)

const STRING = { type: "string" }

/** generateTypes over `app`, what it reported and its text, and each diagnostic of `consumer` beside it. */
function check(app: HoneyApp, consumer: string, types: ExtractedTypes | null, files: Record<string, string> = {}) {
	const reports: string[] = []
	const text = generateTypes({ ...app, extracted: types, report: (m) => reports.push(m) })
	return { diagnostics: typecheck(text, consumer, files), reports, text }
}

/** An app of `GET` routes at `patterns`, nothing declared. */
const gets = (...patterns: string[]): HoneyApp => honeyDoc(patterns.map((pattern) => ({ method: "GET", pattern })))

describe("BaseCtx", () => {
	// v0: 8c8a800da4
	it("is HoneyContext<Record<string, unknown>> with nothing extracted, imported without HoneyError", () => {
		const consumer = `expectType<Equal<BaseCtx, HoneyContext<Record<string, unknown>>>>()`
		const { diagnostics, text } = check(gets("/health"), consumer, null)
		expect({
			diagnostics,
			imports: text.includes('import type { HoneyContext, WithOutput } from "@lovrozagar/honey"'),
		}).toEqual({
			diagnostics: [],
			imports: true,
		})
	})

	// v0: 5b5963dc6a
	it("takes the extracted env as HoneyContext's generic and the middleware additions beside it", () => {
		const types = extracted({
			env: "{ DB: string; KV: Map<string, string> }",
			middleware: { user: "{ id: string; role: string }" },
		})
		const consumer = `expectType<Same<BaseCtx["env"], { DB: string; KV: Map<string, string> }>>()
expectType<Same<BaseCtx["user"], { id: string; role: string }>>()
expectType<BaseCtx extends HoneyContext<{ DB: string; KV: Map<string, string> }> ? true : false>()
expectType<Same<RouteCtx<"/health", "get">["user"], { id: string; role: string }>>()`
		expect(check(gets("/health"), consumer, types).diagnostics).toEqual([])
	})

	// v0: b762ffb505
	it("is HoneyContext<env> alone when middleware added nothing", () => {
		const consumer = `expectType<Equal<BaseCtx, HoneyContext<{ DB: string }>>>()`
		expect(check(gets("/health"), consumer, extracted({ env: "{ DB: string }" })).diagnostics).toEqual([])
	})

	// v0: 5c381daca0
	it("carries what app.context() added into every route's ctx", () => {
		const types = extracted({ env: "{ SECRET: string }", middleware: { db: "string" } })
		const consumer = `expectType<Equal<RouteCtx<"/test", "get">["db"], string>>()
expectType<Same<RouteCtx<"/test", "get">["env"], { SECRET: string }>>()`
		expect(check(gets("/test"), consumer, types).diagnostics).toEqual([])
	})
})

describe("taps", () => {
	// v0: 9357ffb552
	it("types ctx.tap by the extracted TapMap: its keys and payload literals", () => {
		const types = extracted({ taps: '{ audit: { action: "create" | "delete"; resource: string } }' })
		const consumer = `declare const base: BaseCtx
declare const ctx: RouteCtx<"/test", "get">
base.tap("audit", { action: "create", resource: "r" })
ctx.tap("audit", { action: "delete", resource: "r" })
// @ts-expect-error: a payload outside the declared literals
ctx.tap("audit", { action: "update", resource: "r" })
// @ts-expect-error: a key no tap declares
ctx.tap("other", {})`
		expect(check(gets("/test"), consumer, types).diagnostics).toEqual([])
	})

	// v0: 99e217739e
	it("keeps HoneyContext's any-key tap and emits no TapMap when no taps are declared", () => {
		const consumer = `declare const ctx: RouteCtx<"/test", "get">
ctx.tap("anything", { any: 1 })`
		const { diagnostics, text } = check(gets("/test"), consumer, extracted({ taps: null }))
		expect({ diagnostics, tapMap: /TapMap|tap</.test(text) }).toEqual({ diagnostics: [], tapMap: false })
	})
})

describe("per-route additions", () => {
	// v0: 697b381e1a
	it("extends only that route's ctx", () => {
		const types = extracted({ routes: { "GET /private": { auth: "{ sub: string }" } } })
		const consumer = `expectType<Same<RouteCtx<"/private", "get">["auth"], { sub: string }>>()
expectType<Equal<"auth" extends keyof RouteCtx<"/public", "get"> ? true : false, false>>()`
		expect(check(gets("/public", "/private"), consumer, types).diagnostics).toEqual([])
	})

	// v0: 1a7a0badb1
	it("combines with the route's input and declared errors", () => {
		const app = honeyDoc([
			{
				errors: { forbidden: { status: 403 } },
				input: { json: object({ action: STRING }) },
				method: "POST",
				pattern: "/admin/action",
			},
		])
		const types = extracted({ routes: { "POST /admin/action": { auth: "{ role: string; sub: string }" } } })
		const consumer = `type C = RouteCtx<"/admin/action", "post">
expectType<Same<C["auth"], { role: string; sub: string }>>()
expectType<Same<C["input"], { json: { action: string } }>>()
expectType<Equal<RouteErrors<"/admin/action", "post">, "forbidden">>()
expectType<Equal<ReturnType<C["errors"]["forbidden"]>, HoneyError>>()`
		expect(check(app, consumer, types).diagnostics).toEqual([])
	})

	// v0: 0a41708edf
	it("leaves a route without an entry on plain BaseCtx, and reports an entry no operation documents", () => {
		const types = extracted({ routes: { "GET /other": { auth: "string" } } })
		const consumer = `expectType<Equal<"auth" extends keyof RouteCtx<"/health", "get"> ? true : false, false>>()
expectType<Equal<RouteCtx<"/health", "get">["env"], BaseCtx["env"]>>()`
		const { diagnostics, reports } = check(gets("/health"), consumer, types)
		expect({ diagnostics, reports }).toEqual({
			diagnostics: [],
			reports: [
				"GET /other: extracted ctx additions match no documented operation (internal and filtered routes are not documented); not typed",
			],
		})
	})

	// v0: a5b73c73eb
	it("gives two routes with different additions each their own ctx extension", () => {
		const types = extracted({
			routes: {
				"GET /admin-area": { admin: "{ level: number }", auth: "{ sub: string }" },
				"GET /user-area": { auth: "{ sub: string }" },
			},
		})
		const consumer = `expectType<Same<RouteCtx<"/user-area", "get">["auth"], { sub: string }>>()
expectType<Equal<"admin" extends keyof RouteCtx<"/user-area", "get"> ? true : false, false>>()
expectType<Same<RouteCtx<"/admin-area", "get">["auth"], { sub: string }>>()
expectType<Same<RouteCtx<"/admin-area", "get">["admin"], { level: number }>>()
expectType<Equal<"auth" extends keyof RouteCtx<"/public", "get"> ? true : false, false>>()`
		expect(check(gets("/public", "/user-area", "/admin-area"), consumer, types).diagnostics).toEqual([])
	})
})

/* the app's own module, as the Serializer references it by import(): a pipe's recursive output types */
const APP_TS = `export type FieldsNode = { relations: Record<string, FieldsNode | null>; scalars: string[] }
export type FilterNode = { conditions: { field: string; operator: string; value: unknown }[]; logic: "and" | "or"; subgroups: FilterNode[] }`

describe("the ctx shape", () => {
	// v0: 08970024e7
	it("types ctx.input by the extracted parsed type: a pipe's recursive output, never { root: unknown }", () => {
		const search = object({ filter: STRING, limit: { type: "integer" }, select: STRING }, [])
		const input = `{ search: { filterAst: { root: import("./app").FilterNode } | null; limit: number; parsedFields: { root: import("./app").FieldsNode } | null } }`
		const types = extracted({ inputs: { "GET /items": input } })
		const consumer = `type S = RouteCtx<"/items", "get">["input"]["search"]
type ParsedFields = { root: { relations: Record<string, ParsedFields["root"] | null>; scalars: string[] } }
expectType<Same<S["parsedFields"], ParsedFields | null>>()
expectType<Equal<NonNullable<S["filterAst"]>["root"]["subgroups"][number]["logic"], "and" | "or">>()
expectType<Equal<"filter" extends keyof S ? true : false, false>>()`
		const app = honeyDoc([{ input: { search }, method: "GET", pattern: "/items" }])
		expect(check(app, consumer, types, { "app.ts": APP_TS }).diagnostics).toEqual([])
	})

	it("mirrors v1 HandlerCtx: readonly input, the route's meta and its pattern", () => {
		const app = honeyDoc([
			{ input: { search: object({ q: STRING }) }, meta: { auth: true }, method: "GET", pattern: "/users/:id" },
		])
		const consumer = `declare const ctx: RouteCtx<"/users/:id", "get">
expectType<Equal<typeof ctx.routePattern, "/users/:id">>()
expectType<Equal<typeof ctx.meta.auth, true>>()
expectType<Same<typeof ctx.input, { search: { q: string } }>>()
// @ts-expect-error: input is readonly
ctx.input = { search: { q: "" } }`
		expect(check(app, consumer, null).diagnostics).toEqual([])
	})

	it("falls back to the document's wire input when the route has no extracted input", () => {
		const app = honeyDoc([{ input: { search: object({ q: STRING }) }, method: "GET", pattern: "/find" }])
		const consumer = `expectType<Same<RouteCtx<"/find", "get">["input"], { search: { q: string } }>>()`
		expect(check(app, consumer, extracted({ inputs: { "GET /other": "{ json: number }" } })).diagnostics).toEqual([])
	})
})
