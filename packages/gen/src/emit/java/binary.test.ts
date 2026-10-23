/**
 * The Java SDK's binary and text bodies, multipart parts and typed response headers (bit 16 phase c2; the port of C#'s
 * binary.test.ts with its C#-only legs dropped). A binary answer is its `byte[]`, asked for under its declared media
 * type, which a per-call Accept overrides and a config one never does; a text answer is a `String` as sent. A `byte[]`
 * body goes out sized and is sent again on a 401, an `InputStream` goes out chunked and never again. A multipart file
 * is a `FilePart` held in memory and sent again too, under a `honey-<uuid>` boundary, and an empty map is no part.
 * The grid drives a binary request body (C#'s legs too), so the sized and one-shot uploads run through `runCalls`; a
 * multipart body is C#'s consumer program and stays one (`exec`). Typed response headers are `new`: the grid observes
 * the holder's declared headers, as C#'s does.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether the pinned JDK and Gradle are here: a missing pin fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate compiles the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

type Key = "http" | "http-safe"

/* both error modes: a binary or text answer has the same shape in the driver's observed as returned */
const MODES = [
	["throw", "http"],
	["safe", "http-safe"],
] as const

const route = (method: string, path: string) => ({ method, path })
const FILES_GET: Call = { operation: "files.get", params: { name: "x" }, route: route("GET", "/files/{name}") }
const DOCS_GET: Call = { operation: "docs.get", params: { name: "d" }, route: route("GET", "/docs/{name}") }
const TEXT_GET: Call = { operation: "text.get", route: route("GET", "/text") }
const NOTE = (value: string): Call => ({
	body: { kind: "json", value },
	operation: "notes.create",
	route: route("POST", "/notes"),
})
const OK: Reply = { json: { ok: true }, status: 200 }

/** `size` bytes `i & 0xff`, as the recording server and the consumer programs send them. */
const pattern = (size: number) => Buffer.from(Array.from({ length: size }, (_, i) => i & 0xff))
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

/** The registry SDK `key`, driven; it must build (javac's diagnostics say why when not). */
function on(key: Key): DrivenJavaSdk {
	const sdk = drivenJavaSdk(key)
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run by `key`'s driver under `o` against a server answering `replies`: the run and what the server got. */
async function drive(key: Key, replies: readonly Reply[], calls: readonly Call[], o: Options = {}) {
	const sdk = on(key)
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: o.setup ?? {} }, { url: server.url }, { script: o.script })
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}

