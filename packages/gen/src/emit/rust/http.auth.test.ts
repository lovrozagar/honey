/**
 * The Rust SDK's auth and redirects (contract 19 §5.2, the Go `http.auth.test.ts` analog), driven on `http`
 * (an http bearer scheme) and `errors` (an apiKey in `X-API-Key`): the scheme's header, the G19 pair rule
 * over two `Option`s, the credential laid last over a per-call header (Fc1), `on_auth_expired`'s one refresh
 * and one retry, and R3's own redirect loop: same-origin by default, follow-and-strip under `Follow` (Fc9),
 * the 303 and 307 rules and the hop cap, for the SDK's client and a caller's `http_builder`. A consumer
 * program `auth` covers what the driver cannot: concurrent 401s, the token `on_auth_expired` is handed,
 * `RedirectPolicy::Manual`, and a builder's default header on a cross-origin hop (H18.10's boundary).
 */
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/compiled.ts"
import { consume, once, sections, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

const ECHO: Call = { operation: "echo.get", route: { method: "GET", path: "/echo" } }
const HOP: Call = { operation: "hop.get", route: { method: "GET", path: "/hop" } }
const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const post = (operation: string, path: string, body: Call["body"]): Call => ({
	body,
	operation,
	route: { method: "POST", path },
})
const CREATE = post("users.create", "/users", { kind: "json", value: { name: "retry-body" } })
const ORDER = post("orders.create", "/orders", { kind: "json", value: { sku: "s" } })
const RAW = post("raw.send", "/raw", { contentType: "application/octet-stream", kind: "binary", size: 4096 })
const GET_USER: Call = { operation: "users.get", params: { id: "1" }, route: { method: "GET", path: "/users/{id}" } }

const OK: Reply = { json: { ok: true }, status: 200 }
const OK_DATA = { data: { ok: true }, kind: "data", status: 200 }
const USER: Reply = { json: { id: "u1" }, status: 200 }
const USER_DATA = { data: { id: "u1" }, kind: "data", status: 200 }
const UNAUTHORIZED = { errorKey: null, kind: "error", status: 401 }
const refusedAs = (status: number) => ({ errorKey: null, kind: "error", status })

/** A redirect with `status` to `path` on the `origin` listener. */
const moved = (status: number, origin: "alt" | "primary", path: string): Reply => ({
	redirect: { origin, path },
	status,
})

const sdks = new Map<"errors" | "http", DrivenRustSdk>()
/** The registry SDK `key` compiled with the driver, once per file: it must build. */
function driven(key: "errors" | "http"): DrivenRustSdk {
	const sdk = sdks.get(key) ?? drivenRustSdk(key)
	sdks.set(key, sdk)
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

type Options = { readonly script?: Script; readonly setup?: Setup }

/** `calls` run by `key`'s driver against a server answering `replies`: the run, every hop and its raw body. */
async function drive(key: "errors" | "http", replies: readonly Reply[], calls: readonly Call[], options: Options = {}) {
	const sdk = driven(key)
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: options.setup ?? {} }, server, options.script)
		return { bodies: [...server.bodies], hops: [...server.hops], run }
	})
}

/** Every header a hop may carry the credential in, unset ones dropped by `toEqual` (Go `http.auth.test.ts:97-102`). */
const credentials = (hop: RecordedHop | undefined) => ({
	authorization: hop?.headers.authorization,
	"x-api-key": hop?.headers["x-api-key"],
	"x-raw": hop?.headers["x-raw"],
	"x-token": hop?.headers["x-token"],
})

/** A body of `size` bytes `i & 0xff`, as a hop records an upload of it. */
function binaryBody(size: number, contentType: string) {
	const bytes = Buffer.from(Array.from({ length: size }, (_, i) => i & 0xff))
	return { contentType, sha256: createHash("sha256").update(bytes).digest("hex"), size }
}

const T: Setup = { auth: { kind: "bearer", token: "t" } }
const OLD: Setup = { auth: { kind: "bearer", token: "old" } }

