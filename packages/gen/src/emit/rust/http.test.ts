/**
 * The Rust SDK's request build, executed (contract 19 §5.1; the Go `http.test.ts` analog): path params escaped
 * as one segment each in path order and refused when no segment can hold them, the base URL's path kept, query
 * arrays repeated and bracketed names escaped, an empty map sending nothing (Fc6), X-Request-Id, urlencoded
 * and multipart bodies (Fc7 `FilePart`), a body copied at once, the idempotency key across an auth retry, and
 * one value per header with the credential last (Fc1). Driven through the `http` registry SDK's driver
 * against the recording server; what only the compiler proves runs in the `requests` consumer program.
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/compiled.ts"
import { consume, once, sections, seen } from "./__fixtures__/consumer.ts"
import { FIXTURES } from "./__fixtures__/documents.ts"
import { withRust } from "./__fixtures__/rust-env.ts"
import { rustCallPlans } from "./sdk.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

/* cargo builds the crate's dependencies on a cold cache */
const CARGO = 600_000

const member = (params: Readonly<Record<string, string>>, extra: Partial<Call> = {}): Call => ({
	operation: "members.get",
	params,
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
	...extra,
})
const AT = { org: "o", "user-id": "u" }
const PING: Call = { operation: "health.ping", route: { method: "GET", path: "/ping" } }
const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const ORDER: Call = {
	body: { kind: "json", value: { sku: "s" } },
	operation: "orders.create",
	route: { method: "POST", path: "/orders" },
}

const FOUND: Reply = { json: { id: "u", name: "n" }, status: 200 }
const DATA = { data: { id: "u", name: "n" }, kind: "data", status: 200 } satisfies Observed
const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 } satisfies Observed
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

const sdks = new Map<"http" | "surface", DrivenRustSdk>()
/** The registry SDK `key` compiled with the driver once, which must build. */
function driven(key: "http" | "surface"): DrivenRustSdk {
	const sdk = sdks.get(key) ?? drivenRustSdk(key)
	sdks.set(key, sdk)
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

type Options = {
	readonly base?: (url: string) => string
	readonly key?: "http" | "surface"
	readonly script?: Script
	readonly setup?: Setup
}

/** `calls` run against a server answering `replies`, the client aimed at `base(server.url)`: the run, its hops, their raw header lines and bodies. */
function drive(replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven(options.key ?? "http")
	return served(replies, async (server) => {
		const origins = { alt: server.alt, url: (options.base ?? ((url: string) => url))(server.url) }
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, origins, options.script)
		return { bodies: [...server.bodies], hops: [...server.hops], raw: [...server.rawHeaders], run }
	})
}

/** A Rust error as the trace records it: no source and the method's own Err unless given, any Debug text. */
const plain = (entry: Partial<RustError>) => ({ debug: expect.any(String), source: false, via: "return", ...entry })

/** The trace of a `user-id` value refused as a path segment (`path.rs`). */
const refused = plain({
	text: 'path param: "user-id" is empty, "." or "..", which no path segment can be',
	variant: "PathParam",
})

describe("the call plan: path params in path order", () => {
	// v0: 5770bf39ca
	it("names members.get's path params in path order, not the declared [user-id, org]", () => {
		expect(rustCallPlans(FIXTURES.http.document(), {})["members.get"]?.pathParams).toEqual(["org", "user-id"])
	})
})

