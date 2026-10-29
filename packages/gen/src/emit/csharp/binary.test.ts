/**
 * Past JSON in C# (contract 47 §5.11; Fc6, Fc7): a binary answer is its `byte[]`, asked for under its declared
 * media type, which a per-call `Accept` overrides and a config one never does; a text answer is a `string` as sent.
 * A binary body is a `BinaryBody`: a `byte[]` goes out sized and is sent again on a 401, a `Stream` goes out chunked
 * and never again. A multipart file is a `FilePart` held in memory and sent again too, under a `honey-<uuid>`
 * boundary, and an empty map is no part. Declared response headers fill a caller's `<Op>Headers` (`headersInto`),
 * and a missing or unparsable required one is a `DecodeException` (on `client.Safe` an answer, so its Result's Err).
 * Driven in both styles on `http`, C#'s one async client and its `client.Safe` (no drift check); answer types and
 * multipart bodies are consumer programs,
 * the types csc's findings. Ported from Python's binary.test.ts:92-485 (contract 47 §6).
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CsError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { checked, consume, program, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

/** The style a run calls through: the client, or its `client.Safe` mirror (bit 21 i5). */
type Key = "normal" | "safe"

/* both styles: a binary or text answer has the same shape in a Result's Value as returned */
const MODES = [
	["throw", "normal"],
	["safe", "safe"],
] as const

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

/** A C# error as the trace records it: no inner, not canceled, the method's own throw unless given, any display. */
const plain = (entry: Partial<CsError>) => ({
	canceled: false,
	display: expect.any(String),
	inner: null,
	via: "return",
	...entry,
})
const decodeError = (text: string) =>
	plain({ chain: ["DecodeException", "SdkException", "HoneyException"], text, type: "DecodeException" })