describe.skipIf(!RUST)("the Rust SDK's auth header: the spec's scheme picks its name and prefix", () => {
	// v0: 8dfc56ab06
	// v0: babe55a19f
	it("sends Authorization: Bearer under http bearer, and the bare token in X-API-Key under the apiKey scheme", async () => {
		const [bearer, apiKey] = await Promise.all([
			drive("http", [OK], [ECHO], { setup: T }),
			drive("errors", [{ json: { id: "i1", name: "n" }, status: 200 }], [ITEM], { setup: T }),
		])
		/* babe55a19f's other default, an empty base_url taking servers[0], is sdk.calls.test.ts's "new" leg */
		expect(
			[bearer, apiKey].map(({ hops, run }) => ({ observed: run.observed, sent: credentials(hops[0]) })),
			bearer.run.stderr + apiKey.run.stderr,
		).toEqual([
			{ observed: [OK_DATA], sent: { authorization: "Bearer t" } },
			{ observed: [{ data: { id: "i1", name: "n" }, kind: "data", status: 200 }], sent: { "x-api-key": "t" } },
		])
	}, 600_000)
})

describe.skipIf(!RUST)(
	"the Rust SDK's auth header: auth_header_name and auth_header_prefix are a pair of Options (G19)",
	() => {
		it("keeps the scheme's header for a prefix alone, Some(\"\") meaning none; a set name takes the caller's prefix or none", async () => {
			const legs: ["errors" | "http", NonNullable<Script["config"]>][] = [
				["http", { authHeaderName: "X-Token", authHeaderPrefix: "Token " }],
				["http", { authHeaderPrefix: "Key " }],
				["http", { authHeaderPrefix: "" }],
				["http", { authHeaderName: "X-Raw" }],
				["errors", { authHeaderPrefix: "Key " }],
			]
			const runs = await Promise.all(
				legs.map(([key, config]) => drive(key, [OK], [key === "http" ? ECHO : ITEM], { script: { config }, setup: T })),
			)
			expect(
				runs.map(({ hops }) => credentials(hops[0])),
				runs.map(({ run }) => run.stderr).join("\n"),
			).toEqual([
				{ "x-token": "Token t" },
				{ authorization: "Key t" },
				{ authorization: "t" },
				{ "x-raw": "t" },
				{ "x-api-key": "Key t" },
			])
		}, 600_000)
	},
)

