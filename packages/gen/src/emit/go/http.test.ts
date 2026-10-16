import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk } from "./__fixtures__/compiled.ts"
import type { GoError, Script } from "../shared/__fixtures__/protocol.ts"
import { check, checkServed, seen } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { generateGoSdk } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const STRING = { type: "string" }
const OBJECT = (properties: Json, required: string[] = []) => ({ properties, required, type: "object" })
const content = (type: string, schema: Json) => ({ content: { [type]: { schema } } })
const OK = { 200: { ...content("application/json", OBJECT({ ok: { type: "boolean" } })), description: "ok" } }

/**
 * REQ: a GET under two path params (declared out of path order) with an array, a nullable and a
 * bracketed query param; an urlencoded POST, a multipart POST, an idempotent JSON POST and a ping.
 */
const REQ: Json = {
	info: { title: "Req", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/form": {
			post: {
				operationId: "forms.submit",
				requestBody: {
					...content("application/x-www-form-urlencoded", OBJECT({ name: STRING }, ["name"])),
					required: true,
				},
				responses: OK,
			},
		},
		"/orders": {
			post: {
				operationId: "orders.create",
				requestBody: { ...content("application/json", OBJECT({ sku: STRING })), required: true },
				responses: { 201: { ...content("application/json", OBJECT({ id: STRING }, ["id"])), description: "created" } },
				"x-idempotency-key": true,
			},
		},
		"/orgs/{org}/users/{user-id}": {
			get: {
				operationId: "users.get",
				parameters: [
					{ in: "path", name: "user-id", required: true, schema: STRING },
					{ in: "path", name: "org", required: true, schema: STRING },
					{ in: "query", name: "ids", schema: { items: STRING, type: "array" } },
					{ in: "query", name: "maybe", schema: { type: ["string", "null"] } },
					{ in: "query", name: "page[size]", schema: { type: "integer" } },
				],
				responses: OK,
			},
		},
		"/ping": { get: { operationId: "health.ping", responses: OK } },
		"/upload": {
			post: {
				operationId: "files.upload",
				requestBody: {
					...content(
						"multipart/form-data",
						OBJECT({
							file: { format: "binary", type: "string" },
							name: STRING,
							tags: { items: STRING, type: "array" },
						}),
					),
					required: true,
				},
				responses: OK,
			},
		},
	},
}

const MODULE = "example.com/req"

const user = (params: Record<string, string>, extra: Partial<Call> = {}): Call => ({
	operation: "users.get",
	params,
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
	...extra,
})
const PING: Call = { operation: "health.ping", route: { method: "GET", path: "/ping" } }
const ORDER: Call = {
	body: { kind: "json", value: { sku: "s" } },
	operation: "orders.create",
	route: { method: "POST", path: "/orders" },
}

const FOUND: Reply = { json: { ok: true }, status: 200 }
const DATA = { data: { ok: true }, kind: "data", status: 200 } satisfies Observed
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

let driven: DrivenSdk | undefined
/** The SDK for REQ compiled with the driver once, which must build and vet clean. */
function reqSdk(): DrivenSdk {
	driven ??= compiledSdk(REQ, { modulePath: MODULE })
	expect({ built: driven.built, vet: driven.vet }, driven.stderr).toEqual({ built: true, vet: [] })
	return driven
}