/** The `http` SDK with the driver aimed at it (it must build). */
function on(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("http")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run in `key`'s style under `o` against a server answering `replies`, with what the server got. */
async function drive(key: Key, replies: readonly Reply[], calls: readonly Call[], o: Options = {}) {
	const sdk = on()
	return served(replies, async (server) => {
		const cell = { calls, setup: o.setup ?? {} }
		const origins = { alt: server.alt, url: server.url }
		const run = await sdk.runCalls(cell, origins, { script: o.script }, key === "safe")
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}

const octets = (size: number, type: string): Reply => ({ bytes: size, headers: { "content-type": type }, status: 200 })
const bytesOf = (size: number) => ({ kind: "bytes", sha256: sha256(pattern(size)), size, status: 200 })

describe.skipIf(!DOTNET)("binary answers: byte[], never decoded, Accept the declared media type", SLOW, () => {
	// ported: python binary.test.ts:92
	it.each(MODES)(
		"answers an octet-stream or pdf body as its bytes and asks for that media type (%s)",
		async (_, key) => {
			const replies = [octets(256, "application/octet-stream"), octets(4, "application/pdf")]
			const { hops, run } = await drive(key, replies, [FILES_GET, DOCS_GET])
			expect({ accept: hops.map((h) => [h.url, h.headers.accept]), observed: run.observed }, run.stderr).toEqual({
				accept: [
					["/files/x", "application/octet-stream"],
					["/docs/d", "application/pdf"],
				],
				observed: [bytesOf(256), bytesOf(4)],
			})
		},
	)

	// ported: python binary.test.ts:107
	it("lets a per-call Accept (RequestOptions.Headers) win over the declared media type", async () => {
		const call = { ...FILES_GET, headers: { accept: "*/*" } }
		const { hops, run } = await drive("normal", [octets(3, "application/octet-stream")], [call])
		expect({ accept: hops.map((h) => h.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["*/*"],
			observed: [bytesOf(3)],
		})
	})

	// ported: python binary.test.ts:116
	it("keeps the declared media type over a ClientConfig.Headers Accept", async () => {
		const setup: Setup = { headers: { Accept: "application/json" } }
		const { hops, run } = await drive("normal", [octets(3, "application/octet-stream")], [FILES_GET], { setup })
		expect({ accept: hops.map((h) => h.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["application/octet-stream"],
			observed: [bytesOf(3)],
		})
	})
})

/** A 200 text/plain answer of `body`. */
const text = (body: string): Reply => ({ headers: { "content-type": "text/plain" }, status: 200, text: body })

describe.skipIf(!DOTNET)("text bodies and answers: a string as sent, never JSON-decoded", SLOW, () => {
	// ported: python binary.test.ts:136
	it.each(MODES)(
		"answers text/plain as the string, sends a string body as text/plain and asks for text/plain (%s)",
		async (_, key) => {
			const replies = [text('{"a":1}'), text("hello"), text('"quoted"')]
			const { bodies, hops, run } = await drive(key, replies, [TEXT_GET, NOTE("hello"), NOTE("bye")])
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

describe.skipIf(!DOTNET)(
	"binary request bodies: byte[] (sized) or a Stream (chunked), only byte[] resent (Fc6)",
	SLOW,
	() => {
		// ported: python binary.test.ts:173
		it.each(MODES)(
			"sends a byte[] with its length and a one-shot Stream chunked, under the declared media type (%s)",
			async (_, key) => {
				const size = 65_536
				const done: Reply = { json: { size }, status: 200 }
				const script: Script = { calls: [null, { oneShotBody: true }] }
				const { bodies, hops, run } = await drive(key, [done, done], [PUT(size), PUT(size)], { script })
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

		// ported: python binary.test.ts:198
		it.each(MODES)(
			"sends a byte[] again with OnAuthExpired's token after a 401; a one-shot Stream's 401 is the answer (%s)",
			async (_, key) => {
				const size = 4096
				const script: Script = { calls: [null, { oneShotBody: true }], onAuthExpired: { tokens: ["new"] } }
				const setup: Setup = { auth: { kind: "bearer", token: "old" } }
				const replies: Reply[] = [{ status: 401 }, { json: { size }, status: 200 }, { status: 401 }]
				const { bodies, hops, run } = await drive(key, replies, [PUT(size), PUT(size)], { script, setup })
				const sent = { ...UPLOADED, sha256: sha256(pattern(size)), size }
				const sized = { ...sent, length: String(size), transferEncoding: undefined }
				const wire = hops.map(uploadOf)
				const same = bodies.map((b) => b.equals(pattern(size)))
				expect({ expired: run.trace?.authExpired, observed: run.observed, same, wire }, run.stderr).toEqual({
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
	},
)

/** An item read's 200 carrying `headers`. */
const item = (headers: Record<string, string>): Reply => ({ headers, json: { id: "i1", name: "n" }, status: 200 })

describe.skipIf(!DOTNET)("typed response headers: headersInto fills <Op>Headers (Fc7)", SLOW, () => {
	// ported: python binary.test.ts:237
	it.each(MODES)(
		"fills the declared headers only, an absent optional one unset; a missing or unparsable required one is a DecodeException (%s: the safe one's Err)",
		async (_, key) => {
			const replies = [
				item({ "x-etag": "e1", "x-item-version": "3", "x-undeclared": "u" }),
				item({ "x-item-version": "3" }),
				item({ "x-etag": "e1" }),
				item({ "x-item-version": "x" }),
			]
			const calls = [ITEMS_GET, ITEMS_GET, ITEMS_GET, ITEMS_GET]
			const { run } = await drive(key, replies, calls, { script: {} })
			const data = { id: "i1", name: "n" }
			const safe = key === "safe"
			const unread = (why: string) => (safe ? { ...decodeError(why), via: "result" } : decodeError(why))
			const missed = safe ? { kind: "decode", status: 200 } : null
			expect({ errors: run.trace?.calls.map((c) => c.error), observed: run.observed }, run.stderr).toEqual({
				errors: [
					undefined,
					undefined,
					unread("the X-Item-Version header is missing"),
					unread("the X-Item-Version header is not a valid integer"),
				],
				observed: [
					{ data, headers: { "X-Etag": "e1", "X-Item-Version": "3" }, kind: "data", status: 200 },
					{ data, headers: { "X-Item-Version": "3" }, kind: "data", status: 200 },
					missed,
					missed,
				],
			})
		},
	)
})

/** A consumer: a binary answer's length and edge bytes, and a text answer. */
const ANSWERS = `Section("answers");
using var c = Client();
byte[] b = await c.Files.GetAsync("x");
string s = await c.Notes.CreateAsync("hi");
Note($"{b.Length} {b[0]} {b[1]} {b[254]} {b[255]} {s}");`

describe.skipIf(!DOTNET)("the answer types a method returns (Fc6)", SLOW, () => {
	// ported: python binary.test.ts:287
	it("returns a binary answer as byte[] with every byte (none decoded) and a text one as string", async () => {
		const replies: Reply[] = [octets(256, "application/octet-stream"), text("hello")]
		const { hops, run } = await served(replies, async (server) => {
			const ran = await consume("http", "answers", { base: server.url, body: ANSWERS })
			return { hops: server.hops.map((h) => `${h.method} ${h.url} ${h.headers.accept}`), run: ran }
		})
		expect({ ...seen(run, "answers"), hops }, run.stderr).toEqual({
			hops: ["GET /files/x application/octet-stream", "POST /notes text/plain"],
			out: ["256 0 1 254 255 hello"],
			ran: true,
		})
	})
})

/** csc's errors for `lines` (statements of a consumer's Main) against `http`, each as `<the statement> → <CS code>: <message>`. */
function findings(lines: readonly string[]): string[] {
	const source = program("HoneySdk", "HoneySdkClient", lines.join("\n"))
	const rows = source.split("\n")
	return checked("http", source).map((line) => {
		const found = /^\((\d+),\d+\): error (CS\d+: .*)$/.exec(line)
		return found === null ? line : `${rows[Number(found[1]) - 1]?.trim()} → ${found[2]}`
	})
}

const ECHO_INTO = "await c.Echo.GetAsync(headersInto: null);"
const SET_ETAG = 'h.XEtag = "e";'
const HEADERS_INTO = [
	"using var c = Client();",
	"var h = new ItemsGetHeaders();",
	'Item item = await c.Items.GetAsync("i", headersInto: h);',
	"long? version = h.XItemVersion;",
	"string? etag = h.XEtag;",
	'byte[] file = await c.Files.GetAsync("x");',
	'string note = await c.Notes.CreateAsync("hi");',
	'Note($"{item.Id} {version} {etag} {file.Length} {note}");',
	ECHO_INTO,
	SET_ETAG,
]

const UPLOAD_BYTES = "var u = new FilesUploadBody { File = new byte[1] };"
const MULTIPART_TYPES = [UPLOAD_BYTES, 'var p = new FilePart("a", [1]);', "Note(u);", "Note(p);"]

const PUT_STRING = 'await c.Files.PutAsync("x", "s");'
const BINARY_BODY = [
	"using var c = Client();",
	'await c.Files.PutAsync("x", new byte[1]);',
	'await c.Files.PutAsync("x", new System.IO.MemoryStream());',
	PUT_STRING,
]

describe.skipIf(!DOTNET)("headersInto, FilePart and BinaryBody as csc reads them (http)", SLOW, () => {
	// ported: python binary.test.ts:336
	it("types each declared header by its schema, read-only to the caller, and refuses headersInto on an op declaring none", () => {
		expect(findings(HEADERS_INTO)).toEqual([
			`${ECHO_INTO} → CS1739: The best overload for 'GetAsync' does not have a parameter named 'headersInto'`,
			`${SET_ETAG} → CS0200: Property or indexer 'ItemsGetHeaders.XEtag' cannot be assigned to -- it is read only`,
		])
	})

	// ported: python binary.test.ts:485
	it("refuses a byte[] where a multipart file part goes, and takes a FilePart", () => {
		expect(findings(MULTIPART_TYPES)).toEqual([
			`${UPLOAD_BYTES} → CS0029: Cannot implicitly convert type 'byte[]' to 'HoneySdk.FilePart'`,
		])
	})

	it("takes a byte[] or a Stream as a BinaryBody, and refuses a string (Fc6)", () => {
		expect(findings(BINARY_BODY)).toEqual([
			`${PUT_STRING} → CS1503: Argument 2: cannot convert from 'string' to 'HoneySdk.BinaryBody'`,
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

/** An upload of a FilePart on a client whose `old` token a refresh replaces, a batch, then the empty bodies. */
const MULTIPART = `Section("multipart");
var file = new FilePart("a.txt", "file-bytes"u8.ToArray(), "text/plain");
using var c = Client(new ClientConfig { BearerToken = "old", OnAuthExpired = _ => Task.FromResult<string?>("fresh") });
var r = await c.Files.UploadAsync(new FilesUploadBody { File = file, Name = "multipart-value", Tags = ["a", "b"] });
FilePart[] files = [new FilePart("a.txt", "A"u8.ToArray(), "text/plain"), new FilePart("b.bin", "B"u8.ToArray())];
using var bare = Client();
var b = await bare.Files.BatchAsync(new FilesBatchBody { Count = 3, Files = files, Flags = [true, false], Meta = new() { K = 1 } });
Note($"{r.Ok} {b.Ok} {file.ContentType} {files[1].ContentType}");
Section("empty");
var u = await bare.Files.UploadAsync(new FilesUploadBody());
var m = await bare.Files.BatchAsync(new FilesBatchBody { Meta = new() });
Note($"{u.Ok} {m.Ok}");`

/** MULTIPART run once on `http`: the run, and each hop's line, content type and body. */
let multipartRun:
	| Promise<{ hops: { at: string; body: Buffer; type: string }[]; run: Awaited<ReturnType<typeof consume>> }>
	| undefined
const multipart = () =>
	(multipartRun ??= served([{ status: 401 }, OK, OK, OK, OK], async (server) => {
		const run = await consume("http", "multipart", { base: server.url, body: MULTIPART })
		const hops = server.hops.map((h, i) => ({
			at: `${h.method} ${h.url} ${h.headers.authorization}`,
			body: server.bodies[i] ?? Buffer.alloc(0),
			type: h.headers["content-type"] ?? "",
		}))
		return { hops, run }
	}))

/** A multipart content type's boundary when it is `honey-<uuid>`, else null. */
const boundaryOf = (type: string) => /^multipart\/form-data; boundary=(honey-[0-9a-f-]{36})$/.exec(type)?.[1] ?? null

describe.skipIf(!DOTNET)("multipart: FilePart parts held in memory, a honey-<uuid> boundary", SLOW, () => {
	// ported: python binary.test.ts:399; P6 (the hand encoder against formData())
	it("sends file and text parts under multipart/form-data, the same body again after a 401", async () => {
		const { hops, run } = await multipart()
		const sent = hops.slice(0, 3)
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
		expect(
			{
				...seen(run, "multipart"),
				at: sent.map((h) => h.at),
				boundaries: sent.map((h) => boundaryOf(h.type) !== null),
				parts: await Promise.all(sent.map((h) => partsOf(h.body, h.type))),
				resent: sent[0]?.body.equals(sent[1]?.body ?? Buffer.alloc(0)),
			},
			run.stderr,
		).toEqual({
			at: ["POST /upload Bearer old", "POST /upload Bearer fresh", "POST /batch undefined"],
			boundaries: [true, true, true],
			out: ["True True text/plain application/octet-stream"],
			parts: [upload, upload, batch],
			ran: true,
			resent: true,
		})
	})

	// ported: python binary.test.ts:448, :462
	it("sends an upload with no fields, and a batch whose only field is an empty map, as --<boundary>--\\r\\n alone", async () => {
		const { hops, run } = await multipart()
		const empty = hops.slice(3)
		expect(
			{
				...seen(run, "empty"),
				at: empty.map((h) => h.at),
				closing: empty.map((h) => h.body.toString() === `--${boundaryOf(h.type)}--\r\n`),
			},
			run.stderr,
		).toEqual({
			at: ["POST /upload undefined", "POST /batch undefined"],
			closing: [true, true],
			out: ["True True"],
			ran: true,
		})
	})
})
