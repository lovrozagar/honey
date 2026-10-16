/**
 * The adversarial OpenAPI corpus every polyglot emitter compiles (Go and Rust now; Python and the Go CLI
 * reuse it): a document whose every name, description and enum value is chosen to break naive
 * interpolation in an emitter. v0's hostile classes (keywords, leading-digit, hyphenated and
 * colliding snake/camel keys, quotes, backslashes, comment terminators, multi-line text, recursive
 * and union schemas, a streaming POST, multipart, urlencoded, text and binary bodies, realtime,
 * WebSocket, x-invalidate) plus v1's: prototype-named operation ids and keys, params named like the
 * emitted method's locals, receiver and imports, the runtime's own type names, and the code points
 * each target's escape policy exists for (U+FEFF, U+2028/9, NUL, DEL). The raw BOM is what makes a
 * Go build fail when the escape policy is bypassed. Rust's (bit 13): keywords no raw identifier can spell
 * (`self`, `Self`, `crate`, `super`), 2024's reserved `gen`, the method's locals, the prelude, runtime and
 * emitter type names a component would shadow, and format and escape spellings (`{x}`, `\u{41}`).
 * Made on use: a module under `src` runs no code as it loads.
 */

/* every code point a literal or comment writer must handle: CRLF, comment terminators, quotes, U+2028/9, BOM, NUL, BEL */
const NASTY =
	'First line.\r\nSecond with */ and """ and `tick` and C:\\temp and a trailing quote"\u2028\u2029\uFEFF\u0000\u0007'

const S = { type: "string" }
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const json = (schema: unknown) => ({ content: { "application/json": { schema } } })
const ok = (schema: unknown) => ({ 200: { ...json(schema), description: NASTY } })
const path = (...names: string[]) => names.map((name) => ({ in: "path", name, required: true, schema: S }))
const words = (text: string) => text.split(" ")

/* params named like a generated method's locals, its receiver, its imported packages and Go's keywords */
const GO_LOCALS = "ctx opts reqOpts r c params path err result body context http sdk fmt func range go"
/* Rust's: the method's locals, the keywords no raw identifier can spell, 2024's `gen`, and raw ones */
const RUST_LOCALS =
	"client form spec self Self crate super gen async await dyn fn impl match mod move ref use where try unsafe"
const LOCALS = `${GO_LOCALS} ${RUST_LOCALS}`

/* Rust's prelude and std names, the runtime's and the emitter's own (`ErrorKey`, an `<Op>Body`, an `<Op>Opts`) */
const RUST_NAMES =
	"Box Deserialize HashMap Option Result Self Some String Vec Call ClientConfig Error EventStream FilePart FromHeaders ResumableConnection TypedWebSocket ErrorKey FilesUploadBody LocalsAllOpts"

const STATUS = [
	"active",
	"-created_at",
	"created_at",
	"",
	"1h",
	'quo"te',
	"back\\slash",
	"line\nbreak",
	"*/",
	"`",
	"sep\u2028x",
	"par\u2029x",
	"\uFEFFbom",
	"nul\u0000x",
	"del\u007Fx",
	"{x}",
	"\\u{41}",
]

/** The hostile-keyed user: digit, symbol, quote, prototype, header-like, colliding and keyword keys. */
function user() {
	return {
		description: NASTY,
		properties: {
			"2fa": { type: "boolean" },
			"@type": S,
			/* computed, so it is an own key: a plain `"__proto__":` would set the literal's prototype instead */
			["__proto__"]: S,
			'a"b': S,
			constructor: S,
			"content-type": S,
			"line\nbreak": S,
			maybe: { type: ["string", "null"] },
			pet: ref("Pet"),
			"r#type": S,
			crate: S,
			gen: S,
			match: S,
			self: S,
			Self: S,
			status: ref("Status"),
			type: S,
			user_id: S,
			userId: S,
			weird: { description: NASTY, enum: ["x", "y"], type: "string" },
		},
		required: ["user_id"],
		type: "object",
	}
}

/** The components: recursive, union, enum and hostile-keyed schemas, then the names a target already owns. */
function schemas() {
	return {
		"2fa": { properties: { code: S }, type: "object" },
		A: { properties: { b: ref("B") }, type: "object" },
		B: { properties: { a: ref("A") }, type: "object" },
		Cat: {
			properties: { kind: { const: "cat", type: "string" }, meows: { type: "boolean" } },
			required: ["kind"],
			type: "object",
		},
		Dog: {
			properties: { barks: { type: "boolean" }, kind: { const: "dog", type: "string" } },
			required: ["kind"],
			type: "object",
		},
		Level: { enum: [-1, 0, 1, 2], type: "integer" },
		Mixed: { oneOf: [{ const: "a", type: "string" }, { const: "b", type: "string" }, { type: "integer" }] },
		Node: {
			properties: { children: { items: ref("Node"), type: "array" }, next: ref("Node"), value: S },
			required: ["value"],
			type: "object",
		},
		Pet: {
			discriminator: {
				mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
				propertyName: "kind",
			},
			oneOf: [ref("Cat"), ref("Dog")],
		},
		Status: { enum: STATUS, type: "string" },
		User: user(),
		/* the runtime's own exported names */
		Client: { properties: { id: S }, type: "object" },
		ClientError: { properties: { reason: S }, type: "object" },
		Config: { description: NASTY, properties: { name: S }, required: ["name"], type: "object" },
		LogEntry: { properties: { line: S }, type: "object" },
		RequestOption: { properties: { o: S }, type: "object" },
		SDKResult: { properties: { ok: { type: "boolean" } }, type: "object" },
		...Object.fromEntries(words(RUST_NAMES).map((name) => [name, { properties: { v: S }, type: "object" }])),
	}
}