/** `calls` run against a server answering `replies`, the client aimed at `base(server.url)`: the run and its hops. */
function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	return served(replies, async (server) => {
		const origin = { alt: server.alt, url: (options.base ?? ((url: string) => url))(server.url) }
		const run = await reqSdk().runCalls({ calls, setup: options.setup ?? {} }, origin, options.script)
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}
type Options = { readonly base?: (url: string) => string; readonly script?: Script; readonly setup?: Setup }

/** A Go error of no wrapping honey type, as the trace records it. */
const plain = (entry: Partial<GoError>) => ({
	canceled: false,
	deadline: false,
	tooLarge: false,
	via: "return",
	...entry,
})

/** The trace of a `user-id` value refused as a path segment. */
const refused = (value: string) =>
	plain({
		chain: ["*sdk.PathParamError"],
		pathParam: { missing: false, name: "user-id", value },
		text: `Invalid path param "user-id": ${JSON.stringify(value)} is not a path segment`,
		type: "*sdk.PathParamError",
	})

/** REQ's SDK files, for a consumer program beside them. */
const reqFiles = () => generateGoSdk(REQ, { modulePath: MODULE }).files

goDescribe("path params: each value escaped as one segment, in path order", () => {
	// v0: 5770bf39ca
	// v0: 65900e144b
	it("sends a slash, a space, a non-ASCII rune and a question mark escaped, the path filled in path order", async () => {
		const { hops, run } = await drive([FOUND], [user({ org: "a/b c", "user-id": "ü?1" })])
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({ observed: [DATA], status: 0 })
		expect(hops.map((h) => `${h.method} ${h.url}`)).toEqual(["GET /orgs/a%2Fb%20c/users/%C3%BC%3F1"])
	}, 600_000)

	// v0: f5710a9129
	it("refuses an empty, a dot and a dot-dot value as *sdk.PathParamError, nothing sent; a value holding them is escaped", async () => {
		const values = ["", ".", "..", "../x"]
		const calls = values.map((value) => user({ org: "ok", "user-id": value }))
		const { hops, run } = await drive([FOUND], calls, { script: {} })
		expect({
			errors: run.trace?.calls.map((c) => c.error),
			hops: hops.map((h) => h.url),
			observed: run.observed,
		}).toEqual({
			errors: [refused(""), refused("."), refused(".."), undefined],
			hops: ["/orgs/ok/users/..%2Fx"],
			observed: [null, null, null, DATA],
		})
	}, 600_000)
})

goDescribe("the base URL: its path is kept, a trailing slash never doubled", () => {
	// v0: 653b3aaa22
	it("prefixes every request with the base path, with or without a trailing slash", async () => {
		const call = user({ org: "o", "user-id": "u" })
		const runs = await Promise.all(
			[(url: string) => `${url}/api`, (url: string) => `${url}/api/`].map((base) => drive([FOUND], [call], { base })),
		)
		expect(runs.map(({ hops, run }) => ({ hops: hops.map((h) => h.url), observed: run.observed }))).toEqual([
			{ hops: ["/api/orgs/o/users/u"], observed: [DATA] },
			{ hops: ["/api/orgs/o/users/u"], observed: [DATA] },
		])
	}, 600_000)
})

goDescribe("query params: arrays repeated, nullable and bracketed names sent, nothing set sends no query", () => {
	// v0: a1c45da195
	it("sends ids once per item, page[size] escaped, maybe as given, and no '?' without a value", async () => {
		const at = { org: "o", "user-id": "u" }
		const calls = [
			user(at, { search: { ids: ["a", "b"], "page[size]": 5 } }),
			user(at, { search: { maybe: "m" } }),
			user(at),
		]
		const { hops, run } = await drive([FOUND, FOUND, FOUND], calls)
		expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
			hops: ["/orgs/o/users/u?ids=a&ids=b&page%5Bsize%5D=5", "/orgs/o/users/u?maybe=m", "/orgs/o/users/u"],
			observed: [DATA, DATA, DATA],
		})
	}, 600_000)

	// v0: a1c45da195
	it("types the Opts fields by the nilable rule: Ids []string, Maybe *string, PageSize *int64", () => {
		const body = `
	m, n := "m", int64(3)
	must(client("http://api.test").Users.Get(ctx, "o", "u", &sdk.UsersGetOpts{Ids: []string{"a", "b"}, Maybe: &m, PageSize: &n}))
	must(client("http://api.test").Users.Get(ctx, "o", "u", &sdk.UsersGetOpts{}))
`
		const run = check(reqFiles(), MODULE, body)
		expect(seen(run), run.stderr).toEqual({
			built: true,
			out: [
				"GET http://api.test/orgs/o/users/u?ids=a&ids=b&maybe=m&page%5Bsize%5D=3",
				"GET http://api.test/orgs/o/users/u",
			],
			vet: [],
		})
	}, 600_000)
})

