/**
 * The emitted `${stem}.types.gen.ts`, checked as a consumer sees it: a `consumer.ts` beside the emitted
 * files imports the SDK and states each type as a compile-time assertion, typechecked in-process.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Project, ts } from "ts-morph"
import { describe, expect, it } from "vitest"
import { type OpenApiDocument, toIR } from "../../ir/build.ts"
import { generateSdk, serviceMapOf } from "./sdk.ts"

type Json = Record<string, unknown>

/* one project for the file: the lib files parse once, each check swaps the SDK and the consumer */
const project = new Project({
	compilerOptions: {
		allowImportingTsExtensions: true,
		lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		skipLibCheck: true,
		strict: true,
		target: ts.ScriptTarget.ES2022,
	},
	useInMemoryFileSystem: true,
})

/** What every consumer starts with: the SDK, a safe-mode instance, and the assertion helpers. */
const prelude = (stem: string) => `import { ClientError, TestSDK } from "./${stem}.index.gen.ts"
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
declare function expectType<T extends true>(): void
type Fn = (...args: never[]) => unknown
type Result<F extends Fn> = Awaited<ReturnType<F>>
type Data<F extends Fn> = Extract<Result<F>, { error: null }> extends { data: infer D } ? D : never
type Failure<F extends Fn> = Exclude<Result<F>, { error: null }>
type Input<F extends Fn> = NonNullable<Parameters<F>[0]>
const sdk = new TestSDK({ baseURL: "https://api.example.com" })
void ClientError
`

/** Each diagnostic of `consumer` (or, with `all`, of every emitted file too) beside the SDK of `document`. */
function check(document: Json, consumer: string, scope: "all" | "consumer" = "consumer"): string[] {
	for (const file of project.getSourceFiles()) project.removeSourceFile(file)
	const { files, stem } = generateSdk(document, { name: "TestSDK" })
	for (const [name, text] of Object.entries(files)) project.createSourceFile(`/sdk/${name}`, text)
	const main = project.createSourceFile("/sdk/consumer.ts", `${prelude(stem)}${consumer}\n`)
	const diagnostics = scope === "all" ? project.getPreEmitDiagnostics() : main.getPreEmitDiagnostics()
	return diagnostics.map((d) => {
		const text = d.getMessageText()
		const message = typeof text === "string" ? text : text.getMessageText()
		return `${d.getSourceFile()?.getBaseName()}:${d.getLineNumber()}: ${message}`
	})
}

/** An OpenAPI 3.1 document of `paths`. */
const doc = (paths: Json): Json => ({ info: { title: "T", version: "1" }, openapi: "3.1.0", paths })

const json = (schema: Json) => ({ content: { "application/json": { schema } }, description: "" })
const object = (properties: Json, required = Object.keys(properties)) => ({ properties, required, type: "object" })
const STRING = { type: "string" }
const param = (name: string, schema: Json = STRING, place = "path") => ({ in: place, name, required: true, schema })

/** honey's error envelope for `status` and its error keys. */
const envelope = (status: number, keys: string[]) =>
	object({
		error_key: { enum: keys, type: "string" },
		fields: {
			additionalProperties: { items: object({ error_key: STRING, message: STRING, path: STRING }), type: "array" },
			type: "object",
		},
		message: STRING,
		status: { enum: [status], type: "integer" },
		status_key: STRING,
		success: { const: false },
	})

const RESULTS = doc({
	"/health": { get: { operationId: "health.check", responses: { 200: json(object({ status: STRING })) } } },
	"/items/{id}": {
		get: {
			operationId: "items.get",
			parameters: [param("id")],
			responses: {
				200: json(object({ id: STRING })),
				404: json(object({ reason: STRING })),
				409: json(object({ error_key: STRING, message: STRING })),
			},
		},
	},
	"/secure": {
		get: {
			operationId: "secure.get",
			responses: {
				200: json(object({ ping: { const: "pong" } })),
				400: json(envelope(400, ["bad_request"])),
				401: json(envelope(401, ["unauthorized"])),
				404: json(envelope(404, ["not_found"])),
			},
		},
	},
})

