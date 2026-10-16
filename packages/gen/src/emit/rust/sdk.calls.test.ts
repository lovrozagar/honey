/**
 * The Rust SDK's call surface, executed (contract 18 §8.5): one consumer program over the `surface` crate
 * calls every shape of method against the recording server, one section per behavior, and each test reads
 * its section's notes and the wire lines its calls sent. The method surface (G1: accessors from IR.tree,
 * path params as `&str` in path order, the typed body, then Opts), the owning `Call` builder (Fb1), the
 * crate-root re-exports, `Client::new`'s servers[0] default and `Error::Config`, and throwOnError's two
 * return shapes are each proven by a program that builds and runs, or by one that must not build.
 */
import { describe, expect, it } from "vitest"
import { consume, once, sections, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

/* cargo builds the crate's dependencies on a cold cache */
const CARGO = 600_000

/** A hop as one line: method, path and query, the x-trace header when sent, the JSON body when sent. */
const wire = (hop: RecordedHop) =>
	[
		hop.method,
		hop.url,
		...(hop.headers["x-trace"] === undefined ? [] : [`x-trace=${hop.headers["x-trace"]}`]),
		...(hop.body.json === undefined ? [] : [JSON.stringify(hop.body.json)]),
	].join(" ")

const OK: Reply = { json: {}, status: 200 }
const NONE: Reply = { json: [], status: 200 }
const USER = { id: "u1", name: "Ada" }
/** long past the call's own 100 ms timeout or cancel signal */
const STALLED: Reply = { delayMs: 5_000, json: [], status: 200 }

/** The `calls` section the program runs last: any hop past SENT is its. */
const LAST = "call"

/** Every request the `calls` program sends, in order: its section, its wire line, the reply it gets (200 `{}` when none). */
const SENT: readonly (readonly [section: string, wire: string, reply?: Reply])[] = [
	["crud", 'POST /v1/users {"name":"Ada"}', { json: USER, status: 200 }],
	[
		"order",
		'POST /v1/orgs/a%2Fb%20c/members/m%3F1/notes?tag=t x-trace=t-1 {"tags":["a"],"text":"hi"}',
		{ json: { id: "n1", text: "hi" }, status: 200 },
	],
	["nested", 'POST /v1/checkout/sessions {"cart":"c1"}', { json: { id: "s1" }, status: 200 }],
	["mixed", "GET /v1/users", { json: [{ id: "u1" }, { id: "u2" }], status: 200 }],
	["mixed", 'PATCH /v1/users/u1/profile {"bio":"hi"}', { json: { id: "u1" }, status: 200 }],
	["root", "GET /v1/users/u1", { json: USER, status: 200 }],
	["keywords", 'POST /v1/types {"id":"t1"}'],
	["keywords", "GET /v1/matches", NONE],
	["keywords", "POST /v1/fn/run"],
	["keywords", 'POST /v1/table-templates/t1/use {"id":"t1"}'],
	["keywords", "GET /v1/types/t1"],
	["keywords", "GET /v1/keywords/s1/o1/u1"],
	["models", "GET /v1/config", { json: { code: "E1" }, status: 200 }],
	["derived", "DELETE /v1/nothing/n1"],
	["required-enum", "GET /v1/exports?format=csv", { json: ["a", "b"], status: 200 }],
	["query", "GET /v1/items?limit=3", { json: [{ id: "i1" }], status: 200 }],
	[LAST, "GET /v1/users x-trace=a", NONE],
	[LAST, "GET /v1/users", NONE],
	[LAST, "GET /v2/users", NONE],
	[LAST, "GET /v1/users", STALLED],
	[LAST, "GET /v1/users", STALLED],
	[LAST, "GET /v1/users x-trace=s", NONE],
	[LAST, "GET /v1/users", NONE],
	[LAST, "GET /v1/users", { headers: { "x-version": "7" }, json: [], status: 200 }],
]

/** The `calls` program's sections, in the order SENT lists their requests. */
const CALLS = sections({
	crud: `    let r: Result<sdk::User, sdk::Error> = client(base)?
        .users()
        .create(&sdk::UserCreateInput { name: "Ada".into() }, &sdk::UsersCreateOpts::default())
        .await;
    n.note(format!("created {}", r?.id));`,
	order: `    let body = sdk::NoteInput { tags: Some(vec!["a".into()]), text: "hi".into() };
    let opts = sdk::OrgsMembersNotesCreateOpts { tag: Some("t".into()), x_trace: Some("t-1".into()), ..Default::default() };
    let note = client(base)?.orgs().members().notes().create("a/b c", "m?1", &body, &opts).await?;
    n.note(format!("{} {}", note.id, note.text));`,
	nested: `    let input = sdk::SessionInput { cart: Some("c1".into()) };
    let session = client(base)?.checkout().sessions().create(&input, &sdk::CheckoutSessionsCreateOpts::default()).await?;
    n.note(session.id);`,
	mixed: `    let c = client(base)?;
    let users = c.users().list(&sdk::UsersListOpts::default()).await?;
    n.note(format!("listed {}", users.len()));
    let input = sdk::ProfileInput { bio: Some("hi".into()) };
    let user = c.users().profile().update("u1", &input, &sdk::UsersProfileUpdateOpts::default()).await?;
    n.note(format!("updated {}", user.id));`,
	root: `    let user: sdk::User = client(base)?.get_user("u1", &sdk::GetUserOpts::default()).await?;
    n.note(format!("{} {}", user.id, user.name.unwrap_or_default()));`,
	keywords: `    let c = client(base)?;
    let t = sdk::Template { id: Some("t1".into()) };
    c.r#type().create(&t, &sdk::TypeCreateOpts::default()).await?;
    c.r#match().find(&sdk::MatchFindOpts::default()).await?;
    c.r#fn().run(&sdk::FnRunOpts::default()).await?;
    c.table_templates().r#use("t1", &t, &sdk::TableTemplatesUseOpts::default()).await?;
    c.get_by_type("t1", &sdk::GetByTypeOpts::default()).await?;
    c.keywords().params("s1", "o1", "u1", &sdk::KeywordsParamsOpts::default()).await?;
    n.note("6 called");`,
	models: `    let _ = (sdk::ClientModel { id: None }, sdk::OptionModel { id: None }, sdk::ResultModel { id: None });
    let model: sdk::ErrorModel = client(base)?.config().get(&sdk::ConfigGetOpts::default()).await?;
    n.note(model.code.unwrap_or_default());`,
	derived: `    client(base)?.delete_nothing_by_id("n1", &sdk::DeleteNothingByIdOpts::default()).await?;
    n.note("deleted");`,
	"required-enum": `    let rows = client(base)?.exports().list(&sdk::ExportsListOpts::default()).await?;
    n.note(rows.join(","));`,
	query: `    let q: Option<String> = sdk::ItemsListOpts::default().q;
    let opts = sdk::ItemsListOpts { limit: Some(3), ..Default::default() };
    let items = client(base)?.items().list(&opts).await?;
    n.note(format!("{} {}", q.is_none(), items.iter().map(|i| i.id.as_str()).collect::<Vec<_>>().join(",")));`,
	exports: `    let _: fn(ClientConfig) -> Result<Client, Error> = Client::new;
    let _: Option<Call<sdk::User>> = None;
    let _: Option<SdkResult<sdk::User>> = None;
    n.note("imported");`,
	new: `    n.note(format!("default {}", sdk::Client::new(sdk::ClientConfig::default()).is_ok()));
    let config = sdk::ClientConfig { base_url: "not a url?api_key=s3cret".into(), ..Default::default() };
    match sdk::Client::new(config) {
        Err(e @ sdk::Error::Config(_)) => {
            let text = e.to_string();
            n.note(format!("config {} {}", text.contains("base_url"), text.contains("s3cret")));
        }
        Err(e) => n.note(format!("other {e}")),
        Ok(_) => n.note("built"),
    }`,
	[LAST]: `    let c = client(base)?;
    let o = sdk::UsersListOpts::default();
    c.users().list(&o).header("x-trace", "a").await?;
    c.users().list(&o).await?;
    c.users().list(&o).base_url(base.replace("/v1", "/v2")).await?;
    let timed = c.users().list(&o).timeout(std::time::Duration::from_millis(100)).await;
    n.note(format!("timeout {}", matches!(timed, Err(sdk::Error::Timeout))));
    let signal = tokio::time::sleep(std::time::Duration::from_millis(100));
    let canceled = c.users().list(&o).cancel_on(signal).await;
    n.note(format!("canceled {}", matches!(canceled, Err(sdk::Error::Canceled))));
    let spawned = tokio::spawn(c.users().list(&o).header("x-trace", "s").into_future()).await;
    n.note(format!("spawned {}", matches!(spawned, Ok(Ok(_)))));
    let owned = {
        let c = client(base)?;
        let o = sdk::UsersListOpts::default();
        c.users().list(&o)
    };
    n.note(format!("owned {}", owned.await?.len()));
    let (_, raw) = c.users().list(&o).with_response().await?;
    let version = raw.headers.get("x-version").and_then(|v| v.to_str().ok()).unwrap_or("-");
    n.note(format!("raw {} {}", raw.status, version));`,
})

/** The `calls` program run once against the recording server at `/v1`, with every hop as a wire line. */
const calls = once(() =>
	served(
		SENT.map(([, , reply]) => reply ?? OK),
		async (server) => {
			const imports = ["sdk::{Call, Client, ClientConfig, Error, SdkResult}", "std::future::IntoFuture"]
			const run = await consume("surface", "calls", { base: `${server.url}/v1`, imports, ...CALLS })
			return { hops: server.hops.map(wire), run }
		},
	),
)

/** Section `name` of the `calls` program: whether it built, its notes, and the wire lines its calls sent. */
async function section(name: string) {
	const { hops, run } = await calls()
	const own = hops.filter((_, i) => (SENT[i]?.[0] ?? LAST) === name)
	return { observed: { ...seen(run, name), wire: own }, stderr: run.stderr }
}

describe.skipIf(!RUST)("methods: an accessor per namespace, path params in path order, body, Opts", () => {
	// v0: 7ffc3f3922
	it(
		"calls users.create as client.users().create, resolving Result<User, Error>",
		async () => {
			const { observed, stderr } = await section("crud")
			expect(observed, stderr).toEqual({ built: true, out: ["created u1"], wire: ['POST /v1/users {"name":"Ada"}'] })
		},
		CARGO,
	)

	// v0: be0d239043
	it(
		"takes the path params in path order as &str, then the typed body, then Opts",
		async () => {
			const { observed, stderr } = await section("order")
			expect(observed, stderr).toEqual({
				built: true,
				out: ["n1 hi"],
				wire: ['POST /v1/orgs/a%2Fb%20c/members/m%3F1/notes?tag=t x-trace=t-1 {"tags":["a"],"text":"hi"}'],
			})
		},
		CARGO,
	)

	// v0: db955c286c
	it(
		"reaches a three-level id through one accessor per namespace",
		async () => {
			const { observed, stderr } = await section("nested")
			expect(observed, stderr).toEqual({
				built: true,
				out: ["s1"],
				wire: ['POST /v1/checkout/sessions {"cart":"c1"}'],
			})
		},
		CARGO,
	)

	// v0: b2e5dd40b6
	it(
		"exposes a namespace's own methods beside its child namespace's accessor",
		async () => {
			const { observed, stderr } = await section("mixed")
			expect(observed, stderr).toEqual({
				built: true,
				out: ["listed 2", "updated u1"],
				wire: ["GET /v1/users", 'PATCH /v1/users/u1/profile {"bio":"hi"}'],
			})
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("names: Client's own operations, keywords, runtime-named components", () => {
	// v0: 752945e1e9
	it(
		"puts a single-segment id on Client itself",
		async () => {
			const { observed, stderr } = await section("root")
			expect(observed, stderr).toEqual({ built: true, out: ["u1 Ada"], wire: ["GET /v1/users/u1"] })
		},
		CARGO,
	)

	// v0: 2c0cbbc0ad
	// v0: 2777cd92ec
	// v0: bf7ce14837
	it(
		"calls keyword resources and actions as raw identifiers, binding keyword and reserved path params in order",
		async () => {
			const { observed, stderr } = await section("keywords")
			expect(observed, stderr).toEqual({
				built: true,
				out: ["6 called"],
				wire: [
					'POST /v1/types {"id":"t1"}',
					"GET /v1/matches",
					"POST /v1/fn/run",
					'POST /v1/table-templates/t1/use {"id":"t1"}',
					"GET /v1/types/t1",
					"GET /v1/keywords/s1/o1/u1",
				],
			})
		},
		CARGO,
	)

	// v0: 6e428e7a5a
	it(
		"renames components named like runtime or prelude types to <Name>Model, returned by their operation",
		async () => {
			const { observed, stderr } = await section("models")
			expect(observed, stderr).toEqual({ built: true, out: ["E1"], wire: ["GET /v1/config"] })
		},
		CARGO,
	)

	// v0: b4d6166ec6
	it(
		"calls an operation without an operationId by its derived id",
		async () => {
			const { observed, stderr } = await section("derived")
			expect(observed, stderr).toEqual({ built: true, out: ["deleted"], wire: ["DELETE /v1/nothing/n1"] })
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("<Op>Opts and the crate root, called from a consumer program", () => {
	// v0: 97a3ddfaf3
	it(
		"builds Opts with a required enum query by Default, sending its first value",
		async () => {
			const { observed, stderr } = await section("required-enum")
			expect(observed, stderr).toEqual({ built: true, out: ["a,b"], wire: ["GET /v1/exports?format=csv"] })
		},
		CARGO,
	)

	// v0: 19a81860b5
	it(
		"carries optional query params as Option fields on <Op>Opts, sending only the ones set",
		async () => {
			const { observed, stderr } = await section("query")
			expect(observed, stderr).toEqual({ built: true, out: ["true i1"], wire: ["GET /v1/items?limit=3"] })
		},
		CARGO,
	)

	// v0: 9f0898fad1
	it(
		"re-exports Call, Client, ClientConfig, Error and SdkResult at the crate root",
		async () => {
			const { observed, stderr } = await section("exports")
			expect(observed, stderr).toEqual({ built: true, out: ["imported"], wire: [] })
		},
		CARGO,
	)
})

/** The `surface` crate with `decls` beside a body that only notes, built as program `name`: its build outcome. */
const refused = (name: string, decls: string) => consume("surface", name, { body: 'n.note("built");', decls })

describe.skipIf(!RUST)("Call: the owning per-call builder a method returns", () => {
	it(
		"applies .header and .base_url to that call alone, ends on .timeout and .cancel_on, spawns, owns its arguments and reads the raw response",
		async () => {
			const { observed, stderr } = await section(LAST)
			expect(observed, stderr).toEqual({
				built: true,
				out: ["timeout true", "canceled true", "spawned true", "owned 0", "raw 200 7"],
				wire: SENT.filter(([s]) => s === LAST).map(([, line]) => line),
			})
		},
		CARGO,
	)

	it(
		"refuses .with_headers() at compile time on an operation with no declared response headers",
		async () => {
			const run = await refused(
				"undeclared",
				"async fn undeclared(c: &sdk::Client) {\n    let _ = c.users().list(&sdk::UsersListOpts::default()).with_headers().await;\n}",
			)
			expect({ built: run.built, refused: /error\[E0599\][^\n]*`with_headers`/.test(run.stderr) }, run.stderr).toEqual({
				built: false,
				refused: true,
			})
		},
		CARGO,
	)

	it(
		"is #[must_use]: a Call never awaited is the unused_must_use lint",
		async () => {
			const run = await refused(
				"unawaited",
				"#[deny(unused_must_use)]\nfn unawaited(c: &sdk::Client) {\n    c.users().list(&sdk::UsersListOpts::default());\n}",
			)
			expect(
				{ built: run.built, refused: /error: unused `Call` that must be used/.test(run.stderr) },
				run.stderr,
			).toEqual({ built: false, refused: true })
		},
		CARGO,
	)
})

describe.skipIf(!RUST)("Client::new: servers[0] by default, Error::Config without a usable base_url", () => {
	it(
		"builds from ClientConfig::default() on servers[0], and refuses a malformed base_url naming the field, never its value",
		async () => {
			const { observed, stderr } = await section("new")
			expect(observed, stderr).toEqual({ built: true, out: ["default true", "config true false"], wire: [] })
		},
		CARGO,
	)

	it(
		"refuses ClientConfig::default() for a document with no servers, naming base_url",
		async () => {
			const run = await consume("types", "serverless", {
				...sections({
					new: `    match sdk::Client::new(sdk::ClientConfig::default()) {
        Err(e @ sdk::Error::Config(_)) => n.note(format!("config {}", e.to_string().contains("base_url"))),
        Err(e) => n.note(format!("other {e}")),
        Ok(_) => n.note("built"),
    }`,
				}),
			})
			expect(seen(run, "new"), run.stderr).toEqual({ built: true, out: ["config true"] })
		},
		CARGO,
	)

	it(
		"refuses ClientConfig::default() for a relative first server, naming base_url, and builds on an absolute one",
		async () => {
			const run = await consume("relative", "relative", {
				...sections({
					new: `    match sdk::Client::new(sdk::ClientConfig::default()) {
        Err(e @ sdk::Error::Config(_)) => n.note(format!("config {}", e.to_string().contains("base_url"))),
        Err(e) => n.note(format!("other {e}")),
        Ok(_) => n.note("built"),
    }
    n.note(format!("absolute {}", client(base).is_ok()));`,
				}),
			})
			expect(seen(run, "new"), run.stderr).toEqual({ built: true, out: ["config true", "absolute true"] })
		},
		CARGO,
	)
})

/** An error-keys users.create twice, typed `result`: a 400 envelope, then the 201 user; `show` notes each. */
const createTwice = (result: string, show: string) => `    let c = client(base)?;
    for _ in 0..2 {
        let body = serde_json::from_value(serde_json::json!({ "email": "a@x.test" })).expect("body");
        let r: ${result} = c.error_keys().users().create(&body, &Default::default()).await;
        ${show}
    }`

const ENVELOPE = {
	error_key: "email_taken",
	fields: {},
	message: "taken",
	status: 400,
	status_key: "bad_request",
	success: false,
}

/** The merged `fixtures` document's crate in `key`'s mode, with `fns` run once against the recording server. */
const errorKeys = (key: "fixtures" | "fixtures-safe", fns: Readonly<Record<string, string>>) =>
	served(
		[
			{ json: ENVELOPE, status: 400 },
			{ json: { email: "a@x.test", id: "u1" }, status: 201 },
		],
		async (server) => {
			const run = await consume(key, key === "fixtures" ? "thrown" : "safe", { base: server.url, ...sections(fns) })
			return { hops: server.hops.map(wire), run }
		},
	)

describe.skipIf(!RUST)("throwOnError, chosen at generation", () => {
	// v0: 2c4d54394e
	it(
		"resolves Result<T, Error> by default, an error status as Error::Api; Result<SdkResult<T>, Error> with throwOnError false",
		async () => {
			const thrown = await errorKeys("fixtures", {
				main: createTwice(
					"Result<sdk::ErrorKeysUser, sdk::Error>",
					`match r {
            Ok(user) => n.note(format!("ok {}", user.id)),
            Err(sdk::Error::Api(e)) => n.note(format!("api {}", e.status)),
            Err(e) => return Err(e),
        }`,
				),
			})
			const safe = await errorKeys("fixtures-safe", {
				main: createTwice(
					"Result<sdk::SdkResult<sdk::ErrorKeysUser>, sdk::Error>",
					`let r = r?;
        match &r.error {
            Some(e) => n.note(format!("error {}", e.status)),
            None => n.note(format!("data {}", serde_json::to_string(&r.data).expect("data"))),
        }`,
				),
			})
			const create = 'POST /error-keys/users {"email":"a@x.test"}'
			const sent = [create, create]
			expect(
				{ safe: { ...seen(safe.run), wire: safe.hops }, thrown: { ...seen(thrown.run), wire: thrown.hops } },
				thrown.run.stderr + safe.run.stderr,
			).toEqual({
				safe: { built: true, out: ["error 400", 'data {"email":"a@x.test","id":"u1"}'], wire: sent },
				thrown: { built: true, out: ["api 400", "ok u1"], wire: sent },
			})
		},
		CARGO,
	)
})
