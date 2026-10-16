/**
 * The phase-c fixture documents (contract 19 §4.3): `http`, the HTTP runtime's request build, auth, hooks,
 * answers, stale marks, overrides and binary bodies (throw mode as `http`, safe mode as `http-safe`); and
 * `errors`, the declared error keys `ErrorKey` is emitted from (G6/G7): keys that collide once spelled as
 * Rust idents, one an envelope schema declares, schemas that give `<Key>Data`, and error-keys.json's
 * `users.create` verbatim.
 */
import errorKeys from "../../../ir/__fixtures__/specs/rust/error-keys.json" with { type: "json" }

type Json = Readonly<Record<string, unknown>>

const STRING = { type: "string" }
const INTEGER = { type: "integer" }
const BINARY = { format: "binary", type: "string" }
const object = (properties: Json, required: readonly string[] = []): Json => ({ properties, required, type: "object" })
const media = (type: string, schema: Json): Json => ({ content: { [type]: { schema } } })
const ok = (schema: Json, status = 200): Json => ({
	[status]: { ...media("application/json", schema), description: "ok" },
})
const path = (name: string): Json => ({ in: "path", name, required: true, schema: STRING })
const query = (name: string, schema: Json): Json => ({ in: "query", name, schema })
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const body = (type: string, schema: Json): Json => ({ ...media(type, schema), required: true })

/** A GET answering `{id}`. */
const read = (operationId: string, parameters: readonly Json[] = []): Json => ({
	operationId,
	parameters,
	responses: ok(object({ id: STRING })),
})

/** A GET answering `{ok}`. */
const ping = (operationId: string): Json => ({
	get: { operationId, responses: ok(object({ ok: { type: "boolean" } })) },
})

/** An answer of media `type` holding `schema`. */
const answer = (type: string, schema: Json): Json => ({ 200: { ...media(type, schema), description: "ok" } })

/** A union variant: `kind` the const `kind`, and a number `field`. */
const variant = (kind: string, field: string): Json =>
	object({ kind: { const: kind, type: "string" }, [field]: { type: "number" } }, ["kind", field])

/** The `http` components: an `Item`, a map with a named member, and a discriminated union. */
function httpComponents(): Json {
	const mapping = { circle: "#/components/schemas/Circle", square: "#/components/schemas/Square" }
	return {
		schemas: {
			Circle: variant("circle", "radius"),
			Item: object({ id: STRING, name: STRING }, ["id", "name"]),
			Labels: { additionalProperties: STRING, properties: { name: STRING }, type: "object" },
			Shape: { discriminator: { mapping, propertyName: "kind" }, oneOf: [ref("Circle"), ref("Square")] },
			Square: variant("square", "side"),
		},
		securitySchemes: { bearer: { scheme: "bearer", type: "http" } },
	}
}

/** The request-build operations: path params out of path order, query arrays and brackets, form, multipart, idempotency. */
function requestPaths(): Json {
	const ok200 = ok(object({ ok: { type: "boolean" } }))
	const batch = object({
		count: INTEGER,
		files: { items: BINARY, type: "array" },
		flags: { items: { type: "boolean" }, type: "array" },
		meta: object({ k: INTEGER }),
	})
	const upload = object({ file: BINARY, name: STRING, tags: { items: STRING, type: "array" } })
	return {
		"/batch": {
			post: { operationId: "files.batch", requestBody: body("multipart/form-data", batch), responses: ok200 },
		},
		"/form": {
			post: {
				operationId: "forms.submit",
				requestBody: body("application/x-www-form-urlencoded", object({ name: STRING }, ["name"])),
				responses: ok200,
			},
		},
		"/orders": {
			post: {
				operationId: "orders.create",
				requestBody: body("application/json", object({ sku: STRING })),
				responses: ok(object({ id: STRING }, ["id"]), 201),
				"x-idempotency-key": true,
			},
		},
		"/orgs/{org}/users/{user-id}": {
			get: {
				operationId: "members.get",
				parameters: [
					path("user-id"),
					path("org"),
					query("ids", { items: STRING, type: "array" }),
					query("maybe", { type: ["string", "null"] }),
					query("page[size]", INTEGER),
				],
				responses: ok(object({ id: STRING, name: STRING }, ["id", "name"])),
			},
		},
		"/upload": {
			post: { operationId: "files.upload", requestBody: body("multipart/form-data", upload), responses: ok200 },
		},
	}
}