describe("a call's result branches", () => {
	// v0: c925ade565
	// v0: b024fa9ff3
	// v0: 955febe9dc
	it("types the success branch as { data, error: null, response, status }, every branch with response and status", () => {
		const consumer = `type S = Extract<Result<typeof sdk.health.check>, { error: null }>
expectType<Equal<keyof S, "data" | "error" | "response" | "status">>()
expectType<Same<S["data"], { status: string }>>()
expectType<Equal<S["error"], null>>()
expectType<Equal<S["response"], Response>>()
expectType<Equal<S["status"], number>>()
expectType<Result<typeof sdk.health.check> extends { response: Response; status: number } ? true : false>()`
		expect(check(RESULTS, consumer)).toEqual([])
	})

	// v0: f92f0fdca0
	// v0: 900fb63f15
	// v0: 0df7403d05
	// v0: 8ace3a444c
	it("types the error branch of a method without declared errors as the unknown raw body, never ClientError", () => {
		const consumer = `type F = Failure<typeof sdk.health.check>
expectType<Equal<keyof F, "data" | "error" | "response" | "status">>()
expectType<Equal<F["data"], null>>()
expectType<Equal<F["error"], unknown>>()
expectType<Equal<F["response"], Response>>()
expectType<Equal<F["status"], number>>()
expectType<Same<Extract<Failure<typeof sdk.items.get>, { status: 404 }>["error"], { reason: string }>>()
expectType<Failure<typeof sdk.items.get>["error"] extends ClientError ? false : true>()`
		expect(check(RESULTS, consumer)).toEqual([])
	})
})

describe("a call's declared errors", () => {
	// v0: 0cad6a4d7a
	// v0: 0f3e5284b9
	// v0: 4241b50e12
	it("narrows the error branch by status to each declared error body", () => {
		const consumer = `type R = Result<typeof sdk.items.get>
expectType<Same<Extract<R, { error: null }>["data"], { id: string }>>()
expectType<Same<Extract<R, { status: 404 }>["error"], { reason: string }>>()
expectType<Same<Extract<R, { status: 409 }>["error"], { error_key: string; message: string }>>()`
		expect(check(RESULTS, consumer)).toEqual([])
	})

	// v0: 53e990f9e5
	it("keys the error branch by exactly the declared statuses, with no unknown fallback arm", () => {
		const consumer = `type F = Failure<typeof sdk.items.get>
expectType<Equal<F["status"], 404 | 409>>()
expectType<unknown extends F["error"] ? false : true>()`
		expect(check(RESULTS, consumer)).toEqual([])
	})

	// v0: 08c896d7e4
	it("narrows data when !error, and the error to the declared bodies otherwise", () => {
		const consumer = `export async function narrow() {
	const r = await sdk.items.get({ params: { id: "1" } })
	if (!r.error) {
		expectType<Same<typeof r.data, { id: string }>>()
		return
	}
	expectType<Same<typeof r.error, { reason: string } | { error_key: string; message: string }>>()
}`
		expect(check(RESULTS, consumer)).toEqual([])
	})
})

describe("a call's errors in honey's envelope", () => {
	// v0: 6193b45b8b
	// v0: b72ff2324f
	// v0: bb594968f7
	it("types honey's error envelope at its declared status: all six keys, the status and the key as literals", () => {
		const consumer = `type F = Failure<typeof sdk.secure.get>
type E = Extract<F, { status: 404 }>["error"]
expectType<Equal<F["status"], 400 | 401 | 404>>()
expectType<Equal<keyof E, "error_key" | "fields" | "message" | "status" | "status_key" | "success">>()
expectType<Equal<[E["status"], E["error_key"], E["success"]], [404, "not_found", false]>>()
expectType<Same<E["fields"], Record<string, { error_key: string; message: string; path: string }[]>>>()
expectType<Equal<Extract<F, { status: 401 }>["error"]["error_key"], "unauthorized">>()`
		expect(check(RESULTS, consumer)).toEqual([])
	})

	// v0: 67ac56ccbb
	it("narrows on if (error) to a null data, the envelope's keys and the declared statuses", () => {
		const consumer = `export async function narrow() {
	const r = await sdk.secure.get()
	if (r.error) {
		expectType<Equal<typeof r.data, null>>()
		expectType<Equal<typeof r.error.error_key, "bad_request" | "unauthorized" | "not_found">>()
		expectType<Equal<typeof r.status, 400 | 401 | 404>>()
		return
	}
	expectType<Same<typeof r.data, { ping: "pong" }>>()
}`
		expect(check(RESULTS, consumer)).toEqual([])
	})
})

