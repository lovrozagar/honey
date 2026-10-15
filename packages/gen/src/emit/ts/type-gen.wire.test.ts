/**
 * `generateTypes` without extracted inputs: the wire types the document states — query, header and
 * cookie params, a JSON, form, multipart or byte body — and the output it answers, a default
 * response, a redirect and a body without a schema included.
 */
import * as tsMorph from "ts-morph"
import { describe, expect, it } from "vitest"
import type { RouteTreeV2 } from "./route-tree.ts"
import { typechecker } from "./__fixtures__/typecheck.ts"
import { generateTypes } from "./type-gen.ts"

type Json = Record<string, unknown>

const typecheck = typechecker(tsMorph)

const STRING = { type: "string" }
const EMPTY_TREE: RouteTreeV2 = { root: { d: null, m: null, s: {}, w: null, ws: null }, routes: {}, v: 2 }

/** A document of `operations` by path and method, each with `x-honey-route` set from its method and `pattern`. */
function documentOf(operations: Record<string, Record<string, Json & { pattern?: string }>>): Json {
	const paths = Object.fromEntries(
		Object.entries(operations).map(([path, methods]) => [
			path,
			Object.fromEntries(
				Object.entries(methods).map(([method, { pattern, ...op }]) => [
					method,
					{ responses: {}, ...op, "x-honey-route": `${method.toUpperCase()} ${pattern ?? path}` },
				]),
			),
		]),
	)
	return { info: { title: "T", version: "1" }, openapi: "3.1.0", paths }
}

/** The diagnostics of `consumer` beside the types of `document`. */
const check = (document: Json, consumer: string) =>
	typecheck(generateTypes({ document, extracted: null, report: () => {}, tree: EMPTY_TREE }), consumer, {})

const body = (type: string, schema?: Json) => ({
	content: { [type]: schema === undefined ? {} : { schema } },
	required: true,
})

describe("generateTypes: the wire input", () => {
	it("types query, header and cookie params, required or not, and each body kind by its media type", () => {
		const document = documentOf({
			"/bytes": { post: { requestBody: body("application/octet-stream") } },
			"/form": {
				post: { requestBody: body("application/x-www-form-urlencoded", { properties: { a: STRING }, type: "object" }) },
			},
			"/note": { post: { requestBody: body("text/plain", STRING) } },
			"/upload": { post: { requestBody: body("multipart/form-data", { properties: { f: STRING }, type: "object" }) } },
			"/x": {
				get: {
					parameters: [
						{ in: "query", name: "q", required: true, schema: STRING },
						{ in: "query", name: "page", schema: { type: "integer" } },
						{ in: "header", name: "x-id", required: true, schema: STRING },
						{ in: "cookie", name: "sid", schema: STRING },
					],
				},
			},
		})
		const consumer = `expectType<Equal<RouteInput<"/x", "get">, { search: { page?: number; q: string }; headers: { "x-id": string }; cookies: { sid?: string } }>>()
expectType<Equal<RouteInput<"/bytes", "post">, { binary: { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: "application/octet-stream" } }>>()
expectType<Equal<RouteInput<"/form", "post">, { form: { a?: string } }>>()
expectType<Equal<RouteInput<"/upload", "post">, { form: { f?: string } }>>()
expectType<Equal<RouteInput<"/note", "post">, {}>>()`
		expect(check(document, consumer)).toEqual([])
	})

	it("names an unnamed wildcard's param `*` and a named one by its name, and keeps an extracted prop optional", () => {
		const document = documentOf({
			"/files/{path}": { get: { pattern: "/files/*path" } },
			"/raw/{wildcard}": { get: { pattern: "/raw/*" } },
		})
		const extracted = {
			env: "{}",
			inputs: {},
			middleware: [{ name: "user", optional: true, type: "string" }],
			routes: {},
			taps: null,
		}
		const text = generateTypes({ document, extracted, report: () => {}, tree: EMPTY_TREE })
		expect(
			['readonly params: { "*": string }', "readonly params: { path: string }", "user?: string"].map((part) =>
				text.includes(part),
			),
		).toEqual([true, true, true])
	})
})

describe("generateTypes: the wire output", () => {
	it("keys answers by status key and media type, a body without schema unknown, a redirect true; default and errors left out", () => {
		const document = documentOf({
			"/go": { get: { responses: { 302: { description: "", headers: { Location: { schema: STRING } } } } } },
			"/x": {
				get: {
					responses: {
						200: { content: { "application/json": { schema: STRING }, "text/csv": {} }, description: "" },
						"2XX": { content: { "application/json": { schema: STRING } }, description: "" },
						default: { content: { "application/json": { schema: STRING } }, description: "" },
					},
				},
			},
		})
		const consumer = `expectType<Equal<RouteOutput<"/x", "get">, { "application/json": { ok: string }; "text/csv": { ok: unknown } }>>()
expectType<Equal<RouteOutput<"/go", "get">, { redirect: { found: true } }>>()`
		expect(check(document, consumer)).toEqual([])
	})
})
