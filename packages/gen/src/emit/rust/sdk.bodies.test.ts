/**
 * The Rust SDK past JSON in and out, executed: one consumer program over the `surface` crate (its edge
 * operations) against the recording server, one section per behavior. A text answer read with its declared
 * response headers through `.with_headers()` (`FromHeaders`); a binary body sent with a fresh v4
 * `Idempotency-Key` and a binary answer; a text body behind six path params (nine parameters, past clippy's
 * argument limit); JSON bodies that are a string or a list; a 401 retried once with `on_auth_expired`'s token
 * for an in-memory body and never for a streamed one; the `<Op>Opts` field types the `Default` rule picks; and
 * a JSON event stream's method.
 */
import { describe, expect, it } from "vitest"
import { consume, once, sections, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

/* cargo builds the crate's dependencies on a cold cache */
const CARGO = 600_000

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Every request the program sends, in order: its section and the reply it gets. */
const SENT: readonly (readonly [section: string, reply: Reply])[] = [
	["headers", { headers: { "x-trace-id": "t-9", "x-version": "7" }, status: 200, text: "report" }],
	["blobs", { bytes: 3, status: 200 }],
	["many", { status: 204 }],
	["borrowed", { status: 204 }],
	["borrowed", { status: 204 }],
	["retried", { json: { error_key: "expired" }, status: 401 }],
	["retried", { bytes: 2, status: 200 }],
	["streamed", { json: { error_key: "expired" }, status: 401 }],
]

/** The program's sections, in the order SENT lists their requests; the last two send none. */
const BODIES = sections({
	headers: `    let opts = sdk::ReportsGetOpts::default();
    let (text, h) = client(base)?.reports().get("r1", &opts).with_headers().await?;
    n.note(format!("{text} {} {:?}", h.x_trace_id, h.x_version));`,
	blobs: `    let body = sdk::Body::from(vec![1u8, 2, 3]);
    let bytes = client(base)?.blobs().upload(body, &sdk::BlobsUploadOpts::default()).await?;
    n.note(format!("{bytes:?}"));`,
	many: `    let opts = sdk::NotesPutOpts::default();
    client(base)?.notes().put("a", "b", "c", "d", "e", "f", "hello", &opts).await?;
    n.note("put");`,
	borrowed: `    let c = client(base)?;
    c.names().echo(&"x".to_owned(), &sdk::NamesEchoOpts::default()).await?;
    c.tags().set(&vec!["a".to_owned(), "b".to_owned()], &sdk::TagsSetOpts::default()).await?;
    n.note("sent");`,
	retried: `    let c = refreshing(base)?;
    let bytes = c.blobs().upload(sdk::Body::from(vec![1u8, 2, 3]), &sdk::BlobsUploadOpts::default()).await?;
    n.note(format!("{bytes:?}"));`,
	streamed: `    let c = refreshing(base)?;
    let chunks = futures_util::stream::iter([Ok::<_, std::io::Error>(bytes::Bytes::from_static(b"abc"))]);
    let r = c.blobs().upload(sdk::Body::from_stream(chunks), &sdk::BlobsUploadOpts::default()).await;
    n.note(format!("{:?}", r.err().and_then(|e| e.status())));`,
	search: `    let o = sdk::SearchRunOpts::default();
    let _: (&String, &sdk::Sort, &sdk::Pick, &sdk::Tags) = (&o.q, &o.sort, &o.pick, &o.tags);
    let _: (&Option<sdk::Filter>, &Option<sdk::Window>, &Option<String>) = (&o.filter, &o.window, &o.cursor);
    n.note("typed");`,
	ticks: `    let opts = sdk::TicksStreamOpts { last_event_id: Some("7".into()), x_tenant: None };
    let _: fn(&sdk::Client, &sdk::TicksStreamOpts) -> sdk::Call<sdk::EventStream<sdk::Tick>> = |c, o| c.ticks().stream(o);
    n.note(format!("typed {:?}", opts.last_event_id));`,
})

/** A client holding the token `old`, which `on_auth_expired` replaces with `fresh`. */
const REFRESHING = `type Refreshed = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>, sdk::Error>> + Send>>;

fn refreshing(base: &str) -> Result<sdk::Client, sdk::Error> {
    let hook: sdk::OnAuthExpiredHook = std::sync::Arc::new(|_| -> Refreshed { Box::pin(async { Ok(Some("fresh".to_owned())) }) });
    sdk::Client::new(sdk::ClientConfig { base_url: base.into(), bearer_token: Some("old".into()), on_auth_expired: Some(hook), ..Default::default() })
}`

/** What a hop sent: its path, its Accept and content type, whether it carried a v4 Idempotency-Key, its body size. */
const sent = (hop: RecordedHop) => ({
	accept: hop.headers.accept,
	authorization: hop.headers.authorization,
	contentType: hop.body.contentType,
	json: hop.body.json,
	key: V4.test(hop.headers["idempotency-key"] ?? ""),
	size: hop.body.size,
	url: `${hop.method} ${hop.url}`,
})

/** The program run once against the recording server at `/v1`, with what each hop sent. */
const bodies = once(() =>
	served(
		SENT.map(([, reply]) => reply),
		async (server) => {
			const run = await consume("surface", "bodies", {
				base: `${server.url}/v1`,
				body: BODIES.body,
				decls: `${REFRESHING}\n\n${BODIES.decls}`,
			})
			return { hops: server.hops.map(sent), run }
		},
	),
)

/** Section `name`: whether it built, its notes, and what its calls sent. */
async function section(name: string) {
	const { hops, run } = await bodies()
	return { observed: { ...seen(run, name), sent: hops.filter((_, i) => SENT[i]?.[0] === name) }, stderr: run.stderr }
}

/** A JSON body's hop: no Accept asked for, its content type and size. */
const json = (url: string, value: unknown) => ({
	accept: "*/*",
	contentType: "application/json",
	json: value,
	key: false,
	size: JSON.stringify(value).length,
	url,
})

/** An upload of `size` bytes, sent with the token `token`. */
const upload = (token: string, size: number) => ({
	accept: "application/octet-stream",
	authorization: `Bearer ${token}`,
	contentType: "application/octet-stream",
	key: true,
	size,
	url: "POST /v1/blobs",
})

describe.skipIf(!RUST)("answers and bodies past JSON", () => {
	it(
		"reads a text answer and its declared response headers through .with_headers()",
		async () => {
			const { observed, stderr } = await section("headers")
			expect(observed, stderr).toEqual({
				built: true,
				out: ["report t-9 Some(7)"],
				sent: [{ accept: "text/plain", contentType: null, key: false, size: 0, url: "GET /v1/reports/r1" }],
			})
		},
		CARGO,
	)

	it(
		"sends a binary body with a fresh v4 Idempotency-Key and reads a binary answer",
		async () => {
			const { observed, stderr } = await section("blobs")
			expect(observed, stderr).toEqual({
				built: true,
				out: ["[0, 1, 2]"],
				sent: [
					{
						accept: "application/octet-stream",
						contentType: "application/octet-stream",
						key: true,
						size: 3,
						url: "POST /v1/blobs",
					},
				],
			})
		},
		CARGO,
	)

	it(
		"takes six path params, a text body and Opts (nine parameters), answering none",
		async () => {
			const { observed, stderr } = await section("many")
			expect(observed, stderr).toEqual({
				built: true,
				out: ["put"],
				sent: [{ accept: "*/*", contentType: "text/plain", key: false, size: 5, url: "PUT /v1/notes/a/b/c/d/e/f" }],
			})
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("a JSON body that is not an object", () => {
	it(
		"takes a JSON body that is a string or a list as &<Type>, as every JSON body",
		async () => {
			const { observed, stderr } = await section("borrowed")
			expect(observed, stderr).toEqual({
				built: true,
				out: ["sent"],
				sent: [json("POST /v1/names", "x"), json("PUT /v1/tags", ["a", "b"])],
			})
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("a 401 with on_auth_expired", () => {
	it(
		"sends an in-memory body again with the refreshed token",
		async () => {
			const { observed, stderr } = await section("retried")
			expect(observed, stderr).toEqual({ built: true, out: ["[0, 1]"], sent: [upload("old", 3), upload("fresh", 3)] })
		},
		CARGO,
	)

	it(
		"never sends a streamed body twice: the 401 is the answer",
		async () => {
			const { observed, stderr } = await section("streamed")
			expect(observed, stderr).toEqual({ built: true, out: ["Some(401)"], sent: [upload("old", 3)] })
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("the Opts and stream types a method takes", () => {
	it(
		"types a required query param bare when it has a Default, else as an Option",
		async () => {
			const { observed, stderr } = await section("search")
			expect(observed, stderr).toEqual({ built: true, out: ["typed"], sent: [] })
		},
		CARGO,
	)

	it(
		"answers a JSON event stream as EventStream<T>, its Last-Event-ID header the stream's own field",
		async () => {
			const { observed, stderr } = await section("ticks")
			expect(observed, stderr).toEqual({ built: true, out: ['typed Some("7")'], sent: [] })
		},
		CARGO,
	)
})