describe("an SDK instance's type", () => {
	// v0: 2bf37c5bd3
	it("resolves to the data itself under throwOnError: true", () => {
		const consumer = `const thrown = new TestSDK({ baseURL: "https://api.example.com", throwOnError: true })
expectType<Same<Awaited<ReturnType<typeof thrown.items.get>>, { id: string }>>()`
		expect(check(RESULTS, consumer)).toEqual([])
	})

	// v0: 8e55e22707
	it("types an instance as the declared SDK: its operations and its own members, nothing else", () => {
		const consumer = `const typed: TestSDK = sdk
expectType<Equal<typeof typed.state, Record<string, unknown>>>()
expectType<Equal<ReturnType<typeof typed.dispose>, void>>()
// @ts-expect-error no such operation
void sdk.items.nope`
		expect(check(RESULTS, consumer)).toEqual([])
	})
})

const ANSWERS = doc({
	"/a": {
		get: { operationId: "a", responses: { 200: json(STRING), default: json({ type: "number" }) } },
	},
	"/csv": { get: { operationId: "files.csv", responses: { 200: { content: { "text/csv": {} }, description: "" } } } },
	"/items/{id}": { delete: { operationId: "items.delete", parameters: [param("id")], responses: { 204: {} } } },
	"/moved": {
		get: { operationId: "moved", responses: { 307: { description: "", headers: { location: { schema: STRING } } } } },
	},
	"/orgs/{org}/feed": {
		get: {
			operationId: "feed.get",
			responses: { 200: { content: { "application/xml": { schema: STRING } }, description: "" } },
		},
		parameters: [param("org", { type: "integer" })],
	},
	"/problems": {
		get: {
			operationId: "problems.list",
			responses: { 200: { content: { "application/problem+json": { schema: object({ title: STRING }, []) } } } },
		},
	},
	"/projects/{id}/export": {
		post: { operationId: "project.export", parameters: [param("id")], responses: { 200: { description: "" } } },
	},
	"/text": {
		get: { operationId: "files.text", responses: { 200: { content: { "text/plain": {} }, description: "" } } },
	},
})

describe("a call's data type, by what the operation answers", () => {
	// v0: 37402502ed
	// v0: e9f13f34d9
	it("types a text/csv or text/plain answer as a string", () => {
		const consumer = `expectType<Equal<Data<typeof sdk.files.csv>, string>>()
expectType<Equal<Data<typeof sdk.files.text>, string>>()`
		expect(check(ANSWERS, consumer)).toEqual([])
	})

	// v0: c00913ed57
	// v0: ee7fbfbf7f
	it("types a 204, or a 200 without a body, as null, never void", () => {
		const consumer = `expectType<Equal<Data<typeof sdk.items.delete>, null>>()
expectType<Equal<Data<typeof sdk.project.export>, null>>()`
		expect(check(ANSWERS, consumer)).toEqual([])
	})

	it("types an op declaring no success body (only a 307) as null in safe and throw mode, raw as Response", () => {
		const consumer = `const thrower = new TestSDK({ baseURL: "https://x", throwOnError: true })
const thrown = () => thrower.moved()
const raw = () => sdk.moved({ raw: true })
expectType<Equal<Data<typeof sdk.moved>, null>>()
expectType<Equal<Result<typeof thrown>, null>>()
expectType<Equal<Result<typeof raw>, Response>>()`
		expect(check(ANSWERS, consumer)).toEqual([])
	})

	// v0: e7948c1bc6
	it("types a default response as neither the success data nor an error status", () => {
		const consumer = `expectType<Equal<Data<typeof sdk.a>, string>>()
expectType<Equal<Failure<typeof sdk.a>["status"], number>>()
expectType<Equal<Failure<typeof sdk.a>["error"], unknown>>()`
		expect(check(ANSWERS, consumer)).toEqual([])
	})

	// v0: faaa4fc03e
	it("types a path-item param in the input, an XML answer as a string and a +json one from its schema", () => {
		const consumer = `expectType<Equal<Input<typeof sdk.feed.get>["params"]["org"], number>>()
expectType<Equal<Data<typeof sdk.feed.get>, string>>()
expectType<Same<Data<typeof sdk.problems.list>, { title?: string }>>()`
		expect(check(ANSWERS, consumer)).toEqual([])
	})
})

