/**
 * The hand-written fixture documents (contract 28 §6.1): `surface`, the call surface the driver smoke and the
 * consumer programs of `sdk.calls.test.ts` and `sdk.checks.test.ts` drive (§7.5); `types`, the components the
 * executed type legs of `types.compiled.test.ts` and `format.test.ts` check (§7.3, §7.4), with no `servers`; and
 * `relative`, whose first server is a relative URL, which no client can take as its base URL alone (R7).
 */
type Json = Readonly<Record<string, unknown>>

const STRING = { type: "string" }
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Json, required: readonly string[] = []): Json => ({ properties, required, type: "object" })
const body = (schema: Json): Json => ({ content: { "application/json": { schema } }, required: true })
const ok = (schema: Json): Json => ({ 200: { content: { "application/json": { schema } }, description: "ok" } })
const path = (name: string): Json => ({ in: "path", name, required: true, schema: STRING })
const query = (name: string, schema: Json, required = false): Json => ({ in: "query", name, required, schema })
const stream = (schema: Json): Json => ({ 200: { content: { "text/event-stream": { schema } }, description: "ok" } })

/** One operation: its id (none for a derived one), its parameters, its body and its 200 answer. */
const op = (operationId: string | undefined, rest: { parameters?: Json[]; requestBody?: Json; answer: Json }) => ({
	...(operationId === undefined ? {} : { operationId }),
	...(rest.parameters === undefined ? {} : { parameters: rest.parameters }),
	...(rest.requestBody === undefined ? {} : { requestBody: rest.requestBody }),
	responses: ok(rest.answer),
})

const BINARY = { content: { "application/octet-stream": { schema: { format: "binary", type: "string" } } } }

/* the query params named like a method's own arguments, the runtime's globals and builtins (H45/S3, 0d15be8471) */
const SHADOWS = [
	"options",
	"headers_into",
	"idempotency_key",
	"body",
	"timeout",
	"headers",
	"cancel_token",
	"uuid",
	"str",
	"json",
	"cast",
	"self",
]

/**
 * The streams and the edges: an SSE op declaring `Last-Event-ID` (the stream's own field, Fd3) and `X-Tenant`; a
 * namespace holding only a stream op beside another namespace (H44); an idempotent binary upload; and the root
 * reserved name `close` (`close.run`, reached as `close2`).
 */
function edgePaths(): Json {
	return {
		"/blobs": {
			post: {
				operationId: "blobs.upload",
				requestBody: { ...BINARY, required: true },
				responses: { 204: { description: "done" } },
				"x-idempotency-key": true,
			},
		},
		"/close/run": { post: op("close.run", { answer: ref("Template") }) },
		"/events": { get: { operationId: "events.stream", responses: stream(STRING) } },
		"/ticks": {
			get: {
				operationId: "ticks.stream",
				parameters: ["Last-Event-ID", "X-Tenant"].map((name) => ({ in: "header", name, schema: STRING })),
				responses: stream(ref("Tick")),
			},
		},
		"/x": { get: op("x.get", { answer: ref("Template") }) },
	}
}

/** The names, nesting and keywords: each a section of `sdk.calls.test.ts` (§7.5). */
function namePaths(): Json {
	return {
		"/a": { get: op("a.get", { answer: ref("NotFoundError") }) },
		"/class/from": { get: op("class.from", { answer: ref("Template") }) },
		"/contacts": { get: op("contacts.list", { answer: { items: ref("Template"), type: "array" } }) },
		"/keywords/{self}/{opts}/{url}": {
			get: op("keywords.params", { answer: ref("Template"), parameters: [path("self"), path("opts"), path("url")] }),
		},
		"/nothing/{id}": { delete: op(undefined, { answer: ref("Template"), parameters: [path("id")] }) },
		"/q": {
			get: op("q.list", {
				answer: { items: STRING, type: "array" },
				parameters: SHADOWS.map((name) => query(name, STRING)),
			}),
		},
		"/sync/contacts": { get: op("sync.contacts.list", { answer: { items: ref("Template"), type: "array" } }) },
		"/table-templates/{id}/use": {
			post: op("tableTemplates.use", {
				answer: ref("Template"),
				parameters: [path("id")],
				requestBody: body(ref("Template")),
			}),
		},
		"/types/{type}": { get: op("getByType", { answer: ref("Template"), parameters: [path("type")] }) },
	}
}

/** The `surface` paths. */
function surfacePaths(): Json {
	return {
		...edgePaths(),
		...namePaths(),
		"/checkout/sessions": {
			post: op("checkout.sessions.create", { answer: ref("Session"), requestBody: body(ref("SessionInput")) }),
		},
		"/exports": {
			get: op("exports.list", {
				answer: { items: STRING, type: "array" },
				parameters: [query("format", { enum: ["csv", "json"], type: "string" }, true)],
			}),
		},
		"/items": {
			get: op("items.list", {
				answer: { items: ref("Item"), type: "array" },
				parameters: [query("q", STRING), query("limit", { type: "integer" })],
			}),
		},
		"/orgs/{org}/members/{member}/notes": {
			post: op("orgs.members.notes.create", {
				answer: ref("Note"),
				parameters: [
					query("tag", STRING),
					path("member"),
					{ in: "header", name: "X-Trace", schema: STRING },
					path("org"),
				],
				requestBody: body(ref("NoteInput")),
			}),
		},
		"/users": {
			get: op("users.list", { answer: { items: ref("User"), type: "array" } }),
			post: op("users.create", { answer: ref("User"), requestBody: body(ref("UserCreateInput")) }),
		},
		"/users/{id}": { get: op("getUser", { answer: ref("User"), parameters: [path("id")] }) },
		"/users/{id}/profile": {
			patch: op("users.profile.update", {
				answer: ref("User"),
				parameters: [path("id")],
				requestBody: body(ref("ProfileInput")),
			}),
		},
	}
}