/** One operation whose path params shadow every local and import, with a hostile query, header and body. */
function localsOp() {
	return {
		post: {
			description: NASTY,
			operationId: "locals.all",
			parameters: [
				...path(...words(LOCALS)),
				{ in: "query", name: "page[size]", schema: { type: "integer" } },
				{ in: "query", name: "order", schema: { enum: ['50%"off', "-created_at", "created_at"], type: "string" } },
				{ in: "query", name: "user_id", schema: S },
				{ in: "query", name: "userId", schema: S },
				{ in: "query", name: "ids", schema: { items: S, type: "array" } },
				{ in: "header", name: "x-tenant", schema: S },
			],
			requestBody: { ...json(ref("Config")), required: true },
			responses: {
				201: { ...json(ref("User")), description: NASTY },
				404: { ...json(ref("ClientError")), description: "missing" },
			},
			summary: 'Ends with "quote" */',
		},
	}
}

/** A binary download and a multipart upload on a path param named like an import. */
function filesOp() {
	const upload = {
		properties: { data: { format: "binary", type: "string" }, note: S },
		required: ["data"],
		type: "object",
	}
	return {
		get: {
			operationId: "files.download",
			parameters: path("url"),
			responses: {
				200: {
					content: { "application/octet-stream": { schema: { format: "binary", type: "string" } } },
					description: "ok",
				},
			},
		},
		put: {
			operationId: "files.upload",
			parameters: path("url"),
			requestBody: { content: { "multipart/form-data": { schema: upload } }, required: true },
			responses: { 204: { description: "done" } },
		},
	}
}

/** The paths up to the locals op: a digit id, a cycle, a runtime name, a stream, files and a form. */
function bodyPaths() {
	const form = { properties: { email: S, tags: { items: S, type: "array" } }, type: "object" }
	return {
		"/2fa": { get: { operationId: "2fa.get", responses: ok(ref("2fa")) } },
		"/a": { get: { operationId: "a.get", responses: ok(ref("A")) } },
		"/client": { get: { operationId: "client.get", responses: ok(ref("Client")) } },
		"/events/{room}": {
			post: {
				operationId: "events.stream",
				parameters: path("room"),
				requestBody: { ...json({ properties: { prompt: S }, type: "object" }), required: true },
				responses: { 200: { content: { "text/event-stream": { schema: S } }, description: "ok" } },
			},
		},
		"/files/{url}": filesOp(),
		"/forms": {
			post: {
				operationId: "forms.submit",
				requestBody: { content: { "application/x-www-form-urlencoded": { schema: form } } },
				responses: { 200: { content: { "text/plain": { schema: S } }, description: "ok" } },
			},
		},
		"/levels": { get: { operationId: "levels.list", responses: ok({ items: ref("Level"), type: "array" }) } },
		[`/locals/${words(LOCALS)
			.map((name) => `{${name}}`)
			.join("/")}`]: localsOp(),
	}
}

/** The paths after it: prototype and keyword ids, the streams, a stale mark and a hyphenated param. */
function readPaths() {
	const results = { l: ref("LogEntry"), o: ref("RequestOption"), r: ref("SDKResult") }
	const prelude = Object.fromEntries(words(RUST_NAMES).map((name) => [name, ref(name)]))
	return {
		"/mixed": { get: { operationId: "mixed.get", responses: ok(ref("Mixed")) } },
		"/nodes": { get: { operationId: "nodes.get", responses: ok(ref("Node")) } },
		"/nothing/{id}": { delete: { parameters: path("id"), responses: { 204: { description: "no operation id" } } } },
		"/p/__proto__": { get: { operationId: "__proto__.polluted", responses: ok(ref("User")) } },
		"/p/constructor": { get: { operationId: "constructor.y", responses: ok(ref("Pet")) } },
		"/self": { get: { operationId: "self.get", responses: ok(ref("Self")) } },
		"/type/match": { get: { operationId: "type.match", responses: ok({ properties: prelude, type: "object" }) } },
		"/realtime/{room}": {
			get: {
				operationId: "rooms.live",
				parameters: path("room"),
				responses: { 101: { description: "upgrade" } },
				"x-realtime": true,
			},
		},
		"/results": { get: { operationId: "results.get", responses: ok({ properties: results, type: "object" }) } },
		"/teams/{id}/members/{member_id}": {
			delete: {
				operationId: "teams.members.remove",
				parameters: path("id", "member_id"),
				responses: { 204: { description: "removed" } },
				"x-idempotency-key": true,
				"x-invalidate": ["GET /teams/{id}/members", "GET /users/{user-id}"],
			},
		},
		"/users/{user-id}": {
			get: {
				operationId: "users.get-by-id",
				parameters: path("user-id"),
				responses: { ...ok(ref("User")), 404: { ...json(ref("ClientError")), description: "missing" } },
			},
		},
		"/ws/{room}": {
			get: {
				operationId: "rooms.socket",
				parameters: path("room"),
				responses: { 101: { description: "upgrade" } },
				"x-websocket": true,
			},
		},
	}
}

/** The corpus document: hostile in every name, description and enum value it holds. */
export function adversarialCorpus(): Readonly<Record<string, unknown>> {
	return {
		components: { schemas: schemas() },
		info: { description: NASTY, title: 'Adversarial "API" */', version: "1.0.0" },
		openapi: "3.1.0",
		paths: { ...bodyPaths(), ...readPaths() },
	}
}