describe.skipIf(!RUST)("path params: each value escaped as one segment, in path order", () => {
	// v0: 97cf38a8fe
	// v0: 5770bf39ca
	it(
		"sends a slash, a space, a non-ASCII char and a question mark escaped, the path filled in path order",
		async () => {
			const { hops, run } = await drive([FOUND], [member({ org: "a/b c", "user-id": "ü?1" })])
			expect({ hops: hops.map((h) => `${h.method} ${h.url}`), observed: run.observed }, run.stderr).toEqual({
				hops: ["GET /orgs/a%2Fb%20c/users/%C3%BC%3F1"],
				observed: [DATA],
			})
		},
		CARGO,
	)

	// v0: 876d9e16dc
	it(
		"refuses an empty, a dot and a dot-dot value as PathParam, nothing sent; a value holding them is escaped",
		async () => {
			const calls = ["", ".", "..", "../x"].map((value) => member({ org: "ok", "user-id": value }))
			const { hops, run } = await drive([FOUND], calls, { script: {} })
			expect(
				{ errors: run.trace?.calls.map((c) => c.error), hops: hops.map((h) => h.url), observed: run.observed },
				run.stderr,
			).toEqual({
				errors: [refused, refused, refused, undefined],
				hops: ["/orgs/ok/users/..%2Fx"],
				observed: [null, null, null, DATA],
			})
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("the base URL: its path is kept, a trailing slash never doubled", () => {
	// v0: c424958b5c
	it(
		"prefixes every request with the base path, with or without a trailing slash",
		async () => {
			const bases = [(url: string) => `${url}/api`, (url: string) => `${url}/api/`]
			const runs = await Promise.all(bases.map((base) => drive([FOUND], [member(AT)], { base })))
			expect(runs.map(({ hops, run }) => ({ hops: hops.map((h) => h.url), observed: run.observed }))).toEqual([
				{ hops: ["/api/orgs/o/users/u"], observed: [DATA] },
				{ hops: ["/api/orgs/o/users/u"], observed: [DATA] },
			])
		},
		CARGO,
	)
})

describe.skipIf(!RUST)(
	"query params: arrays repeated, nullable and bracketed names sent, nothing set sends no query",
	() => {
		// v0: a9d81812d8
		// v0: 117dfc9b9c
		// v0: a1c45da195
		it(
			"sends ids once per item, page[size] escaped, maybe unquoted, and no '?' without a value",
			async () => {
				const calls = [
					member(AT, { search: { ids: ["a", "b"], "page[size]": 5 } }),
					member(AT, { search: { maybe: "foo" } }),
					member(AT),
				]
				const { hops, run } = await drive([FOUND, FOUND, FOUND], calls)
				expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
					hops: ["/orgs/o/users/u?ids=a&ids=b&page%5Bsize%5D=5", "/orgs/o/users/u?maybe=foo", "/orgs/o/users/u"],
					observed: [DATA, DATA, DATA],
				})
			},
			CARGO,
		)

		it(
			"sends nothing for a required map left empty, as for an empty list (Fc6); an empty required string stays q=",
			async () => {
				const search: Call = { operation: "search.run", route: { method: "GET", path: "/search" } }
				const { hops, run } = await drive([{ json: [], status: 200 }], [search], { key: "surface" })
				expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
					hops: ["/search?pick=a&q=&sort=asc"],
					observed: [{ data: [], kind: "data", status: 200 }],
				})
			},
			CARGO,
		)
	},
)