/** The consumer program `source(url)` (class `probe.Probe`) compiled against the `http` SDK, run against `replies`. */
async function consume(replies: readonly Reply[], source: (url: string) => string) {
	const sdk = on("http")
	return served(replies, async (server) => {
		const run = await sdk.exec("probe.Probe", source(server.url))
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}

/** A `probe.Probe` program running `statements` in its main, with the imports every consumer here needs. */
const program = (statements: readonly string[]) => `package probe;

import ai.anyrow.*;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

public final class Probe {
  public static void main(String[] args) {
${statements.map((line) => `    ${line}`).join("\n")}
  }
}
`

/** A hop's method, path and authorization, as a consumer's call sent it. */
const who = (h: RecordedHop) => ({ authorization: h.headers.authorization, method: h.method, url: h.url })
/** An upload hop: its authorization, media type, framing, digest and size. */
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

const octets = (size: number, type: string): Reply => ({ bytes: size, headers: { "content-type": type }, status: 200 })
const bytesOf = (size: number) => ({ kind: "bytes", sha256: sha256(pattern(size)), size, status: 200 })

describe.skipIf(!JAVA)("binary answers: byte[], never decoded, Accept the declared media type", SLOW, () => {
	/* pin */
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

	/* pin: RequestOptions headers land after the operation's Accept (Flight.layer), so a per-call one overrides it */
	it("lets a per-call Accept (RequestOptions.headers) win over the declared media type", async () => {
		const call = { ...FILES_GET, headers: { accept: "*/*" } }
		const { hops, run } = await drive("http", [octets(3, "application/octet-stream")], [call])
		expect({ accept: hops.map((h) => h.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["*/*"],
			observed: [bytesOf(3)],
		})
	})

	/* pin: the operation's Accept is layered after the config headers, so a config Accept never wins */
	it("keeps the declared media type over a ClientConfig.headers Accept", async () => {
		const setup: Setup = { headers: { Accept: "application/json" } }
		const { hops, run } = await drive("http", [octets(3, "application/octet-stream")], [FILES_GET], { setup })
		expect({ accept: hops.map((h) => h.headers.accept), observed: run.observed }, run.stderr).toEqual({
			accept: ["application/octet-stream"],
			observed: [bytesOf(3)],
		})
	})
})

/** A 200 text/plain answer of `body`. */
const text = (body: string): Reply => ({ headers: { "content-type": "text/plain" }, status: 200, text: body })

describe.skipIf(!JAVA)("text bodies and answers: a String as sent, never JSON-decoded", SLOW, () => {
	/* pin */
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

/** A binary upload: `size` bytes to `files.put`, sized as a `byte[]` or one-shot as a stream (the script says which). */
const PUT = (size: number): Call => ({
	body: { contentType: "application/octet-stream", kind: "binary", size },
	operation: "files.put",
	params: { name: "x" },
	route: route("PUT", "/files/{name}"),
})
const UPLOADED = { contentType: "application/octet-stream", method: "PUT", url: "/files/x" }

/* pin: the sized body is resent with the refreshed token (Flight.answer: replayable); the stream is never resent */
describe.skipIf(!JAVA)("binary request bodies: byte[] (sized) resent, a stream (chunked) never (Fc6)", SLOW, () => {
	/* pin: a sized byte[] goes out with its length, a one-shot stream chunked; the grid drives both (as C#'s does) */
	it.each(MODES)(
		"sends a byte[] with its length and a one-shot stream chunked, under the declared media type (%s)",
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

	/* pin: the sized body is sent again with OnAuthExpired's token after a 401; a one-shot stream's 401 is the answer */
	it.each(MODES)(
		"sends a byte[] again with onAuthExpired's token after a 401; a one-shot stream's 401 is the answer (%s)",
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
})

/** An item read's 200 carrying `headers`. */
const item = (headers: Record<string, string>): Reply => ({ headers, json: { id: "i1", name: "n" }, status: 200 })
const ITEMS_GET: Call = { operation: "items.get", params: { id: "i1" }, route: route("GET", "/items/{id}") }
/** A DecodeException as the trace records it: the SDK's own, thrown by the method. */
const decodeError = (message: string) => ({
	canceled: false,
	chain: ["DecodeException", "HoneyException"],
	display: expect.any(String),
	inner: null,
	text: message,
	type: "DecodeException",
	via: "return",
})

/* new: the <Op>Headers holder is filled from a 2xx; a missing or unparsable required header is a DecodeException (as C#) */
describe.skipIf(!JAVA)("typed response headers: <Op>Headers fills the declared headers (Fc7)", SLOW, () => {
	it.each(MODES)(
		"fills the declared headers only, an absent optional one unset; a missing or unparsable required one is a DecodeException (%s)",
		async (_, key) => {
			const replies = [
				item({ "x-etag": "e1", "x-item-version": "3", "x-undeclared": "u" }),
				item({ "x-item-version": "3" }),
				item({ "x-etag": "e1" }),
				item({ "x-item-version": "x" }),
			]
			const { run } = await drive(key, replies, [ITEMS_GET, ITEMS_GET, ITEMS_GET, ITEMS_GET], { script: {} })
			const data = { id: "i1", name: "n" }
			expect({ errors: run.trace?.calls.map((c) => c.error), observed: run.observed }, run.stderr).toEqual({
				errors: [
					undefined,
					undefined,
					decodeError("the X-Item-Version header is missing"),
					decodeError("the X-Item-Version header is not a valid integer"),
				],
				observed: [
					{ data, headers: { "X-Etag": "e1", "X-Item-Version": "3" }, kind: "data", status: 200 },
					{ data, headers: { "X-Item-Version": "3" }, kind: "data", status: 200 },
					null,
					null,
				],
			})
		},
	)
})

/* pin: the multipart body is built into memory and resent on a 401 (Body.multipart, Flight.answer) */
const MULTIPART_STATEMENTS = (url: string) => [
	'FilePart file = new FilePart("a.txt", "file-bytes".getBytes(StandardCharsets.UTF_8), "text/plain");',
	`AnyrowClient client = AnyrowClient.builder().baseUrl("${url}").bearerToken("old").onAuthExpired(() -> "fresh").build();`,
	'client.files().upload(new FilesUploadParams(new FilesUploadBody(file, "multipart-value", List.of("a", "b"))));',
	'System.out.println("uploaded");',
	`AnyrowClient bare = AnyrowClient.builder().baseUrl("${url}").build();`,
	"bare.files().batch(new FilesBatchParams(new FilesBatchBody(3L,",
	'  List.of(new FilePart("a.txt", "A".getBytes(StandardCharsets.UTF_8), "text/plain"),',
	'          new FilePart("b.bin", "B".getBytes(StandardCharsets.UTF_8), "application/octet-stream")),',
	"  List.of(true, false), new FilesBatchMeta(1L))));",
	'System.out.println("batched");',
	"bare.files().upload(new FilesUploadParams(new FilesUploadBody(null, null, null)));",
	'System.out.println("emptied");',
	"bare.files().batch(new FilesBatchParams(new FilesBatchBody(null, null, null, new FilesBatchMeta(null))));",
	'System.out.println("emptied");',
]

/** The multipart program, run once: its hops and bodies, and its run. */
let multipartRun: ReturnType<typeof consume> | undefined
const multipart = () =>
	(multipartRun ??= consume([{ status: 401 }, OK, OK, OK, OK], (url) => program(MULTIPART_STATEMENTS(url))))

/** A multipart content type's boundary when it is `honey-<uuid>`, else null. */
const boundaryOf = (type: string) => /^multipart\/form-data; boundary=(honey-[0-9a-f-]{36})$/.exec(type)?.[1] ?? null

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

/** The parts the upload sends: a file, its name and its tags. */
const UPLOAD_PARTS = {
	file: [{ name: "a.txt", text: "file-bytes", type: "text/plain" }],
	name: ["multipart-value"],
	tags: ["a", "b"],
}
/** The parts the batch sends: a count, two files, flags and a map as JSON. */
const BATCH_PARTS = {
	count: ["3"],
	files: [
		{ name: "a.txt", text: "A", type: "text/plain" },
		{ name: "b.bin", text: "B", type: "application/octet-stream" },
	],
	flags: ["true", "false"],
	meta: ['{"k":1}'],
}

describe.skipIf(!JAVA)("multipart: FilePart parts held in memory, a honey-<uuid> boundary", SLOW, () => {
	/* pin */
	it("sends file and text parts under multipart/form-data, the same body again after a 401", async () => {
		const { bodies, hops, run } = await multipart()
		const sent = hops.slice(0, 3)
		const bodyOf = (i: number) => bodies[i] ?? Buffer.alloc(0)
		expect(
			{
				at: sent.map(who),
				boundaries: sent.map((h) => boundaryOf(h.headers["content-type"] ?? "") !== null),
				lines: run.stdout.trim().split("\n").slice(0, 2),
				parts: await Promise.all(sent.map((h, i) => partsOf(bodyOf(i), h.headers["content-type"] ?? ""))),
				resent: bodyOf(0).equals(bodyOf(1)),
				status: run.status,
			},
			run.stderr,
		).toEqual({
			at: [
				{ authorization: "Bearer old", method: "POST", url: "/upload" },
				{ authorization: "Bearer fresh", method: "POST", url: "/upload" },
				{ authorization: undefined, method: "POST", url: "/batch" },
			],
			boundaries: [true, true, true],
			lines: ["uploaded", "batched"],
			parts: [UPLOAD_PARTS, UPLOAD_PARTS, BATCH_PARTS],
			resent: true,
			status: 0,
		})
	})

	/* pin: an empty map (and an absent part) is no part, so the body is the closing boundary alone */
	it("sends an upload with no fields, and a batch whose only field is an empty map, as --<boundary>--\\r\\n alone", async () => {
		const { bodies, hops, run } = await multipart()
		const empty = hops.slice(3)
		const closingOf = (h: RecordedHop, i: number) =>
			(bodies[i + 3] ?? Buffer.alloc(0)).toString() === `--${boundaryOf(h.headers["content-type"] ?? "")}--\r\n`
		expect(
			{
				at: empty.map(who),
				closing: empty.map(closingOf),
				lines: run.stdout.trim().split("\n").slice(2),
				status: run.status,
			},
			run.stderr,
		).toEqual({
			at: [
				{ authorization: undefined, method: "POST", url: "/upload" },
				{ authorization: undefined, method: "POST", url: "/batch" },
			],
			closing: [true, true],
			lines: ["emptied", "emptied"],
			status: 0,
		})
	})
})
