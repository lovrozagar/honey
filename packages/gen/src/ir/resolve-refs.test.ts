import { describe, expect, it } from "vitest"
import type { OpenApiDocument } from "./build.ts"
import { resolveRefs } from "./resolve-refs.ts"

type Json = Record<string, unknown>

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: Json) => ({ content: { "application/json": { schema } } })

function doc(paths: Json, schemas?: Json, extra: Json = {}): OpenApiDocument {
	const components = schemas === undefined ? extra : { ...extra, schemas }
	return { components, info: { title: "T", version: "1" }, openapi: "3.1.0", paths } as OpenApiDocument
}

/** The schema at a body or response of `GET`/`POST /a` in `resolved`. */
function schemaAt(resolved: OpenApiDocument, ...path: string[]): unknown {
	return path.reduce<unknown>((node, key) => (node as Json)[key], resolved.paths?.["/a"])
}

describe("resolveRefs: every component $ref under a body or response inlined", () => {
	// v0: db6f34e7ea
	it("inlines each body and response schema, at every depth and in every content type, and drops the schema components", () => {
		const schemas = {
			Item: { properties: { tags: { items: ref("Tag"), type: "array" } }, type: "object" },
			Tag: { additionalProperties: ref("Word"), oneOf: [ref("Word"), true] },
			Word: { type: "string" },
		}
		const paths = {
			"/a": {
				get: {
					responses: {
						200: {
							content: {
								"application/json": { schema: ref("Item") },
								"text/csv": {},
								"text/plain": { schema: ref("Word") },
							},
						},
						204: {},
					},
				},
				post: { requestBody: json(ref("Word")), responses: {} },
				put: { requestBody: json(ref("Word")) },
			},
		}
		const resolved = resolveRefs(doc(paths, schemas, { securitySchemes: { key: { type: "apiKey" } } }))
		const word = { type: "string" }
		expect([
			schemaAt(resolved, "get", "responses", "200", "content", "application/json", "schema"),
			schemaAt(resolved, "get", "responses", "200", "content", "text/plain", "schema"),
			schemaAt(resolved, "post", "requestBody", "content", "application/json", "schema"),
			resolved.components,
		]).toEqual([
			{
				properties: { tags: { items: { additionalProperties: word, oneOf: [word, true] }, type: "array" } },
				type: "object",
			},
			word,
			word,
			{ securitySchemes: { key: { type: "apiKey" } } },
		])
	})
})

describe("resolveRefs: what stays as it is", () => {
	// v0: c5f0f9e9a5
	it("hands back a document without schema components as it is, and never changes its input", () => {
		const bare = doc({ "/a": { get: { responses: { 200: json({ type: "string" }) } } } })
		const input = doc({ "/a": { get: { responses: { 200: json(ref("A")) } } } }, { A: { type: "string" } })
		const before = structuredClone(input)
		const resolved = resolveRefs(input)
		expect([resolveRefs(bare), resolveRefs(doc({}, {}))]).toEqual([bare, doc({}, {})])
		expect(resolveRefs(bare)).toBe(bare)
		expect(resolveRefs({ components: { schemas: { A: {} } }, openapi: "3.1.0" }).paths).toEqual({})
		expect(
			schemaAt(
				resolveRefs(doc({ "/a": { get: { responses: { 200: { content: { "text/csv": {} } } } } } }, { A: {} })),
				"get",
				"responses",
				"200",
				"content",
			),
		).toEqual({ "text/csv": {} })
		expect([input, resolved.components]).toEqual([before, undefined])
	})
})

describe("resolveRefs: where inlining stops", () => {
	it("cuts a cycle with an empty schema, refuses a dangling ref, and caps an exponential expansion", () => {
		const cyclic = resolveRefs(
			doc(
				{ "/a": { get: { responses: { 200: json(ref("Node")) } } } },
				{ Node: { properties: { next: ref("Node") }, type: "object" } },
			),
		)
		expect(schemaAt(cyclic, "get", "responses", "200", "content", "application/json", "schema")).toEqual({
			properties: { next: {} },
			type: "object",
		})
		expect(() => resolveRefs(doc({ "/a": { get: { responses: { 200: json(ref("Gone")) } } } }, { A: {} }))).toThrow(
			"$ref points to nonexistent component: #/components/schemas/Gone",
		)
		const levels: Json = { L0: { type: "string" } }
		for (let n = 1; n <= 20; n++)
			levels[`L${n}`] = { properties: { a: ref(`L${n - 1}`), b: ref(`L${n - 1}`) }, type: "object" }
		expect(() => resolveRefs(doc({ "/a": { get: { responses: { 200: json(ref("L20")) } } } }, levels))).toThrow(
			"SDK codegen: inlined schemas exceed 200000 nodes (deeply shared $refs); flatten the shared component chain",
		)
	})
})