/** Plain GETs for wire legs, a binary upload, and invalidation sources and targets. */
function wirePaths(): Json {
	const users = ["GET /users", "GET /users/{id}"]
	const ok200 = ok(object({ ok: { type: "boolean" } }))
	return {
		"/a": { get: read("pages.a") },
		"/b": { get: read("pages.b") },
		"/c": { get: read("pages.c") },
		"/echo": ping("echo.get"),
		"/hop": ping("hop.get"),
		"/ping": ping("health.ping"),
		"/raw": {
			post: { operationId: "raw.send", requestBody: body("application/octet-stream", BINARY), responses: ok200 },
		},
		"/slow": ping("slow.get"),
		"/touch": {
			post: {
				operationId: "pages.touch",
				responses: ok(object({ id: STRING })),
				"x-invalidate": ["GET /a", "GET /b", "GET /c"],
			},
		},
		"/users": {
			get: read("users.list"),
			post: {
				operationId: "users.create",
				requestBody: body("application/json", object({ name: STRING })),
				responses: ok(object({ id: STRING })),
				"x-invalidate": users,
			},
		},
		"/users/{id}": {
			delete: {
				operationId: "users.delete",
				parameters: [path("id")],
				responses: ok(object({ id: STRING })),
				"x-invalidate": users,
			},
			get: read("users.get", [path("id")]),
		},
	}
}

/** The answer kinds: typed headers and a bodiless 404, a map, a union, text, and binary in and out. */
function answerPaths(): Json {
	const headers = { "X-Etag": { schema: STRING }, "X-Item-Version": { required: true, schema: INTEGER } }
	return {
		"/docs/{name}": {
			get: { operationId: "docs.get", parameters: [path("name")], responses: answer("application/pdf", BINARY) },
		},
		"/files/{name}": {
			get: {
				operationId: "files.get",
				parameters: [path("name")],
				responses: answer("application/octet-stream", BINARY),
			},
			put: {
				operationId: "files.put",
				parameters: [path("name")],
				requestBody: body("application/octet-stream", BINARY),
				responses: ok(object({ size: INTEGER }, ["size"])),
			},
		},
		"/items/{id}": {
			get: {
				operationId: "items.get",
				parameters: [path("id")],
				responses: {
					200: { ...media("application/json", ref("Item")), description: "ok", headers },
					404: { description: "missing" },
				},
			},
		},
		"/labels": { get: { operationId: "labels.get", responses: ok(ref("Labels")) } },
		"/notes": {
			post: {
				operationId: "notes.create",
				requestBody: body("text/plain", STRING),
				responses: answer("text/plain", STRING),
			},
		},
		"/shape": { get: { operationId: "shapes.get", responses: ok(ref("Shape")) } },
		"/text": { get: { operationId: "text.get", responses: answer("text/plain", STRING) } },
	}
}

/** The `http` document: one bearer scheme, no servers (a client always names its base URL). */
export function http(): Json {
	return {
		components: httpComponents(),
		info: { title: "Http", version: "1" },
		openapi: "3.1.0",
		paths: { ...requestPaths(), ...wirePaths(), ...answerPaths() },
	}
}

/** honey's error envelope for `status`, its `error_key` one of `keys` (the Go `errors.test.ts` ENVELOPE). */
export function envelope(status: number, keys: readonly string[]): Json {
	const field = object({ error_key: STRING, message: STRING, path: STRING })
	return object({
		error_key: { enum: keys, type: "string" },
		fields: { additionalProperties: { items: field, type: "array" }, type: "object" },
		message: STRING,
		status: { enum: [status], type: "integer" },
		status_key: STRING,
		success: { const: false },
	})
}

/** The operations whose `x-honey-errors` the keys come from: the first schema of a repeated key wins. */
function errorPaths(): Json {
	const declared = {
		"item.locked": { schema: object({ until: STRING }), status: 423 },
		item_locked: { status: 423 },
		item_not_found: { status: 404 },
		other: { status: 409 },
		"response.too_large": { status: null },
	}
	const close = {
		"order.closed": { schema: envelope(409, ["order.closed"]), status: 409 },
		"order.locked": { schema: ref("Lock"), status: 423 },
	}
	return {
		"/a": {
			post: { operationId: "orders.close", responses: { 204: { description: "closed" } }, "x-honey-errors": close },
		},
		"/b": {
			post: {
				operationId: "orders.reopen",
				responses: { 204: { description: "reopened" } },
				"x-honey-errors": { "order.locked": { schema: object({ other: STRING }), status: 423 } },
			},
		},
		"/items/{id}": {
			get: {
				operationId: "items.get",
				parameters: [path("id")],
				responses: {
					200: { ...media("application/json", ref("Item")), description: "ok" },
					404: { ...media("application/json", ref("E404")), description: "missing" },
				},
				"x-honey-errors": declared,
			},
		},
		"/users": errorKeys.paths["/users"],
	}
}

/** The `errors` document: an apiKey scheme in `X-API-Key`, and every key source the emitter reads. */
export function errors(): Json {
	return {
		components: {
			schemas: {
				E404: envelope(404, ["item_missing"]),
				Item: object({ id: STRING, name: STRING }, ["id", "name"]),
				Lock: object({ until: STRING }, ["until"]),
				User: errorKeys.components.schemas.User,
			},
			securitySchemes: { key: { in: "header", name: "X-API-Key", type: "apiKey" } },
		},
		info: { title: "Errors", version: "1" },
		openapi: "3.1.0",
		paths: errorPaths(),
	}
}