goDescribe("X-Request-Id: a fresh UUIDv4 per request unless the config or the call sets one", () => {
	// v0: 82afb66486
	it("sends two distinct UUIDv4s then the call's own; a config value, then a call value over it", async () => {
		const own = (value: string): Call => ({ ...PING, headers: { "x-request-id": value } })
		const fresh = await drive([FOUND, FOUND, FOUND], [PING, PING, own("call-1")])
		const configured = await drive([FOUND, FOUND], [PING, own("call-2")], {
			setup: { headers: { "X-Request-Id": "cfg-1" } },
		})
		const ids = fresh.hops.map((h) => h.headers["x-request-id"])
		expect({
			configured: configured.hops.map((h) => h.headers["x-request-id"]),
			fresh: ids,
			observed: [fresh.run.observed, configured.run.observed],
		}).toEqual({
			configured: ["cfg-1", "call-2"],
			fresh: [expect.stringMatching(UUID_V4), expect.stringMatching(UUID_V4), "call-1"],
			observed: [
				[DATA, DATA, DATA],
				[DATA, DATA],
			],
		})
		expect(ids[0]).not.toBe(ids[1])
	}, 600_000)
})

goDescribe("request bodies: each declared media type sent as its encoding", () => {
	// v0: bde752863b
	it("sends an urlencoded body from url.Values with its content type", async () => {
		const submit: Call = {
			body: { kind: "json", value: { name: ["form-value"] } },
			operation: "forms.submit",
			route: { method: "POST", path: "/form" },
		}
		const { bodies, hops, run } = await drive([FOUND], [submit])
		expect({ observed: run.observed, status: run.status }, run.stderr).toEqual({ observed: [DATA], status: 0 })
		expect({ bodies: bodies.map(String), sent: hops.map((h) => h.body) }).toEqual({
			bodies: ["name=form-value"],
			sent: [{ contentType: "application/x-www-form-urlencoded", sha256: sha256("name=form-value"), size: 15 }],
		})
	}, 600_000)

	// v0: a3274f7f33
	it("sends a multipart body: a text part, one part per array item, a file part, and no file part without Data", async () => {
		const body = `
	api := sdk.NewClient(sdk.Config{BaseURL: input.Base})
	n := "multipart-value"
	file := sdk.FilePart{Filename: "a.txt", ContentType: "text/plain", Data: strings.NewReader("hello")}
	_, err := api.Files.Upload(ctx, sdk.FilesUploadBody{Name: &n, Tags: []string{"a", "b"}, File: file}, nil)
	note("with file:", err)
	_, err = api.Files.Upload(ctx, sdk.FilesUploadBody{Name: &n}, nil)
	note("without:", err)
`
		const { bodies, hops, run } = await served([], async (server) => {
			const ran = await checkServed(reqFiles(), MODULE, body, server.url)
			return { bodies: [...server.bodies], hops: [...server.hops], run: ran }
		})
		expect(seen(run), run.stderr).toEqual({ built: true, out: ["with file: <nil>", "without: <nil>"], vet: [] })
		const types = hops.map((h) => h.body.contentType ?? "")
		expect(hops.map((h) => `${h.method} ${h.url}`)).toEqual(["POST /upload", "POST /upload"])
		expect(types).toEqual([
			expect.stringMatching(/^multipart\/form-data; boundary=/),
			expect.stringMatching(/^multipart\/form-data; boundary=/),
		])
		expect(await Promise.all(bodies.map((sent, i) => parts(sent, types[i] as string)))).toEqual([
			{ file: { name: "a.txt", text: "hello", type: "text/plain" }, name: ["multipart-value"], tags: ["a", "b"] },
			{ file: null, name: ["multipart-value"], tags: [] },
		])
	}, 600_000)
})

/** A multipart upload of a file list beside an integer, an object and a boolean-list text part. */
const MULTI: Json = {
	info: { title: "Multi", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/batch": {
			post: {
				operationId: "files.batch",
				requestBody: {
					...content(
						"multipart/form-data",
						OBJECT({
							count: { type: "integer" },
							files: { items: { format: "binary", type: "string" }, type: "array" },
							flags: { items: { type: "boolean" }, type: "array" },
							meta: OBJECT({ k: { type: "integer" } }),
						}),
					),
					required: true,
				},
				responses: OK,
			},
		},
	},
}

