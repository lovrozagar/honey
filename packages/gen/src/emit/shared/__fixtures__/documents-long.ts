/**
 * The long-name document (bit 21 i7a): every name an emitter lays out, spelled at each length in `LONG_LENGTHS`, so a
 * signature, a call, a record's header, a constant, a twin and a type each cross every formatter's wrap width
 * (google-java-format's 100, ruff's 88, rustfmt's 100, oxfmt's 120) on both sides of it. Per length: an op group with
 * a read (path, query and header parameters, a response header, an error envelope), a create (a JSON body, no answer,
 * an invalidation), an upload (a multipart body), an SSE stream, a WebSocket and a realtime connection; components
 * with long properties, a string and an integer enum, a nullable self-reference, an open record and a discriminated
 * union of two long variants. Every SDK's format leg emits it and holds the output to its formatter as the repo runs it.
 */

type Json = Readonly<Record<string, unknown>>

/** The name lengths: 20 to 110 in steps of 9, so each width falls between two of them for every layout. */
export const LONG_LENGTHS: readonly number[] = [20, 29, 38, 47, 56, 65, 74, 83, 92, 101, 110]

const WORDS = ["widget", "Inventory", "Shipment", "Warehouse", "Allocation", "Reconciliation", "Ledger", "Batch"]

/** A camel-case name of exactly `length` letters, opening with `head`, cycling `WORDS` after it. */
export function longName(head: string, length: number): string {
	let name = head
	for (let i = 0; name.length < length; i += 1) name += WORDS[i % WORDS.length]
	return name.slice(0, length)
}

const STRING = { type: "string" }
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: Json): Json => ({ content: { "application/json": { schema } } })
const object = (properties: Json, required: readonly string[]): Json => ({ properties, required, type: "object" })

/** A union variant: `kind` the const `kind`, and a string `field`. */
const variant = (kind: string, field: string): Json =>
	object({ [field]: STRING, kind: { const: kind, type: "string" } }, ["kind", field])

/** `length`'s components: a record of long properties, its input, its error, an open record and a union. */
function schemas(length: number): Record<string, Json> {
	const model = longName("Model", length)
	const circle = longName("Circle", length)
	const square = longName("Square", length)
	return {
		[model]: object(
			{
				[longName("identifier", length)]: STRING,
				[longName("kind", length)]: { enum: [longName("first", length), longName("second", length)], type: "string" },
				[longName("labels", length)]: { items: STRING, type: "array" },
				[longName("level", length)]: { enum: [1, 2, 3], type: "integer" },
				[longName("parent", length)]: { anyOf: [ref(model), { type: "null" }] },
			},
			[longName("identifier", length), longName("kind", length)],
		),
		[longName("Input", length)]: object({ [longName("title", length)]: STRING }, [longName("title", length)]),
		[longName("Problem", length)]: object({ [longName("message", length)]: STRING }, [longName("message", length)]),
		[longName("Open", length)]: {
			additionalProperties: STRING,
			properties: { [longName("name", length)]: STRING },
			type: "object",
		},
		[circle]: variant(longName("circle", length), longName("radius", length)),
		[square]: variant(longName("square", length), longName("side", length)),
		[longName("Shape", length)]: {
			discriminator: {
				mapping: {
					[longName("circle", length)]: `#/components/schemas/${circle}`,
					[longName("square", length)]: `#/components/schemas/${square}`,
				},
				propertyName: "kind",
			},
			oneOf: [ref(circle), ref(square)],
		},
	}
}

/** `length`'s item path: a read with every parameter kind and a response header, a create that invalidates it. */
function item(length: number): Record<string, Json> {
	const group = longName("group", length)
	const id = longName("itemId", length)
	const read = `GET /${group}/{${id}}`
	const problem = { ...json(ref(longName("Problem", length))), description: "missing" }
	const pathParam = { in: "path", name: id, required: true, schema: STRING }
	return {
		[`/${group}/{${id}}`]: {
			get: {
				operationId: `${group}.${longName("read", length)}`,
				parameters: [
					pathParam,
					{ in: "query", name: longName("filter", length), required: true, schema: STRING },
					{ in: "query", name: longName("limit", length), schema: { type: "integer" } },
					{ in: "header", name: longName("trace", length), schema: STRING },
				],
				responses: {
					200: {
						...json(ref(longName("Model", length))),
						description: "ok",
						headers: { [longName("etag", length)]: { schema: STRING } },
					},
					404: problem,
				},
			},
			post: {
				operationId: `${group}.${longName("create", length)}`,
				parameters: [pathParam],
				requestBody: { ...json(ref(longName("Input", length))), required: true },
				responses: { 204: { description: "created" }, 404: problem },
				"x-invalidate": [read],
			},
		},
	}
}

/** `length`'s other paths: an upload, an open record, an event stream, a WebSocket and a realtime connection. */
function streams(length: number): Record<string, Json> {
	const group = longName("group", length)
	const events = { content: { "text/event-stream": { schema: ref(longName("Model", length)) } }, description: "events" }
	const upload = object(
		{ [longName("file", length)]: { format: "binary", type: "string" }, [longName("note", length)]: STRING },
		[],
	)
	return {
		[`/${group}/uploads`]: {
			post: {
				operationId: `${group}.${longName("upload", length)}`,
				requestBody: { content: { "multipart/form-data": { schema: upload } }, required: true },
				responses: { 200: { ...json(ref(longName("Shape", length))), description: "ok" } },
			},
		},
		[`/${group}/open`]: {
			get: {
				operationId: `${group}.${longName("open", length)}`,
				responses: { 200: { ...json(ref(longName("Open", length))), description: "ok" } },
			},
		},
		[`/${group}/events`]: {
			get: {
				operationId: `${group}.${longName("watch", length)}`,
				responses: { 200: events },
			},
		},
		[`/${group}/socket`]: {
			get: {
				operationId: `${group}.${longName("socket", length)}`,
				parameters: [{ in: "query", name: longName("room", length), schema: STRING }],
				responses: { 101: { description: "upgrade" } },
				"x-websocket": true,
			},
		},
		[`/${group}/live`]: {
			get: {
				operationId: `${group}.${longName("live", length)}`,
				parameters: [{ in: "query", name: longName("channel", length), required: true, schema: STRING }],
				responses: { 200: events },
				"x-realtime": true,
				"x-websocket": true,
			},
		},
	}
}

/** The long-name document: `LONG_LENGTHS`' paths and components in one API. */
export function longNames(): Json {
	return {
		components: { schemas: Object.assign({}, ...LONG_LENGTHS.map(schemas)) },
		info: { title: "Anyrow", version: "1" },
		openapi: "3.1.0",
		paths: Object.assign({}, ...LONG_LENGTHS.flatMap((length) => [item(length), streams(length)])),
	}
}
