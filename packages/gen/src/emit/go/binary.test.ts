import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { compiledSdk, type DrivenSdk, type Script } from "./__fixtures__/compiled.ts"
import { check, once, seen } from "./__fixtures__/consumer.ts"
import { withGo } from "./__fixtures__/go-env.ts"
import { type RecordedHop, type Reply, served } from "./__fixtures__/recording-server.ts"
import { generateGoSdk } from "./sdk.ts"

/** Whether Go is here: a missing one fails where it is required and skips the Go tests elsewhere (go-env). */
const GO = withGo()
const goDescribe = describe.skipIf(!GO)

type Json = Record<string, unknown>

const STRING = { type: "string" }
const BINARY = { format: "binary", type: "string" }
const path = (name: string) => ({ in: "path", name, required: true, schema: STRING })
const media = (type: string, schema: Json = BINARY) => ({ content: { [type]: { schema } } })
const json = (schema: Json) => media("application/json", schema)
const SIZE = { properties: { size: { type: "integer" } }, required: ["size"], type: "object" }

/** Doc BIN: binary and pdf downloads, a binary upload, a text round trip, and a read declaring response headers. */
const BIN: Json = {
	info: { title: "Binary", version: "1" },
	openapi: "3.1.0",
	paths: {
		"/docs/{name}": {
			get: {
				operationId: "docs.get",
				parameters: [path("name")],
				responses: { 200: { ...media("application/pdf"), description: "ok" } },
			},
		},
		"/files/{name}": {
			get: {
				operationId: "files.get",
				parameters: [path("name")],
				responses: { 200: { ...media("application/octet-stream"), description: "ok" } },
			},
			put: {
				operationId: "files.put",
				parameters: [path("name")],
				requestBody: { ...media("application/octet-stream"), required: true },
				responses: { 200: { ...json(SIZE), description: "ok" } },
			},
		},
		"/items/{id}": {
			get: {
				operationId: "items.get",
				parameters: [path("id")],
				responses: {
					200: {
						...json({ properties: { id: STRING }, required: ["id"], type: "object" }),
						description: "ok",
						headers: {
							"X-Etag": { schema: STRING },
							"X-Item-Version": { required: true, schema: { type: "integer" } },
						},
					},
					404: { description: "missing" },
				},
			},
		},
		"/notes": {
			post: {
				operationId: "notes.create",
				requestBody: { ...media("text/plain", STRING), required: true },
				responses: { 200: { ...media("text/plain", STRING), description: "ok" } },
			},
		},
	},
}
const MODULE = "example.com/binary"

const route = (method: string, at: string) => ({ method, path: at })
const FILES_GET: Call = { operation: "files.get", params: { name: "x" }, route: route("GET", "/files/{name}") }
const DOCS_GET: Call = { operation: "docs.get", params: { name: "d" }, route: route("GET", "/docs/{name}") }
const ITEMS_GET: Call = { operation: "items.get", params: { id: "i1" }, route: route("GET", "/items/{id}") }
const NOTE = (text: string): Call => ({
	body: { kind: "json", value: text },
	operation: "notes.create",
	route: route("POST", "/notes"),
})
const PUT = (size: number): Call => ({
	body: { contentType: "application/octet-stream", kind: "binary", size },
	operation: "files.put",
	params: { name: "x" },
	route: route("PUT", "/files/{name}"),
})

/* both error modes: a binary or text answer has the same shape in Data as in the return value */
const MODES = [
	["throw", true],
	["safe", false],
] as const

/** `size` bytes `i & 0xff`, as the driver sends and the recording server answers them. */
const pattern = (size: number) => Buffer.from(Array.from({ length: size }, (_, i) => i & 0xff))
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

const sdks = new Map<boolean, DrivenSdk>()

/** The SDK for BIN in the given error mode, compiled with the driver once; it must build and vet clean. */
function binSdk(throwOnError: boolean): DrivenSdk {
	const sdk = sdks.get(throwOnError) ?? compiledSdk(BIN, { modulePath: MODULE, throwOnError })
	sdks.set(throwOnError, sdk)
	expect({ built: sdk.built, vet: sdk.vet }, sdk.stderr).toEqual({ built: true, vet: [] })
	return sdk
}

