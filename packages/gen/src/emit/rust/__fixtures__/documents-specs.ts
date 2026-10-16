/**
 * The hand-written fixture documents (contract 18 §7.1): `surface`, the call surface the driver smoke and the
 * consumer programs of `sdk.calls.test.ts` drive (§8.5); `types`, the components the executed type legs of
 * `types.compiled.test.ts` decode and encode (§8.3), with no `servers`; and `relative`, whose first server is a
 * relative URL, which no client can take as its base URL alone.
 */
type Json = Readonly<Record<string, unknown>>

const STRING = { type: "string" }
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Json, required: readonly string[] = []): Json => ({ properties, required, type: "object" })
const body = (schema: Json): Json => ({ content: { "application/json": { schema } }, required: true })
const ok = (schema: Json): Json => ({ 200: { content: { "application/json": { schema } }, description: "ok" } })
const path = (name: string): Json => ({ in: "path", name, required: true, schema: STRING })
const query = (name: string, schema: Json, required = false): Json => ({ in: "query", name, required, schema })

/** One operation: its id (none for a derived one), its parameters, its body and its 200 answer. */
const op = (operationId: string | undefined, rest: { parameters?: Json[]; requestBody?: Json; answer: Json }) => ({
	...(operationId === undefined ? {} : { operationId }),
	...(rest.parameters === undefined ? {} : { parameters: rest.parameters }),
	...(rest.requestBody === undefined ? {} : { requestBody: rest.requestBody }),
	responses: ok(rest.answer),
})

const BINARY = { content: { "application/octet-stream": { schema: { format: "binary", type: "string" } } } }

/**
 * The operations past the call surface: a text answer declaring response headers (one also on a 2xx without a
 * body, another spelled twice), an idempotent binary upload answering bytes, a text body behind six path
 * params (nine parameters), JSON bodies that are a string and a list (`&String`, `&Vec<String>`), a
 * search whose required query params span every `Default` case, and an event stream of JSON events whose
 * declared `Last-Event-ID` header is the stream's own field (Fd3).
 */
function edgePaths(): Json {
	const integer = { schema: { type: "integer" } }
	const many = ["a", "b", "c", "d", "e", "f"]
	return {
		"/blobs": {
			post: {
				operationId: "blobs.upload",
				requestBody: { ...BINARY, required: true },
				responses: { 200: { ...BINARY, description: "ok" } },
				"x-idempotency-key": true,
			},
		},
		[`/notes/${many.map((name) => `{${name}}`).join("/")}`]: {
			put: {
				operationId: "notes.put",
				parameters: many.map(path),
				requestBody: { content: { "text/plain": { schema: STRING } }, required: true },
				responses: { 204: { description: "done" } },
			},
		},
		"/reports/{id}": {
			get: {
				operationId: "reports.get",
				parameters: [path("id")],
				responses: {
					200: {
						content: { "text/plain": { schema: STRING } },
						description: "ok",
						headers: { "X-Trace-Id": { required: true, schema: STRING }, "X-Version": integer },
					},
					202: { description: "accepted" },
					206: { description: "partial", headers: { "x-version": integer } },
					404: { description: "missing" },
				},
			},
		},
		"/names": {
			post: { operationId: "names.echo", requestBody: body(STRING), responses: { 204: { description: "done" } } },
		},
		"/search": { get: op("search.run", { answer: { items: STRING, type: "array" }, parameters: searchParams() }) },
		"/tags": {
			put: {
				operationId: "tags.set",
				requestBody: body({ items: STRING, type: "array" }),
				responses: { 204: { description: "done" } },
			},
		},
		"/ticks": {
			get: {
				operationId: "ticks.stream",
				parameters: ["Last-Event-ID", "X-Tenant"].map((name) => ({ in: "header", name, schema: STRING })),
				responses: { 200: { content: { "text/event-stream": { schema: ref("Tick") } }, description: "ok" } },
			},
		},
	}
}

/** A required query param of each kind: bare when its Rust type has a `Default`, else an `Option`; and an optional nullable one. */
function searchParams(): Json[] {
	const required: Readonly<Record<string, Json>> = {
		any: {},
		box: object({ a: STRING }),
		filter: ref("Filter"),
		meta: { type: "object" },
		mix: { allOf: [object({ a: STRING }), object({ b: STRING })] },
		pick: ref("Pick"),
		q: STRING,
		range: { allOf: [ref("Filter")] },
		scope: ref("Scope"),
		shape: ref("Shape"),
		sort: ref("Sort"),
		tags: ref("Tags"),
		window: ref("Window"),
	}
	return [
		...Object.entries(required).map(([name, schema]) => query(name, schema, true)),
		query("cursor", { type: ["string", "null"] }),
	]
}

/** The edge operations' components, `Filter` described. */
const edgeSchemas = (): Json => ({
	Filter: { ...object({ field: STRING }), description: "What a search keeps." },
	Pick: {
		oneOf: [
			{ const: "a", type: "string" },
			{ const: "b", type: "string" },
		],
	},
	Scope: { allOf: [ref("Filter")] },
	Shape: { oneOf: [ref("Filter"), { type: "integer" }] },
	Sort: { enum: ["asc", "desc"], type: "string" },
	Tags: { additionalProperties: STRING, type: "object" },
	Tick: object({ n: { type: "integer" } }, ["n"]),
	Window: { const: "7d" },
})

