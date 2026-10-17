/**
 * The hand-written fixture documents (contract 45 §6.1): `surface`, the call surface the driver smoke and the
 * compiler checks of `sdk.checks.test.ts` drive (§7.5), C#'s hazards in Python's shapes; `types`, the components
 * the executed type legs of `types.compiled.test.ts` check (§7.4), with no `servers` (R7); and `relative`, whose
 * first server is a relative URL, which no client can take as its base URL alone (R7). No document holds a form,
 * multipart, binary or text body, a binary answer or a stream: the phase-b emitter refuses those (Fb1).
 */
type Json = Readonly<Record<string, unknown>>

const STRING = { type: "string" }
const INTEGER = { type: "integer" }
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Json, required: readonly string[] = []): Json => ({ properties, required, type: "object" })
const list = (items: Json): Json => ({ items, type: "array" })
const body = (schema: Json): Json => ({ content: { "application/json": { schema } }, required: true })
const ok = (schema: Json): Json => ({ 200: { content: { "application/json": { schema } }, description: "ok" } })
const path = (name: string): Json => ({ in: "path", name, required: true, schema: STRING })
const query = (name: string, schema: Json, required = false): Json => ({ in: "query", name, required, schema })

/** One operation: its id (none for a derived one), its parameters, its body, and its answers (a 200 by default). */
type Op = {
	readonly answer?: Json
	readonly parameters?: readonly Json[]
	readonly requestBody?: Json
	readonly responses?: Json
}

const op = (operationId: string | undefined, rest: Op): Json => ({
	...(operationId === undefined ? {} : { operationId }),
	...(rest.parameters === undefined ? {} : { parameters: rest.parameters }),
	...(rest.requestBody === undefined ? {} : { requestBody: rest.requestBody }),
	responses: rest.responses ?? ok(rest.answer ?? STRING),
})

/* the query params named like a method's own parameters (METHOD_LOCALS, `…2`) and C# keywords (`@…`) */
const SHADOWS = ["options", "cancellationToken", "body", "idempotencyKey", "event", "class", "value", "await"]

/**
 * The NOTES op (two path params declared out of path order, a query and a header param, a JSON body, a declared
 * 409), the idempotent create, the nested resources and the root ops (`getUser`, a derived DELETE id).
 */
