/**
 * Past JSON (contract 29 §5.10; G4/G5, Fc5, Fc6): a binary answer is its `bytes`, asked for under its declared
 * media type, which a per-call `Accept` overrides and a config one never does, and never decoded as text or JSON;
 * a text answer is a `str` as sent. A binary body goes out under its declared type, sized when it is bytes and
 * chunked when it is an iterable, and only bytes are sent again on a 401; a multipart file is a `FilePart` held in
 * memory and sent again too, and an empty map is no part. Declared response headers fill `headers_into` typed,
 * and a missing required one is a `DecodeError`. Driven in both error modes on `http` and `http-safe`, every leg
 * on `AsyncSDK` and `SDK` with one expectation (the G17 drift check); the answer types and multipart bodies are
 * consumer programs, the types mypy checks.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { PythonError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, once, seen } from "./__fixtures__/consumer.ts"
import { type DrivenPythonSdk, drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }
const CLIENTS = ["async", "sync"] as const

type Key = "http" | "http-safe"
type On = { readonly client: Client; readonly key: Key }
type Client = (typeof CLIENTS)[number]

/* both error modes on both clients: a binary or text answer has the same shape in SDKResult.data as returned */
const GRID = CLIENTS.flatMap((client) =>
	(
		[
			["throw", "http"],
			["safe", "http-safe"],
		] as const
	).map(([mode, key]) => [mode, client, key] as const),
)

const route = (method: string, path: string) => ({ method, path })
const FILES_GET: Call = { operation: "files.get", params: { name: "x" }, route: route("GET", "/files/{name}") }
const DOCS_GET: Call = { operation: "docs.get", params: { name: "d" }, route: route("GET", "/docs/{name}") }
const ITEMS_GET: Call = { operation: "items.get", params: { id: "i1" }, route: route("GET", "/items/{id}") }
const TEXT_GET: Call = { operation: "text.get", route: route("GET", "/text") }
const OK: Reply = { json: { ok: true }, status: 200 }
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

/** `size` bytes `i & 0xff`, as the driver sends and the recording server answers them. */
const pattern = (size: number) => Buffer.from(Array.from({ length: size }, (_, i) => i & 0xff))
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

/** A Python error as the trace records it: no cause and the method's own raise unless given, any repr. */
const plain = (entry: Partial<PythonError>) => ({ cause: null, repr: expect.any(String), via: "return", ...entry })
const decodeError = (text: string) => plain({ chain: ["DecodeError", "HoneyError"], text, type: "DecodeError" })