/** The `surface` paths, each its own section of `sdk.calls.test.ts` (§8.5). */
function surfacePaths(): Json {
	return {
		...edgePaths(),
		"/checkout/sessions": {
			post: op("checkout.sessions.create", { answer: ref("Session"), requestBody: body(ref("SessionInput")) }),
		},
		"/config": { get: op("config.get", { answer: ref("Error") }) },
		"/exports": {
			get: op("exports.list", {
				answer: { items: STRING, type: "array" },
				parameters: [query("format", { enum: ["csv", "json"], type: "string" }, true)],
			}),
		},
		"/fn/run": { post: op("fn.run", { answer: ref("Template") }) },
		"/items": {
			get: op("items.list", {
				answer: { items: ref("Item"), type: "array" },
				parameters: [query("q", STRING), query("limit", { type: "integer" })],
			}),
		},
		"/keywords/{self}/{opts}/{url}": {
			get: op("keywords.params", { answer: ref("Template"), parameters: [path("self"), path("opts"), path("url")] }),
		},
		"/matches": { get: op("match.find", { answer: { items: ref("Template"), type: "array" } }) },
		"/nothing/{id}": { delete: op(undefined, { answer: ref("Template"), parameters: [path("id")] }) },
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
		"/table-templates/{id}/use": {
			post: op("tableTemplates.use", {
				answer: ref("Template"),
				parameters: [path("id")],
				requestBody: body(ref("Template")),
			}),
		},
		"/types": { post: op("type.create", { answer: ref("Template"), requestBody: body(ref("Template")) }) },
		"/types/{type}": { get: op("getByType", { answer: ref("Template"), parameters: [path("type")] }) },
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
 * Names, nesting and keywords; the Client's own ops; the NOTES op (two path params declared out of path order,
 * a query and a header param, a JSON body); a derived id; the runtime-reserved component names (H52); a
 * required enum query and two optional ones; `servers[0]` for `Client::new` with no `base_url`.
 */
export function surface(): Json {
	return {
		components: {
			schemas: {
				Client: object({ id: STRING }),
				Error: object({ code: STRING }),
				Item: object({ id: STRING }, ["id"]),
				Note: object({ id: STRING, text: STRING }, ["id", "text"]),
				NoteInput: object({ tags: { items: STRING, type: "array" }, text: STRING }, ["text"]),
				Option: object({ id: STRING }),
				ProfileInput: object({ bio: STRING }),
				Result: object({ id: STRING }),
				Session: object({ id: STRING }, ["id"]),
				SessionInput: object({ cart: STRING }),
				Template: object({ id: STRING }),
				User: object({ id: STRING, name: STRING }, ["id"]),
				UserCreateInput: object({ name: STRING }, ["name"]),
				...edgeSchemas(),
			},
		},
		info: { description: "The Acme API.", title: "Acme", version: "1" },
		openapi: "3.1.0",
		paths: surfacePaths(),
		servers: [{ url: "https://api.acme.test/v1" }],
	}
}

/**
 * The executed type legs' components (§8.3), each under a name of its own where two §8.2 rows share one:
 * the keyword struct is `Reserved` (its row's `Thing` is the tri-state one here) and the `extra` flatten is
 * `Extra` (its row's `Mixed` is the literal union here). No `servers`: `Client::new` needs a `base_url`.
 */
export function types(): Json {
	return {
		components: {
			schemas: {
				A: object({ b: ref("B") }),
				Animal: {
					discriminator: {
						mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
						propertyName: "kind",
					},
					oneOf: [ref("Dog"), ref("Cat")],
				},
				B: object({ a: ref("A") }),
				Cat: object({ kind: STRING, lives: { type: "integer" } }, ["kind"]),
				Dog: object({ kind: STRING, name: STRING }, ["kind"]),
				Extra: { ...object({ id: STRING }, ["id"]), additionalProperties: STRING },
				Kind: { enum: [1, 2], type: "integer" },
				Mixed: { oneOf: [{ const: "a", type: "string" }, { const: "b", type: "string" }, { type: "integer" }] },
				Q: object({ sort: { enum: ["-created_at", "created_at", "", "self"], type: "string" } }),
				Reserved: object({ fn: STRING, match: STRING, type: STRING }, ["fn", "match", "type"]),
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
				X: { additionalProperties: false, type: "object" },
			},
		},
		info: { title: "Types", version: "1" },
		openapi: "3.1.0",
		paths: { "/ping": { get: op("ping", { answer: STRING }) } },
	}
}

/** One operation under a relative first server (`/api`): `Client::new` needs an absolute `base_url` for it. */
export function relative(): Json {
	return {
		info: { title: "Relative", version: "1" },
		openapi: "3.1.0",
		paths: { "/ping": { get: op("ping", { answer: STRING }) } },
		servers: [{ url: "/api" }],
	}
}