function resourcePaths(): Json {
	return {
		"/checkout/sessions": {
			post: op("checkout.sessions.create", { answer: ref("Session"), requestBody: body(ref("SessionInput")) }),
		},
		"/nothing/{id}": { delete: op(undefined, { answer: ref("Template"), parameters: [path("id")] }) },
		"/orgs/{org}/members/{member}/notes": {
			post: op("orgs.members.notes.create", {
				parameters: [
					query("tag", STRING),
					path("member"),
					{ in: "header", name: "X-Trace", schema: STRING },
					path("org"),
				],
				requestBody: body(ref("NoteInput")),
				responses: { ...ok(ref("Note")), 409: { description: "conflict" } },
			}),
		},
		"/users": {
			get: op("users.list", { answer: list(ref("User")) }),
			post: {
				...op("users.create", { answer: ref("User"), requestBody: body(ref("UserCreateInput")) }),
				"x-idempotency-key": true,
			},
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
 * The names: the contacts pair, a keyword namespace (`class.from`), keyword path params, the shadowing query
 * params, a required enum query, two optional queries, a no-content op, and `dispose`, the client's own member.
 */
function namePaths(): Json {
	return {
		"/class/from": { get: op("class.from", { answer: ref("Template") }) },
		"/contacts": { get: op("contacts.list", { answer: list(ref("Template")) }) },
		"/dispose/run": { post: op("dispose.run", { answer: ref("Template") }) },
		"/event/{class}/{event}/{params}/{this}": {
			get: op("event.params", { answer: ref("Template"), parameters: ["class", "event", "params", "this"].map(path) }),
		},
		"/exports": {
			get: op("exports.list", {
				answer: list(STRING),
				parameters: [query("format", { enum: ["csv", "json"], type: "string" }, true)],
			}),
		},
		"/items": {
			get: op("items.list", { answer: list(ref("Item")), parameters: [query("q", STRING), query("limit", INTEGER)] }),
		},
		"/q": { get: op("q.list", { answer: list(STRING), parameters: SHADOWS.map((name) => query(name, STRING)) }) },
		"/sync/contacts": { get: op("sync.contacts.list", { answer: list(ref("Template")) }) },
		"/things/{id}": {
			delete: op("things.delete", { parameters: [path("id")], responses: { 204: { description: "deleted" } } }),
		},
	}
}

/**
 * The call surface (§7.5): the NOTES op, names, nesting and keywords; the components named like runtime and BCL
 * types and like the client (H52: `ClientConfig`, `NotFoundException`, `Task`, `AcmeClient`, each `…Model`);
 * `servers[0]` with a base path for a client with no `BaseUrl`; `info.description` for the client's remarks.
 */
export function surface(): Json {
	return {
		components: {
			schemas: {
				AcmeClient: object({ id: STRING }),
				ClientConfig: object({ id: STRING }),
				Item: object({ id: STRING }, ["id"]),
				Note: object({ id: STRING, text: STRING }, ["id", "text"]),
				NoteInput: object({ tags: list(STRING), text: STRING }, ["text"]),
				NotFoundException: object({ code: STRING }),
				ProfileInput: object({ bio: STRING }),
				Session: object({ id: STRING }, ["id"]),
				SessionInput: object({ cart: STRING }),
				Task: object({ id: STRING }),
				Template: object({ id: STRING }),
				User: object({ id: STRING, name: STRING }, ["id"]),
				UserCreateInput: object({ name: STRING }, ["name"]),
			},
		},
		info: { description: "The Acme API.", title: "Acme", version: "1" },
		openapi: "3.1.0",
		paths: { ...resourcePaths(), ...namePaths() },
		servers: [{ url: "https://api.acme.test/v1" }],
	}
}

/**
 * `Thing`, every field kind of §4.5: required, required nullable, tri-state, a number, a string list (`[null]`
 * refused, Fb6), an integer map (`{"k":null}` refused) and a string map (`NonNullMap`), a string and an integer
 * enum, an open value, a key no identifier spells, and a discriminated union.
 */
const thing = (): Json =>
	object(
		{
			attrs: { additionalProperties: INTEGER, type: "object" },
			color: { enum: ["red", "blue-green"], type: "string" },
			count: INTEGER,
			extra: {},
			id: STRING,
			labels: { additionalProperties: STRING, type: "object" },
			level: { enum: [1, 2], type: "integer" },
			note: { type: ["string", "null"] },
			parent: { type: ["string", "null"] },
			pet: ref("Pet"),
			ratio: { type: "number" },
			tags: list(STRING),
			"x-key": STRING,
		},
		["id", "count", "parent"],
	)

/** The components of the type legs (§7.4): `Thing`, the `Pet` union, recursion, a closed empty object, allOf. */
function typeSchemas(): Json {
	return {
		Base: object({ x: STRING }),
		Cat: object({ lives: INTEGER, petType: STRING }, ["petType"]),
		Comment: object({ parent: ref("Comment") }),
		Dog: object({ bark: { type: "boolean" }, petType: STRING }, ["petType"]),
		Empty: { additionalProperties: false, type: "object" },
		Ext: { allOf: [ref("Base"), object({ y: STRING })] },
		Pet: {
			discriminator: {
				mapping: { cat: "#/components/schemas/Cat", dog: "#/components/schemas/Dog" },
				propertyName: "petType",
			},
			oneOf: [ref("Dog"), ref("Cat")],
		},
		Thing: thing(),
	}
}

/** The executed type legs' document (§7.4). No `servers`: a client needs a `BaseUrl` (R7). */
export function types(): Json {
	return {
		components: { schemas: typeSchemas() },
		info: { title: "Types", version: "1" },
		openapi: "3.1.0",
		paths: {
			/* an inline array of inline objects answers with its hoisted item type */
			"/list": { get: op("list.get", { answer: list(object({ a: STRING })) }) },
			"/ping": {
				get: op("ping", { responses: { 200: { content: { "text/plain": { schema: STRING } }, description: "pong" } } }),
			},
			"/things": { post: op("things.create", { answer: ref("Thing"), requestBody: body(ref("Thing")) }) },
			"/things/{id}": { get: op("things.get", { answer: ref("Thing"), parameters: [path("id")] }) },
		},
	}
}

/** One operation under a relative first server (`/api`): a client needs an absolute `BaseUrl` for it (R7). */
export function relative(): Json {
	return {
		info: { title: "Relative", version: "1" },
		openapi: "3.1.0",
		paths: { "/ping": { get: op("ping", { answer: STRING }) } },
		servers: [{ url: "/api" }],
	}
}