const multipart = (schema: Json) => ({ content: { "multipart/form-data": { schema } }, required: true })
const BINARY = { format: "binary", type: "string" }

const INPUTS = doc({
	"/a/{user-id}": {
		get: {
			operationId: "a",
			parameters: [
				param("user-id"),
				param("x-tenant", STRING, "header"),
				{ in: "cookie", name: "session", schema: STRING },
			],
			responses: { 200: json(STRING) },
		},
	},
	"/items": { get: { operationId: "items.list", responses: { 200: json({ items: STRING, type: "array" }) } } },
	"/items/{id}": {
		post: {
			operationId: "items.create",
			parameters: [param("id")],
			requestBody: { content: { "application/json": { schema: object({ name: STRING }) } }, required: true },
			responses: { 201: json({ type: "object" }) },
		},
	},
	"/oauth/{provider}": {
		get: {
			operationId: "oauth.authorize",
			parameters: [param("provider", { enum: ["apple", "google"], type: "string" })],
			responses: { 200: json(STRING) },
		},
	},
	"/upload": { post: { operationId: "upload.file", requestBody: multipart(object({ file: BINARY })), responses: {} } },
	"/upload/json": {
		post: {
			operationId: "upload.json",
			requestBody: { content: { "application/json": { schema: object({ file: BINARY }) } }, required: true },
			responses: {},
		},
	},
	"/upload/many": {
		post: {
			operationId: "upload.files",
			requestBody: multipart(object({ files: { items: BINARY, type: "array" } })),
			responses: {},
		},
	},
	"/users/{id}": { get: { operationId: "users.get", parameters: [param("id")], responses: { 200: json(STRING) } } },
})

/** Each input case: what it shows, and the consumer code that shows it. */
const INPUT_CASES: [string, string][] = [
	// v0: 6a28ff9ecf
	[
		"takes no argument for a method without params, body or search",
		`void sdk.items.list()
// @ts-expect-error a path param makes the input required
void sdk.items.create()`,
	],
	// v0: 6d38f79ef0
	[
		"accepts signal?: AbortSignal on every HTTP method",
		`const signal = new AbortController().signal
void sdk.items.list({ signal })
void sdk.items.create({ json: { name: "n" }, params: { id: "1" }, signal })`,
	],
	// v0: 6075e129c0
	[
		"accepts headers?: Record<string, string> on every HTTP method",
		`void sdk.items.list({ headers: { "x-trace": "1" } })
// @ts-expect-error a header value is a string
void sdk.items.list({ headers: { "x-trace": 1 } })`,
	],
	// v0: dfdb631550
	[
		"accepts cookies?: Record<string, string> on every HTTP method",
		`void sdk.items.create({ cookies: { theme: "dark" }, json: { name: "n" }, params: { id: "1" } })
// @ts-expect-error a cookie value is a string
void sdk.items.list({ cookies: { theme: 1 } })`,
	],
	// v0: 4ab65615f0
	[
		"types declared header and cookie params, hyphenated names quoted, a required header required",
		`void sdk.a({ cookies: { session: "s" }, headers: { "x-tenant": "t" }, params: { "user-id": "u" } })
// @ts-expect-error the declared x-tenant header is required
void sdk.a({ params: { "user-id": "u" } })`,
	],
	// v0: 1db149e20a
	[
		"types an enum path param as the union of its values",
		`expectType<Equal<Input<typeof sdk.oauth.authorize>["params"]["provider"], "apple" | "google">>()
// @ts-expect-error not one of the enum's values
void sdk.oauth.authorize({ params: { provider: "github" } })`,
	],
	// v0: d6fe74eda5
	[
		"types a plain string path param as string",
		`expectType<Equal<Input<typeof sdk.users.get>["params"]["id"], string>>()`,
	],
	// v0: 172119f4b7
	[
		"types a multipart file part as Blob, so a File passes without a cast",
		`expectType<Equal<Input<typeof sdk.upload.file>["form"]["file"], Blob>>()
void sdk.upload.file({ form: { file: new File(["x"], "a.txt") } })`,
	],
	// v0: 66bd6c533f
	[
		"types a list of multipart file parts as Blob[]",
		`expectType<Equal<Input<typeof sdk.upload.files>["form"]["files"], Blob[]>>()`,
	],
	// v0: 304629f28e
	[
		"keeps a binary field inside a JSON body a string",
		`expectType<Equal<Input<typeof sdk.upload.json>["json"]["file"], string>>()`,
	],
]

