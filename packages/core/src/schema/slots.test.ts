import { describe, expect, it } from "vitest"
import { canonicalizeSchema } from "./canonicalize.ts"
import { shortHash } from "./naming.ts"
import { deduplicateSchemas, type SchemaSpec } from "./slots.ts"

type Json = Record<string, unknown>

const REF = "#/components/schemas/"
const STRING = { type: "string" }

/** A closed object of required string keys, or of the given property schemas. */
function object(properties: readonly string[] | Json): Json {
	const props = Array.isArray(properties) ? Object.fromEntries(properties.map((key) => [key, STRING])) : properties
	return { properties: props, required: Object.keys(props), type: "object" }
}

function envelope(status: number, keys: readonly string[], extra: Json = {}): Json {
	return object({
		error_key: { enum: keys, type: "string" },
		message: STRING,
		status: { const: status, type: "integer" },
		success: { const: false, type: "boolean" },
		...extra,
	})
}

const json = (schema: Json) => ({ content: { "application/json": { schema } } })
const answer = (schema: Json) => ({ ...json(schema), description: "" })

const SETTINGS = object(["locale", "theme"])
const ERR400 = envelope(400, ["invalid_input"])
const ERR404 = envelope(404, ["not_found"])
const ERR500 = envelope(500, ["service_unavailable", "bad_gateway", "internal_server_error", "gateway_timeout"])
const OK = object({ ok: { type: "boolean" } })

/** A spec of the shapes naming meets: unique, shared, colliding, nested and error envelopes. */
function fixture(): SchemaSpec {
	return {
		info: { title: "t", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/v1/auth/login": {
				post: { requestBody: json(object(["password", "user"])), responses: { 200: answer(object(["token"])) } },
			},
			"/v1/duplicate-shape-a": { post: { requestBody: json(object({ x: { type: "number" } })) } },
			"/v1/duplicate-shape-b": { post: { requestBody: json(object({ x: { type: "number" } })) } },
			"/v1/feedback": {
				post: { requestBody: json(object(["text"])), responses: { 400: answer(ERR400), 500: answer(ERR500) } },
			},
			"/v1/projects": {
				post: {
					requestBody: json(object(["name"])),
					responses: { 201: answer(object({ id: STRING, settings: SETTINGS })), 400: answer(ERR400) },
				},
			},
			"/v1/projects/{id}": { get: { responses: { 200: answer(object({ owner: STRING, settings: SETTINGS })) } } },
			"/v1/teams": {
				get: {
					responses: {
						200: answer(object({ teams: { items: STRING, type: "array" } })),
						400: answer(ERR400),
						404: answer(ERR404),
						500: answer(ERR500),
					},
				},
			},
			"/v1/users/{id}": { get: { responses: { 200: answer(object({ handle: STRING, settings: SETTINGS })) } } },
			"/v1/webhooks/github": {
				post: { requestBody: json(object({ payload: object(["repo"]) })), responses: { 200: answer(OK) } },
			},
			"/v1/webhooks/stripe": {
				post: { requestBody: json(object({ payload: object(["customer"]) })), responses: { 200: answer(OK) } },
			},
		},
	}
}

/** The schema at `pointer` (a path of keys) in `value`. */
function at(value: unknown, ...pointer: string[]): Json {
	return pointer.reduce<unknown>((node, key) => (node as Json)[key], value) as Json
}

/** `node` with every component $ref replaced by the component, all the way down. */
function resolved(node: unknown, schemas: Json): unknown {
	if (Array.isArray(node)) return node.map((child) => resolved(child, schemas))
	if (node === null || typeof node !== "object") return node
	const ref = (node as Json).$ref
	if (typeof ref === "string") return resolved(schemas[ref.slice(REF.length)], schemas)
	return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, resolved(child, schemas)]))
}

/** Every $ref string in `node`. */
function refs(node: unknown): string[] {
	if (node === null || typeof node !== "object") return []
	return Object.entries(node).flatMap(([key, child]) =>
		key === "$ref" && typeof child === "string" ? [child] : refs(child),
	)
}