describe.skipIf(!RUST)("X-Request-Id: a fresh UUIDv4 per request unless the config or the call sets one", () => {
	// v0: 3d145530bf
	it(
		"sends two distinct UUIDv4s then the call's own; a config value, then a call value over it",
		async () => {
			const own = (value: string): Call => ({ ...PING, headers: { "x-request-id": value } })
			const [fresh, configured] = await Promise.all([
				drive([OK, OK, OK], [PING, PING, own("call-1")]),
				drive([OK, OK], [PING, own("call-2")], { setup: { headers: { "X-Request-Id": "cfg-1" } } }),
			])
			const ids = fresh.hops.map((h) => h.headers["x-request-id"])
			expect(
				{
					configured: configured.hops.map((h) => h.headers["x-request-id"]),
					fresh: ids,
					observed: [fresh.run.observed, configured.run.observed],
				},
				fresh.run.stderr + configured.run.stderr,
			).toEqual({
				configured: ["cfg-1", "call-2"],
				fresh: [expect.stringMatching(V4), expect.stringMatching(V4), "call-1"],
				observed: [
					[OK_DATA, OK_DATA, OK_DATA],
					[OK_DATA, OK_DATA],
				],
			})
			expect(ids[0]).not.toBe(ids[1])
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("an urlencoded body: its fields form-encoded under their content type", () => {
	// v0: 8a4a4d9c1f
	it(
		"sends forms.submit's typed body as name=form-value with application/x-www-form-urlencoded",
		async () => {
			const submit: Call = {
				body: { kind: "json", value: { name: "form-value" } },
				operation: "forms.submit",
				route: { method: "POST", path: "/form" },
			}
			const { bodies, hops, run } = await drive([OK], [submit])
			expect({ bodies: bodies.map(String), observed: run.observed, sent: hops.map((h) => h.body) }, run.stderr).toEqual(
				{
					bodies: ["name=form-value"],
					observed: [OK_DATA],
					sent: [{ contentType: "application/x-www-form-urlencoded", sha256: sha256("name=form-value"), size: 15 }],
				},
			)
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("Idempotency-Key: an idempotent operation always sends one, stable across an auth retry", () => {
	it(
		"sends a fresh UUIDv4, then the Opts key, a per-call header over it, the same key on a retry, none on a plain op",
		async () => {
			const script: Script = {
				calls: [null, { idempotencyKey: "opt-k" }, { idempotencyKey: "opt-k2" }],
				onAuthExpired: { tokens: ["new"] },
			}
			const created: Reply = { json: { id: "o1" }, status: 201 }
			const calls = [ORDER, ORDER, { ...ORDER, headers: { "Idempotency-Key": "call-k" } }, ORDER, PING]
			const setup: Setup = { auth: { kind: "bearer", token: "old" } }
			const replies = [{ status: 401 }, created, created, created, created, OK]
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
				keys: [expect.stringMatching(V4), keys[0], "opt-k", "call-k", expect.stringMatching(V4), undefined],
				observed: [order, order, order, order, OK_DATA],
			})
			expect(keys[4]).not.toBe(keys[0])
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("headers: one value per name, merged case-insensitively, the credential last (Fc1)", () => {
	// v0: bca1100ff2
	it(
		"sends one authorization and one x-both: the call's x-both over the config's, the bearer over both layers",
		async () => {
			const setup: Setup = {
				auth: { kind: "bearer", token: "tok" },
				headers: { authorization: "Bearer cfg", "x-both": "1" },
			}
			const calls: Call[] = [
				{ ...ECHO, headers: { "X-Both": "2" } },
				{ ...ECHO, headers: { Authorization: "Bearer call" } },
			]
			const { hops, raw, run } = await drive([OK, OK], calls, { setup })
			/* req.headers keeps one of a repeated authorization: the raw lines show a duplicate credential */
			const lines = raw.map((pairs) =>
				["authorization", "x-both"].map((n) => pairs.filter(([name]) => name === n).length),
			)
			expect(
				{ lines, observed: run.observed, sent: hops.map((h) => [h.headers.authorization, h.headers["x-both"]]) },
				run.stderr,
			).toEqual({
				lines: [
					[1, 1],
					[1, 1],
				],
				observed: [OK_DATA, OK_DATA],
				sent: [
					["Bearer tok", "2"],
					["Bearer tok", "1"],
				],
			})
		},
		CARGO,
	)
})

/** The `requests` program's sections, in the order SENT lists their requests. */
const REQUESTS = sections({
	typed: `    let c = client(base)?;
    let o = sdk::MembersGetOpts { ids: Some(vec!["a".into(), "b".into()]), maybe: Some("m".into()), page_size: Some(3) };
    let m = c.members().get("o", "u", &o).await?;
    n.note(format!("{} {}", m.id, m.name));
    let m = c.members().get("o", "u", &sdk::MembersGetOpts::default()).await?;
    n.note(format!("{} {}", m.id, m.name));`,
	multipart: `    let c = client(base)?;
    let o = sdk::FilesUploadOpts::default();
    let file = sdk::FilePart { filename: "a.txt".into(), content_type: Some("text/plain".into()), data: b"hello".to_vec() };
    let with = sdk::FilesUploadBody { file: Some(file), name: Some("multipart-value".into()), tags: vec!["a".into(), "b".into()] };
    let r = c.files().upload(&with, &o).await?;
    n.note(if r.ok == Some(true) { "upload ok" } else { "upload refused" });
    let without = sdk::FilesUploadBody { name: Some("multipart-value".into()), ..Default::default() };
    let r = c.files().upload(&without, &o).await?;
    n.note(if r.ok == Some(true) { "upload ok" } else { "upload refused" });
    let files = vec![
        sdk::FilePart { filename: "a.txt".into(), content_type: Some("text/plain".into()), data: b"A".to_vec() },
        sdk::FilePart { filename: "b.bin".into(), content_type: None, data: b"B".to_vec() },
    ];
    let meta = Some(sdk::FilesBatchBodyMeta { k: Some(1) });
    let b = sdk::FilesBatchBody { count: Some(3), files, flags: vec![true, false], meta };
    let _: (&Option<i64>, &Vec<sdk::FilePart>, &Vec<bool>, &Option<sdk::FilesBatchBodyMeta>) = (&b.count, &b.files, &b.flags, &b.meta);
    let r = c.files().batch(&b, &sdk::FilesBatchOpts::default()).await?;
    n.note(if r.ok == Some(true) { "batch ok" } else { "batch refused" });`,
	owned: `    let c = client(base)?;
    let b = sdk::FilesUploadBody { name: Some("x".into()), ..Default::default() };
    let call = c.files().upload(&b, &sdk::FilesUploadOpts::default());
    drop(b);
    call.await?;
    let body = sdk::UsersCreateBody { name: Some("owned".into()) };
    let call = c.users().create(&body, &sdk::UsersCreateOpts::default());
    drop(body);
    call.await?;
    fn spawnable<T: Send + 'static>(_: T) {}
    let body = sdk::UsersCreateBody { name: Some("never sent".into()) };
    spawnable(c.users().create(&body, &sdk::UsersCreateOpts::default()));
    n.note("owned");`,
})

/** Every request the `requests` program sends, in order: its section and the reply it gets. */
const SENT: readonly (readonly [section: string, reply: Reply])[] = [
	["typed", FOUND],
	["typed", FOUND],
	["multipart", OK],
	["multipart", OK],
	["multipart", OK],
	["owned", OK],
	["owned", { json: { id: "u1" }, status: 200 }],
]

/** A hop as one line: method, path and query, the JSON body when it has one. */
const wire = (hop: RecordedHop) =>
	[hop.method, hop.url, ...(hop.body.json === undefined ? [] : [JSON.stringify(hop.body.json)])].join(" ")

/** The `requests` program run once against the recording server, with every hop and its raw body. */
const requests = once(() =>
	served(
		SENT.map(([, reply]) => reply),
		async (server) => {
			const run = await consume("http", "requests", { base: server.url, ...REQUESTS })
			return { bodies: [...server.bodies], hops: [...server.hops], run }
		},
	),
)

/** Section `name` of the `requests` program: its notes, and the hops and raw bodies its calls sent. */
async function section(name: string) {
	const { bodies, hops, run } = await requests()
	const own = (_: unknown, i: number) => SENT[i]?.[0] === name
	return { bodies: bodies.filter(own), hops: hops.filter(own), observed: seen(run, name), stderr: run.stderr }
}

/** A multipart body as a server's form parser reads it. */
const formOf = (body: Buffer, hop: RecordedHop | undefined) =>
	new Response(new Uint8Array(body), { headers: { "content-type": hop?.body.contentType ?? "" } }).formData()

/** An upload's parts as a server reads them: the file part, the name and tags parts. */
async function upload(body: Buffer, hop: RecordedHop | undefined) {
	const form = await formOf(body, hop)
	const file = form.get("file")
	return {
		file: file instanceof File ? { name: file.name, text: await file.text(), type: file.type } : file,
		name: form.getAll("name"),
		tags: form.getAll("tags"),
	}
}

describe.skipIf(!RUST)("the typed Opts: a query field per param, its wire name escaped", () => {
	// v0: a1c45da195
	// v0: 5770bf39ca
	it(
		"takes org then user_id as &str and MembersGetOpts { ids, maybe, page_size }, sending each set one",
		async () => {
			const { hops, observed, stderr } = await section("typed")
			expect({ ...observed, wire: hops.map(wire) }, stderr).toEqual({
				built: true,
				out: ["u n", "u n"],
				wire: ["GET /orgs/o/users/u?ids=a&ids=b&maybe=m&page%5Bsize%5D=3", "GET /orgs/o/users/u"],
			})
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("a multipart body: FilePart files in memory, a text part per value (Fc7)", () => {
	// v0: 922cb1f340
	it(
		"sends a file part, a text part, one part per list item, and no part for None or an empty list",
		async () => {
			const { bodies, hops, observed, stderr } = await section("multipart")
			expect({ ...observed, wire: hops.map(wire) }, stderr).toEqual({
				built: true,
				out: ["upload ok", "upload ok", "batch ok"],
				wire: ["POST /upload", "POST /upload", "POST /batch"],
			})
			expect(hops.map((h) => h.body.contentType)).toEqual(
				hops.map(() => expect.stringMatching(/^multipart\/form-data; boundary=honey-/)),
			)
			const uploads = await Promise.all(bodies.slice(0, 2).map((body, i) => upload(body, hops[i])))
			expect(uploads).toEqual([
				{ file: { name: "a.txt", text: "hello", type: "text/plain" }, name: ["multipart-value"], tags: ["a", "b"] },
				{ file: null, name: ["multipart-value"], tags: [] },
			])
		},
		CARGO,
	)

	it(
		"types a batch's count Option<i64>, files Vec<FilePart>, flags Vec<bool> and meta as JSON text, a file with no type octet-stream",
		async () => {
			const { bodies, hops, observed, stderr } = await section("multipart")
			expect(observed, stderr).toEqual({ built: true, out: ["upload ok", "upload ok", "batch ok"] })
			const form = await formOf(bodies[2] ?? Buffer.alloc(0), hops[2])
			const files = await Promise.all(
				form.getAll("files").map(async (f) => (f instanceof File ? [f.name, f.type, await f.text()] : f)),
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
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("a body copied at once: the Call owns what it sends", () => {
	it(
		"sends a multipart and a JSON body dropped before the await, and a Call is Send + 'static",
		async () => {
			const { bodies, hops, observed, stderr } = await section("owned")
			expect({ ...observed, wire: hops.map(wire) }, stderr).toEqual({
				built: true,
				out: ["owned"],
				wire: ["POST /upload", 'POST /users {"name":"owned"}'],
			})
			expect(await upload(bodies[0] ?? Buffer.alloc(0), hops[0])).toEqual({ file: null, name: ["x"], tags: [] })
		},
		CARGO,
	)
})