describe("a call's input type", () => {
	it.each(INPUT_CASES)("%s", (_, consumer) => {
		expect(check(INPUTS, consumer)).toEqual([])
	})
})

const ODD = {
	components: { schemas: { "---": STRING, "1st": STRING, Response: object({ ok: { type: "boolean" } }) } },
	...doc({
		"/modes": {
			get: {
				operationId: "modes.get",
				parameters: [param("x-mode", { enum: ["a", "b"], type: "string" }, "header")],
				responses: { 200: json({ $ref: "#/components/schemas/Response" }) },
			},
		},
		"/notes": {
			put: {
				operationId: "notes.put",
				requestBody: { content: { "text/plain": { schema: STRING } } },
				responses: { 200: json({ $ref: "#/components/schemas/1st" }) },
			},
		},
	}),
}

describe("names and inputs the document leaves odd", () => {
	it("names a component past a reserved name, a leading digit or no words at all", () => {
		const consumer = `import type { Response2, Schema, Schema1st } from "./test-sdk.index.gen.ts"
expectType<Equal<Response2, { ok: boolean }>>()
expectType<Equal<[Schema, Schema1st], [string, string]>>()
expectType<Equal<Data<typeof sdk.modes.get>, Response2>>()`
		expect(check(ODD, consumer)).toEqual([])
	})

	it("types an enum header by its values, and takes no input field for a body it cannot send", () => {
		const consumer = `expectType<Equal<Input<typeof sdk.modes.get>["headers"]["x-mode"], "a" | "b">>()
expectType<"body" | "form" | "json" extends keyof Input<typeof sdk.notes.put> ? false : true>()`
		expect(check(ODD, consumer)).toEqual([])
	})
})

describe("the emitted SDK compiles", () => {
	// v0: b2f58ec1b8
	it("nests namespaces by dotted id and types a single-segment id as a callable at the root", () => {
		const nested = doc({
			"/checkout/sessions": { post: { operationId: "checkout.sessions.create", responses: { 201: json(STRING) } } },
			"/status": { get: { operationId: "getStatus", responses: { 200: json(STRING) } } },
			"/users": { get: { operationId: "users.list", responses: { 200: json(STRING) } } },
			"/users/{id}/profile": {
				patch: {
					operationId: "users.profile.update",
					parameters: [param("id")],
					requestBody: { content: { "application/json": { schema: object({ name: STRING }) } }, required: true },
					responses: { 200: json(STRING) },
				},
			},
		})
		const consumer = `void sdk.checkout.sessions.create()
void sdk.users.list()
void sdk.users.profile.update({ json: { name: "n" }, params: { id: "1" } })
expectType<Equal<Data<typeof sdk.getStatus>, string>>()
// @ts-expect-error a namespace is not callable
void sdk.users.profile()`
		expect(check(nested, consumer)).toEqual([])
	})

	// v0: 35207edef6
	it("emits a complete, compiling file set with an empty service map for a document without operations", () => {
		const empty = doc({})
		expect(Object.keys(serviceMapOf(toIR(empty as OpenApiDocument)))).toEqual([])
		expect(check(empty, "const typed: TestSDK = sdk\nvoid typed", "all")).toEqual([])
	})

	const SPECS = join(import.meta.dirname, "../../ir/__fixtures__/specs/python")

	// v0: 7682f55c19
	it.each(["crud", "discriminated", "invalidation", "ws", "sse", "refs", "reserved-words"])(
		"emits an SDK for the %s fixture that typechecks under strict",
		(name) => {
			const fixture = JSON.parse(readFileSync(join(SPECS, `${name}.json`), "utf8")) as Json
			expect(check(fixture, "void sdk", "all")).toEqual([])
		},
	)
})