/** `calls` run by `sdk` on one client (under `script` when given) against a server answering `replies`. */
async function drive(sdk: DrivenSdk, replies: readonly Reply[], calls: readonly Call[], script?: Script) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, server, script)
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}

/** A consumer of BIN's throw-mode SDK running `body`. */
const consumerOf = (body: string) => once(() => check(generateGoSdk(BIN, { modulePath: MODULE }).files, MODULE, body))

const octets = (size: number, type: string): Reply => ({ bytes: size, headers: { "content-type": type }, status: 200 })

goDescribe("binary responses: []byte, never JSON-decoded, Accept the declared media type", () => {
	// v0: 63ad606050
	it.each(MODES)(
		"answers an octet-stream or pdf body as its bytes and asks for that media type (%s)",
		async (_, mode) => {
			const replies = [octets(256, "application/octet-stream"), octets(4, "application/pdf")]
			const { hops, run } = await drive(binSdk(mode), replies, [FILES_GET, DOCS_GET])
			expect({ accept: hops.map((h) => [h.url, h.headers.accept]), observed: run.observed }, run.stderr).toEqual({
				accept: [
					["/files/x", "application/octet-stream"],
					["/docs/d", "application/pdf"],
				],
				observed: [
					{ kind: "bytes", sha256: sha256(pattern(256)), size: 256, status: 200 },
					{ kind: "bytes", sha256: sha256(pattern(4)), size: 4, status: 200 },
				],
			})
		},
		600_000,
	)

	it("a per-call Accept header wins over the declared media type", async () => {
		const call = { ...FILES_GET, headers: { accept: "*/*" } }
		const { hops, run } = await drive(binSdk(true), [octets(3, "application/octet-stream")], [call])
		expect({ accept: hops.map((h) => h.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["*/*"],
			observed: [{ kind: "bytes", sha256: sha256(pattern(3)), size: 3, status: 200 }],
		})
	}, 600_000)

	const answers =
		consumerOf(`	replies["GET /files/x"] = reply{status: 200, body: "\\x00\\x01\\xff", headers: map[string]string{"Content-Type": "application/octet-stream"}}
	replies["POST /notes"] = reply{status: 200, body: "hello", headers: map[string]string{"Content-Type": "text/plain"}}
	api := client("http://api.test")
	var b []byte
	var err error
	b, err = api.Files.Get(ctx, "x", nil)
	note(fmt.Sprintf("%T %v %v", b, b, err))
	var s string
	s, err = api.Notes.Create(ctx, "hi", nil)
	note(fmt.Sprintf("%T %q %v", s, s, err))`)

	it("returns ([]byte, error) for a binary answer and (string, error) for a text one, no pointer (F1)", () => {
		const run = answers()
		expect(seen(run), run.stderr).toEqual({
			built: true,
			out: [
				"GET http://api.test/files/x",
				"[]uint8 [0 1 255] <nil>",
				"POST http://api.test/notes hi",
				'string "hello" <nil>',
			],
			vet: [],
		})
	}, 600_000)
})

/** An upload hop as the io.Reader leg pins it: where it went, its media type, its framing and its bytes. */
const uploadOf = (h: RecordedHop) => ({
	contentType: h.body.contentType,
	length: h.headers["content-length"],
	method: h.method,
	sha256: h.body.sha256,
	size: h.body.size,
	transferEncoding: h.headers["transfer-encoding"],
	url: h.url,
})
const UPLOADED = { contentType: "application/octet-stream", method: "PUT", url: "/files/x" }

goDescribe("non-JSON request bodies and text answers", () => {
	it.each(MODES)(
		"streams an io.Reader body under its declared media type, sized or one-shot (%s)",
		async (_, mode) => {
			const size = 65_536
			const done: Reply = { json: { size }, status: 200 }
			const script: Script = { calls: [null, { oneShotBody: true }] }
			const { bodies, hops, run } = await drive(binSdk(mode), [done, done], [PUT(size), PUT(size)], script)
			const sent = { ...UPLOADED, sha256: sha256(pattern(size)), size }
			const wire = hops.map(uploadOf)
			expect({ observed: run.observed, same: bodies.map((b) => b.equals(pattern(size))), wire }, run.stderr).toEqual({
				observed: [
					{ data: { size }, kind: "data", status: 200 },
					{ data: { size }, kind: "data", status: 200 },
				],
				same: [true, true],
				wire: [
					{ ...sent, length: String(size), transferEncoding: undefined },
					{ ...sent, length: undefined, transferEncoding: "chunked" },
				],
			})
		},
		600_000,
	)

	it.each(MODES)(
		"sends a string body as text/plain and answers text as the string sent, never JSON-decoded (%s)",
		async (_, mode) => {
			const replies: Reply[] = [
				{ headers: { "content-type": "text/plain" }, status: 200, text: "hello" },
				{ headers: { "content-type": "text/plain" }, status: 200, text: '"quoted"' },
			]
			const { bodies, hops, run } = await drive(binSdk(mode), replies, [NOTE("hello"), NOTE("bye")])
			const wire = hops.map((h) => [h.method, h.url, h.body.contentType, h.headers.accept, h.body.size])
			expect({ bodies: bodies.map(String), observed: run.observed, wire }, run.stderr).toEqual({
				bodies: ["hello", "bye"],
				observed: [
					{ data: "hello", kind: "data", status: 200 },
					{ data: '"quoted"', kind: "data", status: 200 },
				],
				wire: [
					["POST", "/notes", "text/plain", "text/plain", 5],
					["POST", "/notes", "text/plain", "text/plain", 3],
				],
			})
		},
		600_000,
	)
})

/** An item read's 200 carrying `headers`. */
const item = (headers: Record<string, string>): Reply => ({ headers, json: { id: "i1" }, status: 200 })

goDescribe("typed response headers (<Op>Headers through WithHeadersInto)", () => {
	it.each(MODES)(
		"fills the declared headers only, a missing optional one left out (%s)",
		async (_, mode) => {
			const replies = [
				item({ "x-etag": "e1", "x-item-version": "3", "x-undeclared": "u" }),
				item({ "x-item-version": "3" }),
			]
			const { run } = await drive(binSdk(mode), replies, [ITEMS_GET, ITEMS_GET])
			expect(run.observed, run.stderr).toEqual([
				{ data: { id: "i1" }, headers: { "x-etag": "e1", "x-item-version": "3" }, kind: "data", status: 200 },
				{ data: { id: "i1" }, headers: { "x-item-version": "3" }, kind: "data", status: 200 },
			])
		},
		600_000,
	)

	const typed =
		consumerOf(`	replies["GET /items/i1"] = reply{status: 200, body: \`{"id":"i1"}\`, headers: map[string]string{"X-Item-Version": "3", "X-Etag": "e1", "X-Undeclared": "u"}}
	replies["GET /items/gone"] = reply{status: 404, body: \`{"message":"no"}\`}
	api := client("http://api.test")
	var h sdk.ItemsGetHeaders
	must(api.Items.Get(ctx, "i1", nil, sdk.WithHeadersInto(&h)))
	etag := "<nil>"
	if h.XEtag != nil {
		etag = *h.XEtag
	}
	note(fmt.Sprintf("%T %d %T %s", h.XItemVersion, h.XItemVersion, h.XEtag, etag))
	var miss sdk.ItemsGetHeaders
	_, err := api.Items.Get(ctx, "gone", nil, sdk.WithHeadersInto(&miss))
	note(err != nil, miss.XItemVersion, miss.XEtag == nil)`)

	it("types a required header as its Go type and an optional one as a pointer; an error status fills nothing", () => {
		const run = typed()
		expect(seen(run), run.stderr).toEqual({
			built: true,
			out: ["GET http://api.test/items/i1", "int64 3 *string e1", "GET http://api.test/items/gone", "true 0 true"],
			vet: [],
		})
	}, 600_000)
})