/**
 * Names, nesting and keywords; the clients' own ops; the NOTES op (two path params declared out of path order, a
 * query and a header param, a JSON body); a derived id; the runtime-reserved component names (H52: `Any`,
 * `ClientConfig`, `NotFoundError`, `SDK`); a required enum query; a stream-only namespace (H44); the contacts
 * pair; a binary upload; `servers[0]` for `SDK()` with no `base_url`; `info.description` for the docstrings.
 */
export function surface(): Json {
	return {
		components: {
			schemas: {
				Any: object({ id: STRING }),
				ClientConfig: object({ id: STRING }),
				Item: object({ id: STRING }, ["id"]),
				Note: object({ id: STRING, text: STRING }, ["id", "text"]),
				NoteInput: object({ tags: { items: STRING, type: "array" }, text: STRING }, ["text"]),
				NotFoundError: object({ code: STRING }),
				ProfileInput: object({ bio: STRING }),
				SDK: object({ id: STRING }),
				Session: object({ id: STRING }, ["id"]),
				SessionInput: object({ cart: STRING }),
				Template: object({ id: STRING }),
				Tick: object({ n: { type: "integer" } }, ["n"]),
				User: object({ id: STRING, name: STRING }, ["id"]),
				UserCreateInput: object({ name: STRING }, ["name"]),
			},
		},
		info: { description: "The Acme API.", title: "Acme", version: "1" },
		openapi: "3.1.0",
		paths: surfacePaths(),
		servers: [{ url: "https://api.acme.test/v1" }],
	}
}

/** The components of the type legs (§7.3): tri-state, H43 keys, recursion, inheritance, merging, closed and aliases. */
function typeSchemas(): Json {
	return {
		A: object({ b: ref("B") }),
		B: object({ a: ref("A") }),
		Base: object({ x: STRING }),
		Cat: object({ kind: STRING, lives: { type: "integer" } }, ["kind"]),
		Closed: { ...object({ id: STRING }, ["id"]), additionalProperties: false },
		Comment: object({ parent: ref("Comment") }),
		Dog: object({ kind: STRING, name: STRING }, ["kind"]),
		Empty: { additionalProperties: false, type: "object" },
		Ext: { allOf: [ref("Base"), object({ y: STRING })] },
		/* H43: keys no identifier spells, keywords among them, kept as spelled */
		Item: object({
			"2fa": { type: "boolean" },
			"@type": STRING,
			class: STRING,
			"content-type": STRING,
			from: STRING,
		}),
		Merged: { allOf: [object({ a: STRING }, ["a"]), object({ b: { type: "integer" } }, ["b"])] },
		Pet: { oneOf: [ref("Dog"), ref("Cat")] },
		Role: { enum: ["admin", "user"], type: "string" },
		Tags: { items: STRING, type: "array" },
		/* v0 tri-state-spec.ts: absent, null and a value are three different requests */
		Thing: object(
			{
				attrs: { additionalProperties: STRING, type: "object" },
				note: { type: ["string", "null"] },
				parent: { anyOf: [ref("Thing"), { type: "null" }] },
				plain: STRING,
				tags: { items: STRING, type: "array" },
				"x-key": { type: ["integer", "null"] },
			},
			["tags", "attrs"],
		),
		X: object({ id: STRING }, ["id"]),
	}
}

/** The executed type legs' document (§7.3). No `servers`: `SDK()` needs a `base_url` (R7). */
export function types(): Json {
	return {
		components: { schemas: typeSchemas() },
		info: { title: "Types", version: "1" },
		openapi: "3.1.0",
		paths: {
			"/items/{id}": { get: op("items.get", { answer: ref("Item"), parameters: [path("id")] }) },
			/* an inline array of inline objects answers with its hoisted item type */
			"/list": { get: op("list.get", { answer: { items: object({ a: STRING }), type: "array" } }) },
			"/ping": { get: op("ping", { answer: STRING }) },
			"/things": { post: op("things.create", { answer: ref("Thing"), requestBody: body(ref("Thing")) }) },
		},
	}
}

/** One operation under a relative first server (`/api`): `SDK()` needs an absolute `base_url` for it (R7). */
export function relative(): Json {
	return {
		info: { title: "Relative", version: "1" },
		openapi: "3.1.0",
		paths: { "/ping": { get: op("ping", { answer: STRING }) } },
		servers: [{ url: "/api" }],
	}
}