/** The registry SDK `key` with the driver aimed at it, which must import. */
function driven(key: Key): DrivenPythonSdk {
	const sdk = drivenPythonSdk(key)
	expect(sdk.imported, sdk.stderr).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run by `key`'s driver on `client` under `o` against a server answering `replies`, with what it got. */
async function drive({ client, key }: On, replies: readonly Reply[], calls: readonly Call[], o: Options = {}) {
	const sdk = driven(key)
	return served(replies, async (server) => {
		const cell = { calls, setup: o.setup ?? {} }
		const run = await sdk.runCalls(cell, { alt: server.alt, url: server.url }, { client, script: o.script })
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}

const octets = (size: number, type: string): Reply => ({ bytes: size, headers: { "content-type": type }, status: 200 })
const bytesOf = (size: number) => ({ kind: "bytes", sha256: sha256(pattern(size)), size, status: 200 })

describe.skipIf(!PY)("binary answers: bytes, never decoded, Accept the declared media type", SLOW, () => {
	/* V0BUG: v0 sent no Accept on a binary op; v1 sends the declared media type (G4) */
	// v0: a575ad3ad9
	// v0: 63ad606050
	it.each(GRID)(
		"answers an octet-stream or pdf body as its bytes and asks for that media type (%s, %s)",
		async (_, client, key) => {
			const replies = [octets(256, "application/octet-stream"), octets(4, "application/pdf")]
			const { hops, run } = await drive({ client, key }, replies, [FILES_GET, DOCS_GET])
			expect({ accept: hops.map((h) => [h.url, h.headers.accept]), observed: run.observed }, run.stderr).toEqual({
				accept: [
					["/files/x", "application/octet-stream"],
					["/docs/d", "application/pdf"],
				],
				observed: [bytesOf(256), bytesOf(4)],
			})
		},
	)

	it.each(CLIENTS)("%s: lets a per-call Accept (options['headers']) win over the declared media type", async (c) => {
		const call = { ...FILES_GET, headers: { accept: "*/*" } }
		const { hops, run } = await drive({ client: c, key: "http" }, [octets(3, "application/octet-stream")], [call])
		expect({ accept: hops.map((h) => h.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["*/*"],
			observed: [bytesOf(3)],
		})
	})

	it.each(CLIENTS)("%s: keeps the declared media type over a ClientConfig.headers Accept", async (c) => {
		const setup: Setup = { headers: { Accept: "application/json" } }
		const { hops, run } = await drive(
			{ client: c, key: "http" },
			[octets(3, "application/octet-stream")],
			[FILES_GET],
			{ setup },
		)
		expect({ accept: hops.map((h) => h.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["application/octet-stream"],
			observed: [bytesOf(3)],
		})
	})
})

/** A 200 text/plain answer of `body`. */
const text = (body: string): Reply => ({ headers: { "content-type": "text/plain" }, status: 200, text: body })

describe.skipIf(!PY)("text bodies and answers: a str as sent, never JSON-decoded", SLOW, () => {
	// v0: 63ad606050
	it.each(GRID)(
		"answers text/plain as the string, sends a str body as text/plain and asks for text/plain (%s, %s)",
		async (_, client, key) => {
			const replies = [text('{"a":1}'), text("hello"), text('"quoted"')]
			const { bodies, hops, run } = await drive({ client, key }, replies, [TEXT_GET, NOTE("hello"), NOTE("bye")])
			const wire = hops.map((h) => [h.method, h.url, h.body.contentType, h.headers.accept, h.body.size])
			expect({ bodies: bodies.map(String), observed: run.observed, wire }, run.stderr).toEqual({
				bodies: ["", "hello", "bye"],
				observed: [
					{ data: '{"a":1}', kind: "data", status: 200 },
					{ data: "hello", kind: "data", status: 200 },
					{ data: '"quoted"', kind: "data", status: 200 },
				],
				wire: [
					["GET", "/text", null, "text/plain", 0],
					["POST", "/notes", "text/plain", "text/plain", 5],
					["POST", "/notes", "text/plain", "text/plain", 3],
				],
			})
		},
	)
})

/** An upload hop: where it went, its media type, its framing, its token and its bytes. */
const uploadOf = (h: RecordedHop) => ({
	authorization: h.headers.authorization,
	contentType: h.body.contentType,
	length: h.headers["content-length"],
	method: h.method,
	sha256: h.body.sha256,
	size: h.body.size,
	transferEncoding: h.headers["transfer-encoding"],
	url: h.url,
})
const UPLOADED = { contentType: "application/octet-stream", method: "PUT", url: "/files/x" }

describe.skipIf(!PY)("binary request bodies: bytes (sized) or an iterable (chunked), only bytes resent", SLOW, () => {
	it.each(GRID)(
		"sends bytes with their length and a one-shot iterable chunked, under the declared media type (%s, %s)",
		async (_, client, key) => {
			const size = 65_536
			const done: Reply = { json: { size }, status: 200 }
			const script: Script = { calls: [null, { oneShotBody: true }] }
			const { bodies, hops, run } = await drive({ client, key }, [done, done], [PUT(size), PUT(size)], { script })
			const sent = { ...UPLOADED, authorization: undefined, sha256: sha256(pattern(size)), size }
			expect(
				{ observed: run.observed, same: bodies.map((b) => b.equals(pattern(size))), wire: hops.map(uploadOf) },
				run.stderr,
			).toEqual({
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
	)

	it.each(GRID)(
		"sends bytes again with on_auth_expired's token after a 401; a one-shot iterable's 401 is the answer (%s, %s)",
		async (_, client, key) => {
			const size = 4096
			const script: Script = { calls: [null, { oneShotBody: true }], onAuthExpired: { tokens: ["new"] } }
			const setup: Setup = { auth: { kind: "bearer", token: "old" } }
			const replies: Reply[] = [{ status: 401 }, { json: { size }, status: 200 }, { status: 401 }]
			const { bodies, hops, run } = await drive({ client, key }, replies, [PUT(size), PUT(size)], { script, setup })
			const sent = { ...UPLOADED, sha256: sha256(pattern(size)), size }
			const sized = { ...sent, length: String(size), transferEncoding: undefined }
			expect(
				{
					expired: run.trace?.authExpired,
					observed: run.observed,
					same: bodies.map((b) => b.equals(pattern(size))),
					wire: hops.map(uploadOf),
				},
				run.stderr,
			).toEqual({
				expired: 1,
				observed: [
					{ data: { size }, kind: "data", status: 200 },
					{ errorKey: null, kind: "error", status: 401 },
				],
				same: [true, true, true],
				wire: [
					{ ...sized, authorization: "Bearer old" },
					{ ...sized, authorization: "Bearer new" },
					{ ...sent, authorization: "Bearer new", length: undefined, transferEncoding: "chunked" },
				],
			})
		},
	)
})

/** An item read's 200 carrying `headers`. */
const item = (headers: Record<string, string>): Reply => ({ headers, json: { id: "i1", name: "n" }, status: 200 })

describe.skipIf(!PY)("typed response headers: headers_into fills <Op>Headers (G5)", SLOW, () => {
	it.each(GRID)(
		"fills the declared headers only, an absent optional one left out; a missing or unparsable required one is a DecodeError (%s, %s)",
		async (_, client, key) => {
			const replies = [
				item({ "x-etag": "e1", "x-item-version": "3", "x-undeclared": "u" }),
				item({ "x-item-version": "3" }),
				item({ "x-etag": "e1" }),
				item({ "x-item-version": "x" }),
			]
			const calls = [ITEMS_GET, ITEMS_GET, ITEMS_GET, ITEMS_GET]
			const { run } = await drive({ client, key }, replies, calls, { script: {} })
			const data = { id: "i1", name: "n" }
			expect({ errors: run.trace?.calls.map((c) => c.error), observed: run.observed }, run.stderr).toEqual({
				errors: [
					undefined,
					undefined,
					decodeError("the X-Item-Version header is missing"),
					decodeError("the X-Item-Version header is not a valid integer"),
				],
				observed: [
					{ data, headers: { "x-etag": "e1", "x-item-version": "3" }, kind: "data", status: 200 },
					{ data, headers: { "x-item-version": "3" }, kind: "data", status: 200 },
					{ kind: "decode", status: 200 },
					{ kind: "decode", status: 200 },
				],
			})
		},
	)
})

/** A throw-mode consumer per client: the type, length and edge bytes of a binary answer, and a text answer. */
const ANSWERS = CLIENTS.map((client) => {
	const [make, call] = client === "sync" ? ["client()", ""] : ["aclient()", "await "]
	return `section("${client}")
c = ${make}
b = ${call}c.files.get("x")
s = ${call}c.notes.create("hi")
note([type(b).__name__, len(b), list(b[:2]), list(b[-2:]), type(s).__name__, s])`
}).join("\n")

/** The `answers` program run once on both clients, with what each hop asked for. */
const answers = once(() => {
	const replies: Reply[] = [octets(256, "application/octet-stream"), { status: 200, text: "hello" }]
	return served([...replies, ...replies], async (server) => {
		const run = await consume("http", "answers", { base: server.url, body: ANSWERS })
		return { hops: server.hops.map((h) => `${h.method} ${h.url} ${h.headers.accept}`), run }
	})
})

describe.skipIf(!PY)("the answer types a method returns (G4, G5)", SLOW, () => {
	it("returns a binary answer as bytes with every byte (none decoded) and a text one as str", async () => {
		const { hops, run } = await answers()
		const row = JSON.stringify(["bytes", 256, [0, 1], [254, 255], "str", "hello"])
		const read = (section: string) => ({
			...seen(run, section),
			out: seen(run, section).out?.map((n) => JSON.parse(n)),
		})
		const sent = ["GET /files/x application/octet-stream", "POST /notes text/plain"]
		expect({ async: read("async"), hops, sync: read("sync") }, run.stderr).toEqual({
			async: { out: [JSON.parse(row)], ran: true },
			hops: [...sent, ...sent],
			sync: { out: [JSON.parse(row)], ran: true },
		})
	})
})

/** mypy's findings for `lines` (one program) against `http`, each as `<line>: <message>`. */
const findings = (lines: readonly string[]) =>
	checked("http", `${lines.join("\n")}\n`).map((line) => line.replace(/^[^:]+:(\d+): error: /, "$1: "))

/** The finding mypy gives at `text`'s line of `lines`. */
const at = (lines: readonly string[], line: string, message: string) => `${lines.indexOf(line) + 1}: ${message}`

const HEADERS_INTO = [
	"from typing import assert_type",
	"",
	"import honey_sdk as sdk",
	"",
	"c = sdk.SDK()",
	"h: sdk.ItemsGetHeaders = {}",
	'c.items.get("i", headers_into=h)',
	'assert_type(h["x_item_version"], int)',
	'assert_type(h["x_etag"], str)',
	'assert_type(c.files.get("x"), bytes)',
	'assert_type(c.notes.create("hi"), str)',
	"c.echo.get(headers_into={})",
	"",
	"",
	"async def run(a: sdk.AsyncSDK) -> None:",
	'    await a.items.get("i", headers_into=h)',
	'    assert_type(await a.files.get("x"), bytes)',
	"    await a.echo.get(headers_into={})",
]

/** mypy's refusal of `headers_into` on `resource`'s `get`. */
const refused = (resource: string) =>
	`Unexpected keyword argument "headers_into" for "get" of "${resource}"  [call-arg]`

describe.skipIf(!PY)("headers_into: typed <Op>Headers, only on an op declaring 2xx headers (G5)", SLOW, () => {
	it("types each declared header by its schema, and refuses headers_into on an op declaring none", () => {
		expect(findings(HEADERS_INTO)).toEqual([
			at(HEADERS_INTO, "c.echo.get(headers_into={})", refused("EchoResource")),
			at(HEADERS_INTO, "    await a.echo.get(headers_into={})", refused("AsyncEchoResource")),
		])
	})
})

/** One multipart body's parts by name, as a server's form parser reads them: a file as its name, type and text. */
async function partsOf(body: Buffer, type: string): Promise<Record<string, unknown[]>> {
	const form = await new Response(new Uint8Array(body), { headers: { "content-type": type } }).formData()
	const parts: Record<string, unknown[]> = {}
	for (const [name, value] of form.entries()) {
		const part = typeof value === "string" ? value : { name: value.name, text: await value.text(), type: value.type }
		;(parts[name] ??= []).push(part)
	}
	return parts
}

/** Per client: an upload of a FilePart on a client whose `old` token a refresh replaces, then a batch. */
const MULTIPART = CLIENTS.map((client) => {
	const [make, call] = client === "sync" ? ["client", ""] : ["aclient", "await "]
	return `section("${client}")
file = sdk.FilePart("a.txt", b"file-bytes", "text/plain")
c = ${make}(bearer_token="old", on_auth_expired=lambda: "fresh")
r = ${call}c.files.upload({"file": file, "name": "multipart-value", "tags": ["a", "b"]})
files = [sdk.FilePart("a.txt", b"A", "text/plain"), sdk.FilePart("b.bin", b"B")]
b = ${call}${make}().files.batch({"count": 3, "files": files, "flags": [True, False], "meta": {"k": 1}})
note([r, b, file.content_type, files[1].content_type])`
}).join("\n")

/** Per client: an upload with no fields, and a batch whose only field is an empty map. */
const EMPTY = CLIENTS.map((client) => {
	const [make, call] = client === "sync" ? ["client()", ""] : ["aclient()", "await "]
	return `section("${client}")
c = ${make}
note([${call}c.files.upload({}), ${call}c.files.batch({"meta": {}})])`
}).join("\n")

/** `program` (named `name`) run on `http` against `replies`, with each hop's line, content type and body. */
const sent = (name: string, program: string, replies: readonly Reply[]) =>
	served(replies, async (server) => {
		const run = await consume("http", name, { base: server.url, body: program })
		const hops = server.hops.map((h, i) => ({
			at: `${h.method} ${h.url} ${h.headers.authorization}`,
			body: server.bodies[i] ?? Buffer.alloc(0),
			type: h.headers["content-type"] ?? "",
		}))
		return { hops, run }
	})

const multipart = once(() => {
	const replies: Reply[] = [{ status: 401 }, OK, OK]
	return sent("multipart", MULTIPART, [...replies, ...replies])
})
const empty = once(() => sent("empty", EMPTY, [OK, OK, OK, OK]))

/** A multipart content type's boundary, or null. */
const boundaryOf = (type: string) => /^multipart\/form-data; boundary=(.+)$/.exec(type)?.[1] ?? null

describe.skipIf(!PY)("a multipart file: a FilePart held in memory (Fc6)", SLOW, () => {
	/* V0BUG: v0 counted multipart replayable while its file objects were consumed (survey V0BUG 4); a FilePart is in memory and resent */
	// v0: 919e6504c5
	it("sends file and text parts under multipart/form-data, the same body again after a 401, on both clients", async () => {
		const { hops, run } = await multipart()
		const parts = await Promise.all(hops.map((h) => partsOf(h.body, h.type)))
		const upload = {
			file: [{ name: "a.txt", text: "file-bytes", type: "text/plain" }],
			name: ["multipart-value"],
			tags: ["a", "b"],
		}
		const batch = {
			count: ["3"],
			files: [
				{ name: "a.txt", text: "A", type: "text/plain" },
				{ name: "b.bin", text: "B", type: "application/octet-stream" },
			],
			flags: ["true", "false"],
			meta: ['{"k":1}'],
		}
		const row = [{ ok: true }, { ok: true }, "text/plain", "application/octet-stream"]
		const read = (section: string) => ({
			...seen(run, section),
			out: seen(run, section).out?.map((n) => JSON.parse(n)),
		})
		const sentAt = ["POST /upload Bearer old", "POST /upload Bearer fresh", "POST /batch undefined"]
		expect(
			{
				async: read("async"),
				at: hops.map((h) => h.at),
				parts,
				resent: [
					hops[0]?.body.equals(hops[1]?.body ?? Buffer.alloc(0)),
					hops[3]?.body.equals(hops[4]?.body ?? Buffer.alloc(0)),
				],
				sync: read("sync"),
				types: hops.map((h) => boundaryOf(h.type) !== null),
			},
			run.stderr,
		).toEqual({
			async: { out: [row], ran: true },
			at: [...sentAt, ...sentAt],
			parts: [upload, upload, batch, upload, upload, batch],
			resent: [true, true],
			sync: { out: [row], ran: true },
			types: [true, true, true, true, true, true],
		})
	})
})

describe.skipIf(!PY)("an empty multipart body: the closing boundary alone", SLOW, () => {
	// v0: 3592e06eaa
	it("sends an upload with no fields as --<boundary>--\\r\\n under multipart/form-data, on both clients", async () => {
		const { hops, run } = await empty()
		const uploads = hops.filter((h) => h.at.startsWith("POST /upload"))
		expect(
			{
				bodies: uploads.map((h) => h.body.toString() === `--${boundaryOf(h.type)}--\r\n`),
				ran: run.ran,
				types: uploads.map((h) => boundaryOf(h.type) !== null),
			},
			run.stderr,
		).toEqual({ bodies: [true, true], ran: true, types: [true, true] })
	})

	// v0: 3592e06eaa
	it("sends no part for a field that is an empty map, on both clients (the empty-map rule)", async () => {
		const { hops, run } = await empty()
		const batches = hops.filter((h) => h.at.startsWith("POST /batch"))
		const closing = batches.map((h) => `--${boundaryOf(h.type)}--\r\n`)
		expect({ bodies: batches.map((h) => h.body.toString()), count: batches.length, ran: run.ran }, run.stderr).toEqual({
			bodies: closing,
			count: 2,
			ran: true,
		})
	})
})

const MULTIPART_TYPES = [
	"import honey_sdk as sdk",
	"",
	"c = sdk.SDK()",
	'c.files.upload({"file": b"x"})',
	'c.files.upload({"file": sdk.FilePart("a", b"x"), "name": "n", "tags": ["t"]})',
	'c.files.batch({"count": 1, "files": [sdk.FilePart("a", b"x", "text/plain")], "flags": [True]})',
	'_: sdk.FilesUploadBody = {"file": sdk.FilePart(filename="a", data=b"x", content_type="text/plain")}',
]

describe.skipIf(!PY)("a multipart <Op>Body types a file part as FilePart (Fc6)", SLOW, () => {
	it("refuses bytes where a file part goes and takes a FilePart, alone or in a list", () => {
		const message = 'Incompatible types (expression has type "bytes", TypedDict item "file" has type "FilePart")'
		expect(findings(MULTIPART_TYPES)).toEqual([
			at(MULTIPART_TYPES, 'c.files.upload({"file": b"x"})', `${message}  [typeddict-item]`),
		])
	})
})