goDescribe("multipart parts: Go types by schema, a file list sent per item with Data", () => {
	it("types files []FilePart, an integer *int64, a boolean list []bool and an object *string, and sends each set one", async () => {
		const body = `
	api := sdk.NewClient(sdk.Config{BaseURL: input.Base})
	n, m := int64(3), \`{"k":1}\`
	files := []sdk.FilePart{{Filename: "a.txt", ContentType: "text/plain", Data: strings.NewReader("A")}, {Filename: "skipped"}, {Filename: "b.bin", Data: strings.NewReader("B")}}
	upload := sdk.FilesBatchBody{Count: &n, Files: files, Flags: []bool{true, false}, Meta: &m}
	note(fmt.Sprintf("%T %T %T %T", upload.Count, upload.Files, upload.Flags, upload.Meta))
	_, err := api.Files.Batch(ctx, upload, nil)
	note("sent:", err)
`
		const multi = "example.com/multi"
		const { bodies, hops, run } = await served([], async (server) => {
			const ran = await checkServed(generateGoSdk(MULTI, { modulePath: multi }).files, multi, body, server.url)
			return { bodies: [...server.bodies], hops: [...server.hops], run: ran }
		})
		expect(seen(run), run.stderr).toEqual({
			built: true,
			out: ["*int64 []sdk.FilePart []bool *string", "sent: <nil>"],
			vet: [],
		})
		const form = await new Response(new Uint8Array(bodies[0] as Buffer), {
			headers: { "content-type": hops[0]?.body.contentType ?? "" },
		}).formData()
		const files = await Promise.all(
			form
				.getAll("files")
				.map(async (file) => (file instanceof File ? [file.name, file.type, await file.text()] : file)),
		)
		expect({ count: form.getAll("count"), files, flags: form.getAll("flags"), meta: form.getAll("meta") }).toEqual({
			count: ["3"],
			files: [
				["a.txt", "text/plain", "A"],
				["b.bin", "application/octet-stream", "B"],
			],
			flags: ["true", "false"],
			meta: ['{"k":1}'],
		})
	}, 600_000)
})

/** A multipart request body as a server's form parser reads it: the name and tags parts and the file part. */
async function parts(body: Buffer, contentType: string) {
	const form = await new Response(new Uint8Array(body), { headers: { "content-type": contentType } }).formData()
	const file = form.get("file")
	return {
		file: file instanceof File ? { name: file.name, text: await file.text(), type: file.type } : file,
		name: form.getAll("name"),
		tags: form.getAll("tags"),
	}
}

goDescribe("Idempotency-Key: an idempotent operation always sends one, stable across an auth retry", () => {
	it("sends a fresh UUIDv4, then Opts.IdempotencyKey, a per-call header over it, the same key on a retry, none on a plain op", async () => {
		const script: Script = {
			calls: [null, { idempotencyKey: "opt-k" }, { idempotencyKey: "opt-k2" }],
			onAuthExpired: { tokens: ["new"] },
		}
		const created: Reply = { json: { id: "o1" }, status: 201 }
		const calls = [ORDER, ORDER, { ...ORDER, headers: { "Idempotency-Key": "call-k" } }, ORDER, PING]
		const setup: Setup = { auth: { kind: "bearer", token: "old" } }
		const replies = [{ status: 401 }, created, created, created, created, FOUND]
		const { hops, run } = await drive(replies, calls, { script, setup })
		const keys = hops.map((h) => h.headers["idempotency-key"])
		const order = { data: { id: "o1" }, kind: "data", status: 201 }
		expect(
			{
				auth: hops.map((h) => h.headers.authorization),
				expired: run.trace?.authExpired,
				keys,
				observed: run.observed,
			},
			run.stderr,
		).toEqual({
			auth: ["Bearer old", "Bearer new", "Bearer new", "Bearer new", "Bearer new", "Bearer new"],
			expired: 1,
			keys: [expect.stringMatching(UUID_V4), keys[0], "opt-k", "call-k", expect.stringMatching(UUID_V4), undefined],
			observed: [order, order, order, order, DATA],
		})
		expect(keys[4]).not.toBe(keys[0])
	}, 600_000)
})