describe("deduplicateSchemas: one component per shape, named for its operation", () => {
	// v0: a8ab5b551a
	// v0: 76a02dff45
	// v0: 20051ea463
	// v0: 7b235a7333
	// v0: e1602c4e55
	// v0: 218b9e4640
	// v0: 39e0f4b23a
	// v0: 468613b4a3
	// v0: 70c5a29632
	// v0: c4947a7197
	it("names a unique shape for its operation, a shared envelope Err{status}{keys}, and a collision by its hash", () => {
		const stripe = at(
			fixture().paths,
			"/v1/webhooks/stripe",
			"post",
			"requestBody",
			"content",
			"application/json",
			"schema",
		)
		const names = Object.keys(deduplicateSchemas(fixture()).components?.schemas ?? {}).sort()
		expect(names).toEqual(
			[
				"CreateAuthLoginRequest",
				"CreateAuthLoginResponse200",
				"CreateDuplicateShapeARequest",
				"CreateFeedbackRequest",
				"CreateProjectRequest",
				"CreateProjectResponse201",
				"CreateProjectResponse201Settings",
				"CreateWebhookRequest",
				`CreateWebhookRequest_${shortHash(canonicalizeSchema(stripe))}`,
				"CreateWebhookResponse200",
				"Err400InvalidInput",
				"Err500BadGatewayGatewayTimeoutInternalServerErrorServiceUnavailable",
				"GetProjectResponse200",
				"GetUserResponse200",
				"ListTeamsResponse200",
				"ListTeamsResponse404",
			].sort(),
		)
	})
})

describe("deduplicateSchemas: one shape, one component", () => {
	// v0: decc245a14
	// v0: 527de64ead
	// v0: 23c7acb661
	it("points every slot of one shape at one component: a shared body, a shared answer, a shared envelope", () => {
		const { paths } = deduplicateSchemas(fixture())
		const schema = (path: string, ...rest: string[]) =>
			at(paths, path, ...rest, "content", "application/json", "schema")
		expect([
			schema("/v1/duplicate-shape-a", "post", "requestBody"),
			schema("/v1/duplicate-shape-b", "post", "requestBody"),
			schema("/v1/webhooks/github", "post", "responses", "200"),
			schema("/v1/webhooks/stripe", "post", "responses", "200"),
		]).toEqual([
			{ $ref: `${REF}CreateDuplicateShapeARequest` },
			{ $ref: `${REF}CreateDuplicateShapeARequest` },
			{ $ref: `${REF}CreateWebhookResponse200` },
			{ $ref: `${REF}CreateWebhookResponse200` },
		])
		expect(refs(paths).filter((ref) => ref.endsWith("Err400InvalidInput"))).toHaveLength(3)
	})
})

describe("deduplicateSchemas: nothing lost", () => {
	// v0: f04abd28b3
	// v0: 743e793e04
	it("keeps every shape: each $ref resolves, and each slot resolves to the schema it had", () => {
		const before = fixture()
		const after = deduplicateSchemas(fixture())
		const schemas = after.components?.schemas ?? {}
		for (const ref of refs(after)) expect(Object.hasOwn(schemas, ref.slice(REF.length)), ref).toBe(true)
		expect(canonicalizeSchema(resolved(after.paths, schemas) as Json)).toBe(canonicalizeSchema(before.paths))
	})

	// v0: b442e7161f
	it("hoists a nested object two shapes share, and leaves one used once inline", () => {
		const after = deduplicateSchemas(fixture())
		const schemas = after.components?.schemas ?? {}
		expect([
			at(schemas, "GetUserResponse200", "properties", "settings"),
			at(schemas, "CreateProjectResponse201Settings"),
			at(schemas, "CreateWebhookRequest", "properties", "payload"),
		]).toEqual([{ $ref: `${REF}CreateProjectResponse201Settings` }, SETTINGS, object(["repo"])])
	})
})

describe("deduplicateSchemas: the same answer whatever the input order or pass", () => {
	// v0: 98efa44b74
	// v0: 593168ffa7
	// v0: d3c831ad11
	// v0: 56b68f17eb
	it("is byte-identical across runs, across path order, and on a second pass", () => {
		const once = deduplicateSchemas(fixture())
		const reversed = fixture()
		const shuffled = { ...reversed, paths: Object.fromEntries(Object.entries(reversed.paths).toReversed()) }
		expect(JSON.stringify(deduplicateSchemas(fixture()))).toBe(JSON.stringify(once))
		expect(JSON.stringify(deduplicateSchemas(shuffled))).toBe(JSON.stringify(once))
		expect(JSON.stringify(deduplicateSchemas(once))).toBe(JSON.stringify(once))
	})

	// v0: 1349f842b1
	it("treats two shapes that differ only in key order as one", () => {
		const a = { properties: { a: STRING, b: STRING, c: true }, type: "object" }
		const b = { type: "object", properties: { c: true, b: STRING, a: STRING } }
		const spec: SchemaSpec = {
			paths: { "/a": { post: { requestBody: json(a) } }, "/b": { post: { requestBody: json(b) } } },
		}
		expect(Object.keys(deduplicateSchemas(spec).components?.schemas ?? {})).toEqual(["CreateARequest"])
	})
})

