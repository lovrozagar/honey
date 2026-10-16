/**
 * Past JSON (contract 19 §5.8; G4/G5, Fc3, Fc7): a binary answer is its bytes as `Vec<u8>`, asked for under
 * its declared media type and never decoded as text or JSON; a text answer is a `String` as sent. A binary
 * body goes out under its declared type, sized when in memory and chunked when one-shot, and only an
 * in-memory one is sent again on a 401; a multipart file is a `FilePart` held in memory and sent again too.
 * Declared response headers are read typed through `.with_headers()` (`FromHeaders`). The driver observes a
 * binary answer as its size and SHA-256 (the hand-written `driver/sha256.rs`), checked against node:crypto.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/compiled.ts"
import { consume, once, sections, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

/* cargo builds the crate's dependencies on a cold cache */
const CARGO = 600_000

const route = (method: string, path: string) => ({ method, path })
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

/* both error modes: a binary or text answer has the same shape in SdkResult.data as in the return value */
const MODES = [
	["throw", "http"],
	["safe", "http-safe"],
] as const

/** `size` bytes `i & 0xff`, as the driver sends and the recording server answers them. */
const pattern = (size: number) => Buffer.from(Array.from({ length: size }, (_, i) => i & 0xff))
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")

/** A Rust error as the trace records it: no source and the method's own Err unless given, any Debug text. */
const plain = (entry: Partial<RustError>) => ({ debug: expect.any(String), source: false, via: "return", ...entry })

/** The registry SDK `key` compiled with the driver, which must build. */
function driven(key: "http" | "http-safe"): DrivenRustSdk {
	const sdk = drivenRustSdk(key)
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run by `key`'s driver on one client under `options` against a server answering `replies`. */
async function drive(key: "http" | "http-safe", replies: readonly Reply[], calls: readonly Call[], o: Options = {}) {
	const sdk = driven(key)
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: o.setup ?? {} }, server, o.script)
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}

const octets = (size: number, type: string): Reply => ({ bytes: size, headers: { "content-type": type }, status: 200 })

