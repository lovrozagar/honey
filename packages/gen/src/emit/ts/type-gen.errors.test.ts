/**
 * `generateTypes` declared errors: each route's `errors` union, `errorShapes`, `errorsByStatus` and
 * the ctx's error factories, from the document's `x-honey-errors` and `x-honey-error` (O2).
 */
import * as tsMorph from "ts-morph"
import { describe, expect, it } from "vitest"
import { type HoneyApp, type HoneyRoute, honeyDoc, object } from "./__fixtures__/honey-doc.ts"
import { typechecker } from "./__fixtures__/typecheck.ts"
import { generateTypes } from "./type-gen.ts"

const typecheck = typechecker(tsMorph)

const STRING = { type: "string" }

/** generateTypes over `app` (nothing extracted) and each diagnostic of `consumer` beside its output. */
function check(app: HoneyApp, consumer: string): string[] {
	return typecheck(generateTypes({ ...app, extracted: null, report: () => undefined }), consumer)
}

/** One route `GET pattern` declaring `errors`. */
const withErrors = (pattern: string, errors: HoneyRoute["errors"], rest: Partial<HoneyRoute> = {}): HoneyApp =>
	honeyDoc([{ errors, method: "GET", pattern, ...rest }])

/* a standard key at 409 and a schema key at 404 */
const ITEMS = withErrors("/items/:id", {
	email_taken: { status: 409 },
	item_not_found: { schema: object({ reason: STRING, suggestions: { items: STRING, type: "array" } }), status: 404 },
})

describe("the errors union", () => {
	// v0: 4e10b6018f
	it("types a route's declared errors as the union of their keys", () => {
		const app = withErrors("/users", { email_taken: { status: 409 }, not_authorized: { status: 401 } })
		expect(check(app, `expectType<Equal<RouteErrors<"/users", "get">, "email_taken" | "not_authorized">>()`)).toEqual(
			[],
		)
	})

	// v0: b5725495ac
	it("types a route without declared errors as errors never", () => {
		const app = honeyDoc([{ method: "GET", pattern: "/health" }])
		expect(check(app, `expectType<Equal<RouteErrors<"/health", "get">, never>>()`)).toEqual([])
	})

	// v0: 45e403d70e
	it("gives a route without declared errors no errorShapes and no errorsByStatus entry", () => {
		const consumer = `type E = Routes["/test"]["get"]
expectType<Equal<"errorShapes" extends keyof E ? true : false, false>>()
expectType<Equal<"errorsByStatus" extends keyof E ? true : false, false>>()
expectType<Equal<RouteErrorShapes<"/test", "get">, never>>()`
		expect(check(honeyDoc([{ method: "GET", pattern: "/test" }]), consumer)).toEqual([])
	})
})

describe("error shapes", () => {
	// v0: 382216f3e0
	it("maps each declared key to its own schema's type in errorShapes", () => {
		const consumer = `type S = RouteErrorShapes<"/items/:id", "get">
expectType<Equal<keyof S, "email_taken" | "item_not_found">>()
expectType<Same<S["item_not_found"], { reason: string; suggestions: string[] }>>()`
		expect(check(ITEMS, consumer)).toEqual([])
	})

	// v0: 6c61e09376
	it("gives a standard, schema-less key the shape null", () => {
		const app = withErrors("/test", { email_taken: { status: 409 } })
		const consumer = `expectType<Equal<RouteErrorShapes<"/test", "get">, { email_taken: null }>>()`
		expect(check(app, consumer)).toEqual([])
	})

	// v0: cec9d9e7a1
	it("resolves RouteErrorShapes<path, method> to the route's errorShapes", () => {
		const app = withErrors("/test", { not_found: { status: 404 } })
		const consumer = `expectType<Equal<RouteErrorShapes<"/test", "get">, Routes["/test"]["get"]["errorShapes"]>>()
expectType<Equal<RouteErrorShapes<"/test", "get">["not_found"], null>>()`
		expect(check(app, consumer)).toEqual([])
	})
})

describe("errors by status", () => {
	// v0: 5d9d759f72
	it("maps each status code to the shapes of the keys declared there", () => {
		const consumer = `type B = RouteErrorsByStatus<"/items/:id", "get">
expectType<Equal<keyof B, 404 | 409>>()
expectType<Same<B[404], { reason: string; suggestions: string[] }>>()
expectType<Equal<B[409], null>>()`
		expect(check(ITEMS, consumer)).toEqual([])
	})

	// v0: 47f3dd45a5
	it("maps a mounted sub-app's key by the status its own factory gave it", () => {
		const app = honeyDoc([
			{ errors: { api_error: { status: 500 } }, method: "GET", pattern: "/health" },
			{ errors: { locked: { status: 409 } }, method: "GET", pattern: "/sub/door" },
		])
		const consumer = `expectType<Equal<RouteErrorsByStatus<"/sub/door", "get">, { 409: null }>>()
expectType<Equal<RouteErrors<"/sub/door", "get">, "locked">>()`
		expect(check(app, consumer)).toEqual([])
	})

	it("keeps a key without a status in errors and errorShapes, out of errorsByStatus", () => {
		const app = withErrors("/door", { locked: { status: 409 }, vague: { status: null } })
		const consumer = `expectType<Equal<RouteErrors<"/door", "get">, "locked" | "vague">>()
expectType<Equal<RouteErrorShapes<"/door", "get">, { locked: null; vague: null }>>()
expectType<Equal<RouteErrorsByStatus<"/door", "get">, { 409: null }>>()`
		expect(check(app, consumer)).toEqual([])
	})

	it("never types an error response as a declared output", () => {
		const output = { "application/json": { ok: object({ id: STRING }) } }
		const app = withErrors("/items/:id", { item_not_found: { status: 404 } }, { output })
		const consumer = `expectType<Same<RouteOutput<"/items/:id", "get">, { "application/json": { ok: { id: string } } }>>()`
		expect(check(app, consumer)).toEqual([])
	})
})

describe("the ctx error factories", () => {
	it("holds one v1 factory per declared key: a standard key takes options, a schema key its payload", () => {
		const consumer = `declare const ctx: RouteCtx<"/items/:id", "get">
expectType<Equal<keyof typeof ctx.errors, "email_taken" | "item_not_found">>()
expectType<Equal<ReturnType<typeof ctx.errors.email_taken>, HoneyError>>()
ctx.errors.email_taken({ cause: 1, fields: { email: [{ error_key: "taken", message: "m", path: "email" }] }, headers: {}, vars: { n: 1 } })
ctx.errors.item_not_found({ reason: "gone", suggestions: [] }, { cause: 1 })
// @ts-expect-error: a schema key needs its payload
ctx.errors.item_not_found()
// @ts-expect-error: errors is readonly
ctx.errors = ctx.errors`
		expect(check(ITEMS, consumer)).toEqual([])
	})
})
