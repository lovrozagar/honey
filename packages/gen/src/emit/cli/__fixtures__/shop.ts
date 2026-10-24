/**
 * The CLI's command fixture (bit 17 phase b): every shape a command takes. It holds:
 * - a nested resource, two path params, and a flat id;
 * - ids that collide with the root's built-ins (`version`, `help`) and a parameter that collides with a global flag
 *   (`timeout`);
 * - every flag kind: integer, number, boolean, enum, a list, a header;
 * - a required query param and a JSON body with scalar and object fields;
 * - text, form and binary bodies, and binary and empty answers;
 * - a multipart operation (phase c);
 * - the streams (phase d): untyped and typed server-sent events, a WebSocket, a realtime feed.
 * It declares no server, so a run needs a base URL.
 */
type Json = Record<string, unknown>

const STRING = { type: "string" }
const ITEM = { properties: { id: STRING, name: STRING }, required: ["id", "name"], type: "object" }
const json = (schema: Json) => ({ content: { "application/json": { schema } } })
const ok = (schema: Json, status = 200) => ({ [status]: { ...json(schema), description: "ok" } })
const NONE = { 204: { description: "done" } }
const path = (name: string) => ({ in: "path", name, required: true, schema: STRING })
const query = (name: string, schema: Json, required = false) => ({ in: "query", name, required, schema })

/** `items.list`: every flag kind, a header, and a parameter named like a global flag. */
const list = () => ({
	operationId: "items.list",
	parameters: [
		query("limit", { type: "integer" }),
		query("ratio", { type: "number" }),
		query("flag", { type: "boolean" }),
		query("kind", { enum: ["cat", "dog"], type: "string" }),
		query("tags", { items: STRING, type: "array" }),
		query("timeout", STRING),
		{ in: "header", name: "X-Trace", schema: STRING },
	],
	responses: ok({ items: ITEM, type: "array" }),
	summary: "List items",
})

/** `items.create`: a required JSON body, scalar and object fields, an enum field. */
const create = () => ({
	operationId: "items.create",
	requestBody: {
		required: true,
		...json({
			properties: {
				meta: { type: "object" },
				n: { type: "integer" },
				name: STRING,
				size: { enum: ["s", "m"], type: "string" },
			},
			required: ["name"],
			type: "object",
		}),
	},
	responses: ok(ITEM, 201),
	summary: "Create an item",
})

/** The items resource: list, create, search, get, delete, and a nested resource with two path params. */
const itemPaths = (): Json => ({
	"/items": { get: list(), post: create() },
	"/items/search": {
		get: {
			operationId: "items.search",
			parameters: [query("q", STRING, true)],
			responses: ok({ items: ITEM, type: "array" }),
		},
	},
	"/items/{id}": {
		delete: { operationId: "items.delete", parameters: [path("id")], responses: NONE },
		get: {
			operationId: "items.get",
			parameters: [path("id")],
			responses: { 200: { ...json(ITEM), description: "ok", headers: { "x-item-version": { schema: STRING } } } },
			summary: "Get an item",
		},
	},
	"/items/{id}/tags/{tagId}": {
		get: { operationId: "items.tags.get", parameters: [path("id"), path("tagId")], responses: ok(STRING) },
	},
})

/** The bodies and answers past JSON: binary both ways, form, text. */
const bodyPaths = (): Json => ({
	"/files/{name}": {
		get: {
			operationId: "files.get",
			parameters: [path("name")],
			responses: { 200: { content: { "application/octet-stream": {} }, description: "bytes" } },
		},
		put: {
			operationId: "files.put",
			parameters: [path("name")],
			requestBody: { content: { "application/octet-stream": {} }, required: true },
			responses: NONE,
		},
	},
	"/forms": {
		post: {
			operationId: "forms.submit",
			requestBody: {
				content: {
					"application/x-www-form-urlencoded": {
						schema: { properties: { a: STRING, b: { type: "integer" } }, type: "object" },
					},
				},
				required: true,
			},
			responses: NONE,
		},
	},
	"/notes": {
		post: {
			operationId: "notes.create",
			requestBody: { content: { "text/plain": { schema: STRING } }, required: true },
			responses: { 200: { content: { "text/plain": { schema: STRING } }, description: "the note" } },
		},
	},
})

/** A JSON body typed past a named struct: a pointer (nullable), a raw JSON value (no schema), a slice of structs. */
const typedBodies = (): Json => ({
	"/bulk": {
		post: {
			operationId: "bulk.send",
			requestBody: { ...json({ items: { $ref: "#/components/schemas/Pet" }, type: "array" }), required: true },
			responses: NONE,
		},
	},
	"/pets": {
		put: {
			operationId: "pets.put",
			requestBody: json({ anyOf: [{ $ref: "#/components/schemas/Pet" }, { type: "null" }] }),
			responses: NONE,
		},
	},
	"/raw": { post: { operationId: "raw.send", requestBody: { ...json({}), required: true }, responses: NONE } },
})

/** A `text/event-stream` answer whose events are `schema`. */
const events = (schema: Json) => ({ 200: { content: { "text/event-stream": { schema } }, description: "events" } })
const TICK = { properties: { msg: STRING, n: { type: "integer" } }, required: ["n"], type: "object" }

/** The streams: untyped and typed server-sent events, a WebSocket, a realtime feed with a declared query param. */
const streamPaths = (): Json => ({
	"/chat": {
		get: { operationId: "chat.connect", responses: { 101: { description: "upgrade" } }, "x-websocket": true },
	},
	"/events": { get: { operationId: "events.stream", responses: events(STRING) } },
	"/feed": {
		get: {
			operationId: "feed.live",
			parameters: [query("channel", STRING)],
			responses: events(TICK),
			"x-realtime": true,
			"x-websocket": true,
		},
	},
	"/ticks": { get: { operationId: "ticks.stream", responses: events(TICK), summary: "Ticks, typed" } },
})

/** The flat ids, the built-in collisions, and the multipart operation. */
const otherPaths = (): Json => ({
	"/dump": { get: { operationId: "dump.get", responses: ok({}), summary: "Any JSON, as the API sends it" } },
	"/health": {
		get: { operationId: "health", responses: ok({ properties: { ok: { type: "boolean" } }, type: "object" }) },
	},
	"/help": { get: { operationId: "help.show", responses: ok(STRING) } },
	"/uploads": {
		post: {
			operationId: "uploads.create",
			requestBody: {
				content: {
					"multipart/form-data": {
						schema: {
							properties: {
								extras: { items: { format: "binary", type: "string" }, type: "array" },
								file: { format: "binary", type: "string" },
								note: STRING,
							},
							type: "object",
						},
					},
				},
			},
			responses: NONE,
		},
	},
	"/version": { get: { operationId: "version", responses: ok(STRING) } },
})

/** The shop API: every shape a command takes, phase b's to d's. */
export function shop(): Json {
	return {
		info: { title: "Shop", version: "1" },
		openapi: "3.1.0",
		components: { schemas: { Pet: { properties: { name: STRING }, type: "object" } } },
		paths: { ...itemPaths(), ...bodyPaths(), ...typedBodies(), ...streamPaths(), ...otherPaths() },
	}
}