describe.skipIf(!RUST)("the Rust SDK's auth header: the credential is laid last, over a per-call header (Fc1)", () => {
	it("sends the client's credential in place of a per-call Authorization, one value, never joined", async () => {
		const call: Call = { ...ECHO, headers: { Authorization: "Bearer call" } }
		const { hops, run } = await drive("http", [OK], [call], { setup: { auth: { kind: "bearer", token: "tok" } } })
		expect({ auth: hops.map((h) => h.headers.authorization), observed: run.observed }, run.stderr).toEqual({
			auth: ["Bearer tok"],
			observed: [OK_DATA],
		})
	}, 600_000)

	it("hands on_auth_expired the token it sent and retries with the fresh one; with no credential a per-call one passes untouched", async () => {
		const { hops, run } = await auth()
		expect(
			{ hops: hops.slice(6, 9).map((h) => h.headers.authorization), ...seen(run, "credential") },
			run.stderr,
		).toEqual({
			built: true,
			hops: ["Bearer old", "Bearer new", "Bearer call"],
			out: ['rejected [Some("old")]', "bare ok"],
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust SDK's auth refresh: a 401 calls on_auth_expired once and retries once", () => {
	// v0: ef2bdb443f
	it("retries with the fresh token, gives up after a second 401, and sends nothing more for an empty token", async () => {
		const fresh: Script = { onAuthExpired: { tokens: ["new"] } }
		const legs = await Promise.all([
			drive("http", [{ status: 401 }, OK], [ECHO], { script: fresh, setup: OLD }),
			drive("http", [{ status: 401 }, { status: 401 }], [ECHO], { script: fresh, setup: OLD }),
			drive("http", [{ status: 401 }], [ECHO], { script: { onAuthExpired: { tokens: [""] } }, setup: OLD }),
		])
		expect(
			legs.map(({ hops, run }) => ({
				auth: hops.map((h) => h.headers.authorization),
				expired: run.trace?.authExpired,
				observed: run.observed,
			})),
			legs.map(({ run }) => run.stderr).join("\n"),
		).toEqual([
			{ auth: ["Bearer old", "Bearer new"], expired: 1, observed: [OK_DATA] },
			{ auth: ["Bearer old", "Bearer new"], expired: 1, observed: [UNAUTHORIZED] },
			{ auth: ["Bearer old"], expired: 1, observed: [UNAUTHORIZED] },
		])
	}, 600_000)

	// v0: 6ab5bbb7de
	it("resends a JSON body intact on the retry and keeps the fresh token for the next call", async () => {
		const script: Script = { onAuthExpired: { tokens: ["new"] } }
		const replies: Reply[] = [{ status: 401 }, USER, USER]
		const { bodies, hops, run } = await drive("http", replies, [CREATE, GET_USER], { script, setup: OLD })
		const sent = '{"name":"retry-body"}'
		expect(
			{
				auth: hops.map((h) => `${h.method} ${h.url} ${h.headers.authorization}`),
				bodies: bodies.map((b) => b.toString("utf8")),
				expired: run.trace?.authExpired,
				observed: run.observed,
			},
			run.stderr,
		).toEqual({
			auth: ["POST /users Bearer old", "POST /users Bearer new", "GET /users/1 Bearer new"],
			bodies: [sent, sent, ""],
			expired: 1,
			observed: [USER_DATA, USER_DATA],
		})
	}, 600_000)

	// v0: 3ddfc7e7c7
	it("refreshes once for three concurrent 401s (tokio::join!), each call retried with the one fresh token", async () => {
		const { hops, run } = await auth()
		expect(
			{ hops: hops.slice(0, 6).map((h) => h.headers.authorization), ...seen(run, "concurrent") },
			run.stderr,
		).toEqual({
			built: true,
			hops: ["Bearer old", "Bearer old", "Bearer old", "Bearer fresh", "Bearer fresh", "Bearer fresh"],
			out: ["refreshes 1", "ok 3"],
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust SDK's auth refresh: an unreplayable body is never retried", () => {
	/* the Go 1ce9803a2a analog, a v1 leg: a one-shot stream is sent once and its 401 returned */
	it("never resends a one-shot upload: one hop with the whole body chunked, the 401 returned, no refresh", async () => {
		const script: Script = { calls: [{ oneShotBody: true }], onAuthExpired: { tokens: ["new"] } }
		const { hops, run } = await drive("http", [{ status: 401 }], [RAW], { script, setup: OLD })
		const sent = hops.map((h) => [
			`${h.method} ${h.url}`,
			h.headers.authorization,
			h.headers["transfer-encoding"],
			h.body,
		])
		expect({ expired: run.trace?.authExpired, observed: run.observed, sent, status: run.status }, run.stderr).toEqual({
			expired: 0,
			observed: [UNAUTHORIZED],
			sent: [["POST /raw", "Bearer old", "chunked", binaryBody(4096, "application/octet-stream")]],
			status: 0,
		})
	}, 600_000)
})

/* the headers a cross-origin hop may carry: the safe set, and what reqwest adds itself (accept, host; no accept-encoding) */
const CROSS_ORIGIN_SAFE = new Set(["accept", "accept-language", "host", "user-agent"])

/** A redirected request as a test pins it: where it went and the credentials it carried. */
const redirected = (hop: RecordedHop | undefined) => ({
	authorization: hop?.headers.authorization,
	cookie: hop?.headers.cookie,
	language: hop?.headers["accept-language"],
	leaked: Object.keys(hop?.headers ?? {}).filter((name) => !CROSS_ORIGIN_SAFE.has(name)),
	to: `${hop?.origin} ${hop?.url}`,
	"x-api-key": hop?.headers["x-api-key"],
})

const LEAVING = {
	authorization: "Bearer tok-r",
	cookie: "sid=1",
	language: "hr",
	leaked: expect.arrayContaining(["authorization", "cookie", "x-api-key"]),
	to: "primary /hop",
	"x-api-key": "k-1",
}
const LANDED = { language: "hr", leaked: [], to: "alt /landing" }

const AWAY = moved(307, "alt", "/landing")
const CROSSING: Setup = {
	auth: { kind: "bearer", token: "tok-r" },
	headers: { "Accept-Language": "hr", Cookie: "sid=1", "X-Api-Key": "k-1" },
}
const FOLLOW: Setup = { ...CROSSING, redirect: "follow" }

/** Each hop's user agent. */
const agents = (hops: readonly RecordedHop[]) => hops.map((h) => h.headers["user-agent"])

describe.skipIf(!RUST)("the Rust SDK's redirects: a cross-origin hop is followed only under Follow, stripped", () => {
	/* R3 (Fc9): v0 refused every cross-host hop (same_host_redirects); v1 refuses by default and follows-and-strips under
	   Follow. The SDK's own client is the one with no http_builder (babe55a19f's wording) */
	// v0: 53f5730323
	// v0: babe55a19f
	it("follows under Follow without X-Api-Key, Authorization or Cookie; refuses it by default as the 307", async () => {
		const [follow, refuse] = await Promise.all([
			drive("http", [AWAY, OK], [HOP], { setup: FOLLOW }),
			drive("http", [AWAY, OK], [HOP], { setup: CROSSING }),
		])
		const read = ({ hops, run }: typeof follow) => ({ hops: hops.map(redirected), observed: run.observed })
		expect({ follow: read(follow), refuse: read(refuse) }, follow.run.stderr + refuse.run.stderr).toEqual({
			follow: { hops: [LEAVING, LANDED], observed: [OK_DATA] },
			refuse: { hops: [LEAVING], observed: [refusedAs(307)] },
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust SDK's redirects: a caller's http_builder", () => {
	/* V0BUG: v0 used a caller reqwest::Client as is, its redirect policy unguarded (_v0/src/codegen-rust.ts:1159-1162);
	   v1 takes a ClientBuilder, forces Policy::none() and runs its own loop (R3) */
	// v0: ba9c8d6a80
	it("sends through it, its user agent on both hops, its Policy::limited(10) replaced by the SDK's strip", async () => {
		const script: Script = { config: { httpClient: true } }
		const [follow, plain] = await Promise.all([
			drive("http", [AWAY, OK], [HOP], { script, setup: FOLLOW }),
			drive("http", [OK], [ECHO], { script, setup: CROSSING }),
		])
		const read = ({ hops, run }: typeof follow) => ({
			agents: agents(hops),
			observed: run.observed,
			transport: run.trace?.transport,
		})
		expect(
			{ follow: { ...read(follow), hops: follow.hops.map(redirected) }, plain: read(plain) },
			follow.run.stderr + plain.run.stderr,
		).toEqual({
			follow: { agents: ["honey-driver", "honey-driver"], hops: [LEAVING, LANDED], observed: [OK_DATA] },
			plain: { agents: ["honey-driver"], observed: [OK_DATA] },
		})
	}, 600_000)

	/* (a'): PINS H18.10's documented boundary, on purpose. A header the caller puts in http_builder.default_headers belongs
	   to the transport: reqwest adds it at send time, after the SDK's strip, so it DOES reach a cross-origin hop, while
	   every credential in ClientConfig is stripped. ClientConfig's rustdoc says so (credentials belong in ClientConfig,
	   never in the builder's default headers). Should a change make the SDK strip it, or start leaking a ClientConfig
	   credential, this leg trips: rule it, then move the documentation and this pin together. */
	it("lets a default header reach the cross-origin hop, every ClientConfig credential stripped (H18.10's documented limit)", async () => {
		const { hops, run } = await auth()
		const sent = hops.slice(10, 12)
		const builder = sent.map((h) => ({ ...redirected(h), builder: h.headers["x-builder"] }))
		expect({ agents: agents(sent), hops: builder, ...seen(run, "builder") }, run.stderr).toEqual({
			agents: ["caller-ua", "caller-ua"],
			built: true,
			hops: [
				{ ...LEAVING, builder: "b" },
				{ ...LANDED, builder: "b", leaked: ["x-builder"] },
			],
			out: ["landed"],
		})
	}, 600_000)
})

const BEARER: Setup = { auth: { kind: "bearer", token: "tok" } }

/** Each hop as `origin METHOD url`, its credential, and its body's type and size. */
const wire = (hops: readonly RecordedHop[]) =>
	hops.map((h) => [`${h.origin} ${h.method} ${h.url}`, h.headers.authorization, h.body.contentType, h.body.size])

/** A run as its observed and wire, the redirect legs' shape. */
const trail = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({ observed: run.observed, wire: wire(hops) })

const POSTED = ["primary POST /users", "Bearer tok", "application/json", 21]

describe.skipIf(!RUST)("the Rust SDK's redirects: its own loop follows a same-origin hop (R3)", () => {
	it("follows a same-origin 302 by default, keeping the credential (a); turns a 303 after a POST into a bodiless GET (b)", async () => {
		const [found, other] = await Promise.all([
			drive("http", [moved(302, "primary", "/echo"), OK], [HOP], { setup: BEARER }),
			drive("http", [moved(303, "primary", "/ping"), { json: { id: "o1" }, status: 201 }], [ORDER], { setup: BEARER }),
		])
		expect({ found: trail(found), other: trail(other) }, found.run.stderr + other.run.stderr).toEqual({
			found: {
				observed: [OK_DATA],
				wire: [
					["primary GET /hop", "Bearer tok", null, 0],
					["primary GET /echo", "Bearer tok", null, 0],
				],
			},
			other: {
				observed: [{ data: { id: "o1" }, kind: "data", status: 201 }],
				wire: [
					["primary POST /orders", "Bearer tok", "application/json", 11],
					["primary GET /ping", "Bearer tok", null, 0],
				],
			},
		})
	}, 600_000)

	it("resends a buffered body on a same-origin 307 (c)", async () => {
		const same = await drive("http", [moved(307, "primary", "/users"), USER], [CREATE], { setup: BEARER })
		const sent = '{"name":"retry-body"}'
		expect({ ...trail(same), bodies: same.bodies.map((b) => b.toString("utf8")) }, same.run.stderr).toEqual({
			bodies: [sent, sent],
			observed: [USER_DATA],
			wire: [POSTED, POSTED],
		})
	}, 600_000)
})

describe.skipIf(!RUST)("the Rust SDK's redirects: where its own loop stops (R3)", () => {
	it("answers a 307 to another origin under Follow with a buffered body as the 307 (d)", async () => {
		const away = await drive("http", [moved(307, "alt", "/users"), USER], [CREATE], {
			setup: { ...BEARER, redirect: "follow" },
		})
		expect(trail(away), away.run.stderr).toEqual({ observed: [refusedAs(307)], wire: [POSTED] })
	}, 600_000)

	it("stops after ten redirects: the eleventh hop's 302 is the answer (e)", async () => {
		const loop = Array.from({ length: 12 }, () => moved(302, "primary", "/hop"))
		const { hops, run } = await drive("http", loop, [HOP])
		expect({ hops: hops.map((h) => h.url), observed: run.observed }, run.stderr).toEqual({
			hops: Array.from({ length: 11 }, () => "/hop"),
			observed: [refusedAs(302)],
		})
	}, 600_000)

	it("answers any 3xx under RedirectPolicy::Manual as the error status, one hop (f)", async () => {
		const { hops, run } = await auth()
		const sent = hops.slice(9, 10).map((h) => `${h.origin} ${h.url}`)
		expect({ hops: sent, ...seen(run, "manual") }, run.stderr).toEqual({
			built: true,
			hops: ["primary /hop"],
			out: ["api true Some(302)"],
		})
	}, 600_000)
})

/** The consumer's helper: an `on_auth_expired` from a closure, its signature taken from the bound. */
const HELPERS = `type Refreshed = Pin<Box<dyn Future<Output = Result<Option<String>, sdk::Error>> + Send>>;

fn refresher<F: Fn(Option<String>) -> Refreshed + Send + Sync + 'static>(f: F) -> sdk::OnAuthExpiredHook {
    Arc::new(f)
}`

const IMPORTS = [
	"std::future::Future",
	"std::pin::Pin",
	"std::sync::atomic::{AtomicUsize, Ordering}",
	"std::sync::{Arc, Mutex}",
	"std::time::Duration",
]

/** Sections run in order against one server, so each owns a slice of its hops: 0-5, 6-8, 9, 10-11. */
const AUTH = sections({
	concurrent: `    let count = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&count);
    let c = sdk::Client::new(sdk::ClientConfig {
        base_url: base.into(),
        bearer_token: Some("old".into()),
        on_auth_expired: Some(refresher(move |_| {
            let counted = Arc::clone(&counted);
            Box::pin(async move {
                tokio::time::sleep(Duration::from_millis(100)).await;
                counted.fetch_add(1, Ordering::SeqCst);
                Ok::<_, sdk::Error>(Some("fresh".to_owned()))
            })
        })),
        ..Default::default()
    })?;
    let o = sdk::UsersGetOpts::default();
    let (a, b, d) = tokio::join!(c.users().get("1", &o), c.users().get("2", &o), c.users().get("3", &o));
    n.note(format!("refreshes {}", count.load(Ordering::SeqCst)));
    n.note(format!("ok {}", [a.is_ok(), b.is_ok(), d.is_ok()].into_iter().filter(|ok| *ok).count()));`,
	credential: `    let rejected = Arc::new(Mutex::new(Vec::<Option<String>>::new()));
    let kept = Arc::clone(&rejected);
    let c = sdk::Client::new(sdk::ClientConfig {
        base_url: base.into(),
        bearer_token: Some("old".into()),
        on_auth_expired: Some(refresher(move |token| {
            kept.lock().expect("lock").push(token);
            Box::pin(async { Ok::<_, sdk::Error>(Some("new".to_owned())) })
        })),
        ..Default::default()
    })?;
    let o = sdk::EchoGetOpts::default();
    c.echo().get(&o).header("Authorization", "Bearer call").await?;
    n.note(format!("rejected {:?}", rejected.lock().expect("lock")));
    client(base)?.echo().get(&o).header("Authorization", "Bearer call").await?;
    n.note("bare ok");`,
	manual: `    let redirect = sdk::RedirectPolicy::Manual;
    let c = sdk::Client::new(sdk::ClientConfig { base_url: base.into(), redirect, ..Default::default() })?;
    match c.hop().get(&sdk::HopGetOpts::default()).await {
        Err(e) => n.note(format!("api {} {:?}", matches!(e, sdk::Error::Api(_)), e.status())),
        Ok(_) => n.note("followed"),
    }`,
	builder: `    let mut defaults = reqwest::header::HeaderMap::new();
    defaults.insert("x-builder", reqwest::header::HeaderValue::from_static("b"));
    let headers = [("Accept-Language", "hr"), ("Cookie", "sid=1"), ("X-Api-Key", "k-1")];
    let builder = reqwest::Client::builder()
        .user_agent("caller-ua")
        .default_headers(defaults)
        .redirect(reqwest::redirect::Policy::limited(10));
    let c = sdk::Client::new(sdk::ClientConfig {
        base_url: base.into(),
        bearer_token: Some("tok-r".into()),
        headers: headers.into_iter().map(|(k, v)| (k.to_owned(), v.to_owned())).collect(),
        redirect: sdk::RedirectPolicy::Follow,
        http_builder: Some(builder),
        ..Default::default()
    })?;
    c.hop().get(&sdk::HopGetOpts::default()).await?;
    n.note("landed");`,
})

/** The answers, section by section: three 401s then three users; a 401, two echoes; a 302; a 307 away, an echo. */
const AUTH_REPLIES: readonly Reply[] = [
	...Array.from({ length: 3 }, () => ({ status: 401 })),
	...Array.from({ length: 3 }, () => ({ json: { id: "u" }, status: 200 })),
	{ status: 401 },
	OK,
	OK,
	moved(302, "primary", "/echo"),
	AWAY,
	OK,
]

/** Consumer `auth` on `http`, built and run once against one server: its run and every hop. */
const auth = once(() =>
	served(AUTH_REPLIES, async (server) => {
		const program = { ...AUTH, base: server.url, decls: `${AUTH.decls}\n\n${HELPERS}`, imports: IMPORTS }
		const run = await consume("http", "auth", program)
		return { hops: [...server.hops], run }
	}),
)