describe("deduplicateSchemas: names never handed out twice", () => {
	// v0: 185c933e0b
	it("keeps three shapes of one name apart, even when two of their 24-bit hashes collide", () => {
		/* djb2 of {"enum":["aR"]} and {"enum":["b1"]} agrees in its first 24 bits */
		expect(shortHash(canonicalizeSchema({ enum: ["aR"] }))).toBe(shortHash(canonicalizeSchema({ enum: ["b1"] })))
		const content = {
			"application/json": { schema: { enum: ["first"] } },
			"application/xml": { schema: { enum: ["aR"] } },
			"text/plain": { schema: { enum: ["b1"] } },
		}
		const after = deduplicateSchemas({ paths: { "/x": { get: { responses: { 200: { content, description: "" } } } } } })
		const schemas = after.components?.schemas ?? {}
		const got = at(after.paths, "/x", "get", "responses", "200", "content")
		expect(Object.values(got).map((media) => resolved(at(media, "schema"), schemas))).toEqual([
			{ enum: ["first"] },
			{ enum: ["aR"] },
			{ enum: ["b1"] },
		])
		expect(Object.keys(schemas)).toHaveLength(3)
	})

	// v0: c1be7510ab
	it("leaves a name an existing component holds to it, and keeps the other components", () => {
		const taken = { description: "mine", type: "object" }
		const spec: SchemaSpec = {
			components: {
				schemas: { CreateARequest: taken },
				securitySchemes: { key: { in: "header", name: "k", type: "apiKey" } },
			},
			paths: { "/a": { post: { requestBody: json(object(["a"])) } } },
		}
		const after = deduplicateSchemas(spec)
		const hash = shortHash(canonicalizeSchema(object(["a"])))
		expect(after.components).toEqual({
			schemas: { CreateARequest: taken, [`CreateARequest_${hash}`]: object(["a"]) },
			securitySchemes: { key: { in: "header", name: "k", type: "apiKey" } },
		})
	})
})

describe("deduplicateSchemas: what stays as it is", () => {
	// v0: 95a3eb8401
	// v0: 76af7d7b0c
	it("hands back a spec with nothing to extract, keeps a $ref slot, and extracts a oneOf whole", () => {
		const empty: SchemaSpec = { paths: {} }
		const oneOf = { oneOf: [object(["a"]), object(["b"])] }
		const spec: SchemaSpec = {
			paths: {
				"/a": {
					delete: { responses: { 204: { description: "" } } },
					post: { requestBody: json(oneOf), responses: { 200: json({ $ref: `${REF}Elsewhere` }) } },
				},
			},
		}
		const after = deduplicateSchemas(spec)
		expect(deduplicateSchemas(empty)).toBe(empty)
		expect(after.components?.schemas).toEqual({ CreateARequest: oneOf })
		expect(at(after.paths, "/a", "post", "responses", "200", "content", "application/json", "schema")).toEqual({
			$ref: `${REF}Elsewhere`,
		})
		expect(at(after.paths, "/a", "delete")).toEqual({ responses: { 204: { description: "" } } })
	})
})

describe("deduplicateSchemas: status keys and nested objects", () => {
	it("names a default answer Response0 and a range answer by its hundred", () => {
		const spec: SchemaSpec = {
			paths: { "/a": { get: { responses: { "4XX": answer(object(["a"])), default: answer(object(["b"])) } } } },
		}
		expect(Object.keys(deduplicateSchemas(spec).components?.schemas ?? {}).sort()).toEqual([
			"ListAResponse0",
			"ListAResponse400",
		])
	})

	it("hoists no object only error envelopes share, and hoists an object inside a hoisted one too", () => {
		const fields = object(["path"])
		const color = object(["hex"])
		const theme = object({ color })
		const spec: SchemaSpec = {
			paths: {
				"/a": { get: { responses: { 200: answer(object({ theme })), 400: answer(envelope(400, ["x"], { fields })) } } },
				"/b": {
					get: {
						responses: { 200: answer(object({ id: STRING, theme })), 422: answer(envelope(422, ["y"], { fields })) },
					},
				},
			},
		}
		const schemas = deduplicateSchemas(spec).components?.schemas ?? {}
		expect(Object.keys(schemas).sort()).toEqual([
			"ListAResponse200",
			"ListAResponse200Theme",
			"ListAResponse200ThemeColor",
			"ListAResponse400",
			"ListBResponse200",
			"ListBResponse422",
		])
		expect([at(schemas, "ListAResponse200Theme"), at(schemas, "ListBResponse422", "properties", "fields")]).toEqual([
			object({ color: { $ref: `${REF}ListAResponse200ThemeColor` } }),
			fields,
		])
	})
})