describe.skipIf(!RUST)("binary answers: Vec<u8>, never decoded as text or JSON, Accept the declared media type", () => {
	// v0: 63ad606050
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
				observed: [
					{ kind: "bytes", sha256: sha256(pattern(256)), size: 256, status: 200 },
					{ kind: "bytes", sha256: sha256(pattern(4)), size: 4, status: 200 },
				],
			})
		},
		CARGO,
	)

	it(
		"lets a per-call Accept header (.header) win over the declared media type",
		async () => {
			const call = { ...FILES_GET, headers: { accept: "*/*" } }
			const { hops, run } = await drive("http", [octets(3, "application/octet-stream")], [call])
			expect({ accept: hops.map((h) => h.headers.accept), observed: run.observed }, run.stderr).toEqual({
				accept: ["*/*"],
				observed: [{ kind: "bytes", sha256: sha256(pattern(3)), size: 3, status: 200 }],
			})
		},
		CARGO,
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

describe.skipIf(!RUST)("binary request bodies: in memory (sized) or one-shot (chunked)", () => {
	it.each(MODES)(
		"sends a Body under its declared media type: an in-memory one with its length, a stream chunked (%s)",
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
		CARGO,
	)
})

describe.skipIf(!RUST)("a binary body after a 401: an in-memory one sent again, a one-shot one never", () => {
	it.each(MODES)(
		"sends an in-memory body again with on_auth_expired's token after a 401; a one-shot one's 401 is the answer (%s)",
		async (_, key) => {
			const size = 4096
			const script: Script = { calls: [null, { oneShotBody: true }], onAuthExpired: { tokens: ["new"] } }
			const setup: Setup = { auth: { kind: "bearer", token: "old" } }
			const replies: Reply[] = [{ status: 401 }, { json: { size }, status: 200 }, { status: 401 }]
			const { bodies, hops, run } = await drive(key, replies, [PUT(size), PUT(size)], { script, setup })
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
		CARGO,
	)
})

describe.skipIf(!RUST)("text bodies and answers: a String as sent, never JSON-decoded", () => {
	it.each(MODES)(
		"sends a &str body as text/plain, asks for text/plain, and answers the text as is (%s)",
		async (_, key) => {
			const replies: Reply[] = [
				{ headers: { "content-type": "text/plain" }, status: 200, text: "hello" },
				{ headers: { "content-type": "text/plain" }, status: 200, text: '"quoted"' },
			]
			const { bodies, hops, run } = await drive(key, replies, [NOTE("hello"), NOTE("bye")])
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
		CARGO,
	)
})

/** An item read's 200 carrying `headers`. */
const item = (headers: Record<string, string>): Reply => ({ headers, json: { id: "i1", name: "n" }, status: 200 })

describe.skipIf(!RUST)("typed response headers: <Op>Headers through FromHeaders", () => {
	it.each(MODES)(
		"reads the declared headers only, an absent optional one left out, an absent required one a Decode error (%s)",
		async (_, key) => {
			const replies = [
				item({ "x-etag": "e1", "x-item-version": "3", "x-undeclared": "u" }),
				item({ "x-item-version": "3" }),
				item({ "x-etag": "e1" }),
			]
			const calls = [ITEMS_GET, ITEMS_GET, ITEMS_GET]
			const { run } = await drive(key, replies, calls, { script: {} })
			const data = { id: "i1", name: "n" }
			expect({ error: run.trace?.calls[2]?.error, observed: run.observed }, run.stderr).toEqual({
				error: plain({ text: "decode: the X-Item-Version header is missing", variant: "Decode" }),
				observed: [
					{ data, headers: { "x-etag": "e1", "x-item-version": "3" }, kind: "data", status: 200 },
					{ data, headers: { "x-item-version": "3" }, kind: "data", status: 200 },
					null,
				],
			})
		},
		CARGO,
	)
})

/** Every request the `answers` program sends, in order: its section and the reply it gets. */
const ANSWERED: readonly (readonly [section: string, reply: Reply])[] = [
	["bytes", octets(256, "application/octet-stream")],
	["text", { headers: { "content-type": "text/plain" }, status: 200, text: "hello" }],
	["typed", item({ "x-etag": "e1", "x-item-version": "3", "x-undeclared": "u" })],
	["missing", { json: { message: "no" }, status: 404 }],
]

/** A throw-mode consumer: the answer types a method resolves to, and `.with_headers()`'s typed fields. */
const ANSWERS = sections({
	bytes: `    let b: Vec<u8> = client(base)?.files().get("x", &sdk::FilesGetOpts::default()).await?;
    n.note(format!("{} {:?} {:?}", b.len(), &b[..2], &b[254..]));`,
	text: `    let s: String = client(base)?.notes().create("hi", &sdk::NotesCreateOpts::default()).await?;
    n.note(format!("{s:?}"));`,
	typed: `    let c = client(base)?;
    let (item, h) = c.items().get("i1", &sdk::ItemsGetOpts::default()).with_headers().await?;
    let _: (&sdk::Item, i64, &Option<String>) = (&item, h.x_item_version, &h.x_etag);
    n.note(format!("{} {} {:?}", item.id, h.x_item_version, h.x_etag));`,
	missing: `    let c = client(base)?;
    match c.items().get("gone", &sdk::ItemsGetOpts::default()).with_headers().await {
        Err(e @ sdk::Error::Api(_)) => n.note(format!("api {:?}", e.status())),
        Err(e) => n.note(format!("other {e}")),
        Ok(_) => n.note("answered"),
    }`,
})

/** The `answers` program run once against ANSWERED, with what each hop asked for. */
const answers = once(() =>
	served(
		ANSWERED.map(([, reply]) => reply),
		async (server) => {
			const run = await consume("http", "answers", { ...ANSWERS, base: server.url })
			return { hops: server.hops.map((h) => `${h.method} ${h.url} ${h.headers.accept}`), run }
		},
	),
)

describe.skipIf(!RUST)("the answer types a method resolves to (F1, G5)", () => {
	it(
		"resolves a binary answer to Vec<u8> with every byte (none lossily decoded) and a text one to String",
		async () => {
			const { hops, run } = await answers()
			expect({ bytes: seen(run, "bytes"), hops: hops.slice(0, 2), text: seen(run, "text") }, run.stderr).toEqual({
				bytes: { built: true, out: ["256 [0, 1] [254, 255]"] },
				hops: ["GET /files/x application/octet-stream", "POST /notes text/plain"],
				text: { built: true, out: ['"hello"'] },
			})
		},
		CARGO,
	)

	it(
		"types a required header bare and an optional one as Option through .with_headers(); an error status is Err(Api)",
		async () => {
			const { hops, run } = await answers()
			expect({ hops: hops.slice(2), missing: seen(run, "missing"), typed: seen(run, "typed") }, run.stderr).toEqual({
				hops: ["GET /items/i1 */*", "GET /items/gone */*"],
				missing: { built: true, out: ["api Some(404)"] },
				typed: { built: true, out: ['i1 3 Some("e1")'] },
			})
		},
		CARGO,
	)
})

/** A client holding the token `old`, which `on_auth_expired` replaces with `fresh`. */
const REFRESHING = `type Refreshed = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>, sdk::Error>> + Send>>;

fn refreshing(base: &str) -> Result<sdk::Client, sdk::Error> {
    let hook: sdk::OnAuthExpiredHook = std::sync::Arc::new(|_| -> Refreshed { Box::pin(async { Ok(Some("fresh".to_owned())) }) });
    sdk::Client::new(sdk::ClientConfig { base_url: base.into(), bearer_token: Some("old".into()), on_auth_expired: Some(hook), ..Default::default() })
}`

/** A multipart upload of a FilePart whose bytes are no UTF-8, answered 401 and then 200. */
const MULTIPART = sections({
	upload: `    let file = sdk::FilePart { filename: "blob.bin".into(), content_type: Some("application/octet-stream".into()), data: vec![0, 1, 255] };
    let body = sdk::FilesUploadBody { file: Some(file.clone()), name: Some("n".into()), ..Default::default() };
    let _: (&Option<sdk::FilePart>, &Option<String>, &Vec<String>) = (&body.file, &body.name, &body.tags);
    let c = refreshing(base)?;
    let r = c.files().upload(&body, &sdk::FilesUploadOpts::default()).await?;
    n.note(format!("uploaded {:?} {}", r.ok, body.file == Some(file)));`,
})

/** A multipart body's parts by name, as a server's form parser reads them: a file as its name, type and bytes. */
async function partsOf(body: Buffer, type: string): Promise<Record<string, unknown[]>> {
	const form = await new Response(new Uint8Array(body), { headers: { "content-type": type } }).formData()
	const parts: Record<string, unknown[]> = {}
	for (const [name, value] of form.entries()) {
		const part =
			typeof value === "string"
				? value
				: { bytes: [...new Uint8Array(await value.arrayBuffer())], name: value.name, type: value.type }
		;(parts[name] ??= []).push(part)
	}
	return parts
}

describe.skipIf(!RUST)("a multipart file: a FilePart held in memory (Fc7)", () => {
	it(
		"sends its bytes as a file part under its name and type, the same body again after a 401",
		async () => {
			const replies: Reply[] = [{ status: 401 }, { json: { ok: true }, status: 200 }]
			const { bodies, hops, run } = await served(replies, async (server) => {
				const ran = await consume("http", "multipart", {
					base: server.url,
					body: MULTIPART.body,
					decls: `${REFRESHING}\n\n${MULTIPART.decls}`,
				})
				return { bodies: [...server.bodies], hops: [...server.hops], run: ran }
			})
			const types = hops.map((h) => h.headers["content-type"] ?? "")
			const parts = await Promise.all(bodies.map((b, i) => partsOf(b, types[i] ?? "")))
			const file = { bytes: [0, 1, 255], name: "blob.bin", type: "application/octet-stream" }
			expect(
				{
					hops: hops.map((h) => `${h.method} ${h.url} ${h.headers.authorization}`),
					parts,
					same: bodies.length === 2 && bodies[0]?.equals(bodies[1] ?? Buffer.alloc(0)),
					types: types.map((t) => t.startsWith("multipart/form-data; boundary=honey-")),
					upload: seen(run, "upload"),
				},
				run.stderr,
			).toEqual({
				hops: ["POST /upload Bearer old", "POST /upload Bearer fresh"],
				parts: [
					{ file: [file], name: ["n"] },
					{ file: [file], name: ["n"] },
				],
				same: true,
				types: [true, true],
				upload: { built: true, out: ["uploaded Some(true) true"] },
			})
		},
		CARGO,
	)
})
