/* Minimal OpenAPI documents for the polyglot regression tests (polyglot.regression.test.ts). */

type Doc = Record<string, unknown>

export const doc = (paths: Record<string, unknown>, schemas: Record<string, unknown> = {}, extra: Doc = {}): Doc => ({
	components: { schemas },
	info: { title: "t", version: "1" },
	openapi: "3.1.0",
	paths,
	...extra,
})

export const jsonOk = (schema: unknown = { properties: { ok: { type: "boolean" } }, type: "object" }) => ({
	"200": { content: { "application/json": { schema } }, description: "ok" },
})

const contentOk = (type: string, schema: unknown = { type: "string" }) => ({
	"200": { content: { [type]: { schema } }, description: "ok" },
})

export const sseOk = contentOk("text/event-stream")

export const pathParam = (name: string) => ({ in: "path", name, required: true, schema: { type: "string" } })
export const queryParam = (name: string, schema: unknown = { type: "string" }) => ({ in: "query", name, schema })

export const jsonBody = (schema: unknown = { properties: { q: { type: "string" } }, type: "object" }) => ({
	content: { "application/json": { schema } },
	required: true,
})

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })

/** Operations the runtime checks call. Generated in both trees; Go reaches them through reflection,
 * so a signature that differs between the trees fails one check instead of the whole build. */
const runtimePaths = {
	"/users": {
		post: {
			operationId: "users.create",
			requestBody: jsonBody({ properties: { name: { type: "string" } }, type: "object" }),
			responses: jsonOk(),
			"x-invalidate": ["GET /users/:id"],
		},
	},
	"/users/{id}": { get: { operationId: "users.get", parameters: [pathParam("id")], responses: jsonOk() } },
	"/text": { get: { operationId: "text.get", responses: contentOk("text/plain") } },
	"/slow": { get: { operationId: "slow.get", responses: jsonOk() } },
	"/hop": { get: { operationId: "hop.get", responses: jsonOk() } },
	"/fail": { get: { operationId: "fail.get", responses: jsonOk() } },
	"/chat": {
		post: {
			operationId: "chat.send",
			parameters: [queryParam("model")],
			requestBody: jsonBody(),
			responses: sseOk,
		},
	},
	"/events": { get: { operationId: "events.list", responses: sseOk } },
	"/upload": {
		post: {
			operationId: "files.upload",
			requestBody: {
				content: {
					"multipart/form-data": {
						schema: {
							properties: { file: { format: "binary", type: "string" }, name: { type: "string" } },
							type: "object",
						},
					},
				},
				required: true,
			},
			responses: jsonOk(),
		},
	},
	"/form": {
		post: {
			operationId: "forms.submit",
			requestBody: {
				content: {
					"application/x-www-form-urlencoded": { schema: { properties: { name: { type: "string" } }, type: "object" } },
				},
				required: true,
			},
			responses: jsonOk(),
		},
	},
	"/union": { get: { operationId: "shapes.get", responses: jsonOk(ref("Shape")) } },
	"/extra": { get: { operationId: "extra.get", responses: jsonOk(ref("Labels")) } },
	"/bin": {
		get: {
			operationId: "bin.get",
			responses: contentOk("application/octet-stream", { format: "binary", type: "string" }),
		},
	},
}

const runtimeSchemas = {
	Circle: {
		properties: { kind: { const: "circle", type: "string" }, radius: { type: "number" } },
		required: ["kind", "radius"],
		type: "object",
	},
	Labels: { additionalProperties: { type: "string" }, properties: { name: { type: "string" } }, type: "object" },
	Shape: {
		discriminator: {
			mapping: { circle: "#/components/schemas/Circle", square: "#/components/schemas/Square" },
			propertyName: "kind",
		},
		oneOf: [ref("Circle"), ref("Square")],
	},
	Square: {
		properties: { kind: { const: "square", type: "string" }, side: { type: "number" } },
		required: ["kind", "side"],
		type: "object",
	},
}

export const runtimeSpec = doc(runtimePaths, runtimeSchemas)

const rawPath = {
	"/raw": {
		post: {
			operationId: "raw.send",
			requestBody: {
				content: { "application/octet-stream": { schema: { format: "binary", type: "string" } } },
				required: true,
			},
			responses: jsonOk(),
		},
	},
}

/** Go additionally calls a raw-body upload. */
export const goRuntimeSpec = doc({ ...runtimePaths, ...rawPath }, runtimeSchemas)

/** Python additionally calls a raw-body upload and an `{id}:action` path. */
export const pythonRuntimeSpec = doc(
	{
		...runtimePaths,
		...rawPath,
		"/ops/{id}:cancel": { post: { operationId: "ops.cancel", parameters: [pathParam("id")], responses: jsonOk() } },
	},
	runtimeSchemas,
)

/** The Go CLI checks: an apiKey header scheme, a big integer and an error body. */
export const cliRuntimeSpec = doc(
	{
		"/items": {
			get: {
				operationId: "items.list",
				responses: jsonOk({ properties: { id: { type: "integer" } }, type: "object" }),
			},
		},
		"/items/{id}": { get: { operationId: "items.get", parameters: [pathParam("id")], responses: jsonOk() } },
	},
	{},
	{
		components: { schemas: {}, securitySchemes: { apiKey: { in: "header", name: "X-API-Key", type: "apiKey" } } },
		security: [{ apiKey: [] }],
	},
)

/** Rust also calls an operation with an array and a nullable query parameter. */
export const rustRuntimeSpec = doc(
	{
		...runtimePaths,
		"/tags": {
			get: {
				operationId: "tags.list",
				parameters: [
					queryParam("ids", { items: { type: "string" }, type: "array" }),
					queryParam("maybe", { type: ["string", "null"] }),
				],
				responses: jsonOk(),
			},
		},
	},
	runtimeSchemas,
)
