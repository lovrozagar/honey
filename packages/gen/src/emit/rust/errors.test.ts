/**
 * The Rust SDK's errors (contract 19 §5.6, G6/G7): one `#[non_exhaustive]` `Error`, its boxed `Api(ApiError)` read
 * through accessors; `ErrorKind` by status (429 `RateLimit`); each API's `ErrorKey` (§3.4) and an owned `key()`
 * (Fc4); `SdkResult` with `is_ok()` and `response` (Fc5); `Error::Hook` (Fc2). Driven through the `errors` driver
 * (safe mode's driven legs are errors.safe.test.ts); consumers `errors` and `safe` (Fc8) and one compile-fail program.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { RustError, Script, Trace } from "../shared/__fixtures__/protocol.ts"
import { type Reply, recordingServer, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { type Consumer, consume, type Run, seen, sections } from "./__fixtures__/consumer.ts"
import { errors } from "./__fixtures__/documents-http.ts"
import type { FixtureKey } from "./__fixtures__/documents.ts"
import { withRust } from "./__fixtures__/rust-env.ts"
import { generateRustSdk } from "./sdk.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

/** The `errors` document's keys in code-unit order: the wire spelling, the variant, the type its body decodes into. */
const KEYS: readonly (readonly [wire: string, variant: string, data?: string])[] = [
	["email_taken", "EmailTaken"],
	["invalid_password", "InvalidPassword"],
	["item.locked", "ItemLocked", "ItemLockedData"],
	["item_locked", "ItemLocked2"],
	["item_missing", "ItemMissing"],
	["item_not_found", "ItemNotFound"],
	["order.closed", "OrderClosed"],
	["order.locked", "OrderLocked", "Lock"],
	["other", "Other2"],
	["response.too_large", "ResponseTooLarge"],
	["user_not_found", "UserNotFound"],
]

/** §3.4's block for KEYS, exactly as `types.rs` ends. */
const ERROR_KEY = `/// The error keys the API declares (G6): \`ApiError::key()\` reads one; any other key is \`Other\`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ErrorKey {
${KEYS.map(([w, v, d]) => `    /// \`${w}\`${d === undefined ? "" : `: its body decodes into [\`${d}\`] (\`ApiError::decode_body\`).`}\n    ${v},\n`).join("")}    /// a key the API does not declare, as the server sent it
    Other(String),
}

impl ErrorKey {
    /// The key as the wire spells it.
    pub fn as_str(&self) -> &str {
        match self {
${KEYS.map(([w, v]) => `            ErrorKey::${v} => "${w}",\n`).join("")}            ErrorKey::Other(key) => key,
        }
    }
}

impl From<&str> for ErrorKey {
    fn from(key: &str) -> Self {
        match key {
${KEYS.map(([w, v]) => `            "${w}" => ErrorKey::${v},\n`).join("")}            other => ErrorKey::Other(other.to_owned()),
        }
    }
}

impl std::fmt::Display for ErrorKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

impl crate::ApiError {
    /// honey's error key in the body: the declared one it names, else \`Other\`; \`None\` without one.
    pub fn key(&self) -> Option<ErrorKey> {
        self.raw_key().map(ErrorKey::from)
    }
}
`

describe("the ErrorKey enum each API declares (G7, §3.4)", () => {
	// v0: 0ba8f85a31
	it("ends types.rs with ErrorKey over every declared key, colliding idents numbered, a body's type named, key() owned", () => {
		/* G6: v0's per-op UsersCreateErr400Key with serde renames is not emitted; one ErrorKey per API holds every key */
		const types = generateRustSdk(errors()).files["src/types.rs"] ?? ""
		expect(types.endsWith(`\n${ERROR_KEY}`), types.slice(-3000)).toBe(true)
	})

	it("declares <Key>Data for an inline schema alone (no envelope, no ref), and no result_large_err allow", () => {
		/* the allow goes with ApiError's boxed payload (§1 rules) */
		const { "src/lib.rs": lib = "", "src/types.rs": types = "" } = generateRustSdk(errors()).files
		const declared = [...types.matchAll(/^pub struct (\w+Data) \{/gm)].map((m) => m[1])
		const allowed = lib.includes("result_large_err")
		expect({ allowed, declared }).toEqual({ allowed: false, declared: ["ItemLockedData"] })
	})
})

const ITEM: Call = { operation: "items.get", params: { id: "i1" }, route: { method: "GET", path: "/items/{id}" } }
const EMAIL: Call["body"] = { kind: "json", value: { email: "a@x.test" } }
const CREATE: Call = { body: EMAIL, operation: "users.create", route: { method: "POST", path: "/users" } }

/** error-keys.json's 400 envelope (`fields` set), with `success` the one member ErrorEnvelope keeps in `extra`. */
const TAKEN = {
	error_key: "email_taken",
	fields: { email: [{ error_key: "taken", message: "is taken", path: "email" }] },
	message: "taken",
	status: 400,
	status_key: "bad_request",
	success: false,
}

/** The registry SDK `key` compiled with the driver, which must compile (a cached one spawns no cargo). */
function driven(key: FixtureKey): DrivenRustSdk {
	const sdk = drivenRustSdk(key)
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

/** `calls` run by `sdk` (under `script`, or `{}`) against a server answering `replies`: the run and the hops. */
function drive(sdk: DrivenRustSdk, replies: readonly Reply[], calls: readonly Call[], script: Script = {}) {
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: {} }, server, script)
		return { hops: [...server.hops], run }
	})
}

/** `calls` against an origin that refuses every connection. */
async function refused(sdk: DrivenRustSdk, calls: readonly Call[]) {
	const closed = await recordingServer([])
	await closed.close()
	return sdk.runCalls({ calls, setup: {} }, { url: closed.url }, {})
}

type Traced = Trace<RustError>["calls"][number]
const errorsOf = (calls: readonly Traced[] | undefined) => (calls ?? []).map((c) => c.error)
const shape = (e: RustError | undefined) => [e?.variant, e?.status, e?.source, e?.via]
/** A Rust error as the trace records it: no source and the method's own Err unless given, any Debug text. */
const plain = (entry: Partial<RustError>) => ({ debug: expect.any(String), source: false, via: "return", ...entry })
/** An error status with no key, its body `{"message": message}`, as the trace records it. */
const unkeyed = (status: number, kind: string, text: string, message = "m") =>
	plain({ key: null, keyVariant: "None", kind, message, status, text, variant: "Api" })
/** An error status as the driver observes it, for a `{"message": "m"}` body. */
const failed = (status: number) => ({ body: { message: "m" }, errorKey: null, kind: "error", status })
const answer = (status: number): Reply => ({ json: { message: "m" }, status })

describe.skipIf(!RUST)("an error status as Error::Api, its kind by status", () => {
	// v0: 0506b8c599
	it("reads each of the eleven named statuses as its ErrorKind, 429 as RateLimit", async () => {
		/* G6: v0's eleven per-status structs and StatusError are one ApiError whose kind() names the status */
		const named: [number, string, string][] = [
			[400, "BadRequest", "Bad Request"],
			[401, "Unauthorized", "Unauthorized"],
			[403, "Forbidden", "Forbidden"],
			[404, "NotFound", "Not Found"],
			[409, "Conflict", "Conflict"],
			[422, "UnprocessableEntity", "Unprocessable Entity"],
			[429, "RateLimit", "Too Many Requests"],
			[500, "InternalServer", "Internal Server Error"],
			[502, "BadGateway", "Bad Gateway"],
			[503, "ServiceUnavailable", "Service Unavailable"],
			[504, "GatewayTimeout", "Gateway Timeout"],
		]
		const replies = named.map(([status]) => answer(status))
		const calls = named.map(() => ITEM)
		const { hops, run } = await drive(driven("errors"), replies, calls)
		expect({ errors: errorsOf(run.trace?.calls), hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			errors: named.map(([status, kind, reason]) => unkeyed(status, kind, `${status} ${reason}: m`)),
			hops: named.length,
			observed: named.map(([status]) => failed(status)),
		})
	}, 600_000)

	// v0: f5739faf82
	it("reads a status no kind names as Other, its text the canonical reason: 418 and 410", async () => {
		/* G6: v0's raise_for_status table is ApiError::kind(); a status outside it is Other, never a lost error */
		const { run } = await drive(driven("errors"), [answer(418), answer(410)], [ITEM, ITEM])
		expect({ errors: errorsOf(run.trace?.calls), observed: run.observed }, run.stderr).toEqual({
			errors: [unkeyed(418, "Other", "418 I'm a teapot: m"), unkeyed(410, "Other", "410 Gone: m")],
			observed: [failed(418), failed(410)],
		})
	}, 600_000)

	// v0: d722292f2f
	it("reads a 500 whose body declares no key as InternalServer with no key", async () => {
		/* G6: v0's per-op UsersCreateError with an Other(Error) fallback is not emitted; key() is None */
		const { run } = await drive(driven("errors"), [{ json: { message: "boom" }, status: 500 }], [CREATE])
		const boom = unkeyed(500, "InternalServer", "500 Internal Server Error: boom", "boom")
		expect(errorsOf(run.trace?.calls), run.stderr).toEqual([boom])
	}, 600_000)
})

describe.skipIf(!RUST)("a hostile error body in the error's text", () => {
	// v0: 5330fd78cf
	it("drops control characters and cuts the message at 512 chars, the raw body kept", async () => {
		/* G6 ruling: v0 asserted only < 2,000 chars; v1 pins the strip and the 512-char cut exactly (Go parity) */
		const hostile = `\x1b]0;pwned\x07${"x".repeat(20_000 - 10)}`
		const message = `]0;pwned${"x".repeat(504)}…`
		const { run } = await drive(driven("errors"), [{ status: 500, text: hostile }], [ITEM])
		const error = run.trace?.calls[0]?.error
		expect({ message: error?.message, observed: run.observed, text: error?.text }, run.stderr).toEqual({
			message,
			observed: [{ body: hostile, errorKey: null, kind: "error", status: 500 }],
			text: `500 Internal Server Error: ${message}`,
		})
	}, 600_000)
})

describe.skipIf(!RUST)("each way a call fails, one Error variant each: never Api without an answer", () => {
	// v0: 6a7678aada
	it("ends an error status as Api, an undecodable 2xx as Decode, a bad path param as PathParam, a refused connection as Transport", async () => {
		/* flag: v0's Json and UrlParse are Decode and Config (the consumer's config leg); v0's Other is gone, Hook added (Fc2) */
		const sdk = driven("errors")
		const gone: Reply = { json: { message: "gone" }, status: 404 }
		const dots: Call = { ...ITEM, params: { id: ".." } }
		const { hops, run } = await drive(sdk, [gone, { json: { id: 1 }, status: 200 }], [ITEM, ITEM, dots])
		const lost = await refused(sdk, [ITEM])
		const [api, decode, path] = errorsOf(run.trace?.calls)
		const transport = lost.trace?.calls[0]?.error
		const texts = [decode?.text.startsWith("decode: "), path?.text, transport?.text.startsWith("transport: ")]
		const shapes = [api, decode, path, transport].map(shape)
		const observed = [run.observed, lost.observed]
		expect({ hops: hops.length, observed, shapes, texts }, run.stderr + lost.stderr).toEqual({
			hops: 2,
			observed: [[{ body: { message: "gone" }, errorKey: null, kind: "error", status: 404 }, null, null], [null]],
			shapes: [
				["Api", 404, false, "return"],
				["Decode", undefined, false, "return"],
				["PathParam", undefined, false, "return"],
				["Transport", undefined, true, "return"],
			],
			texts: [true, 'path param: "id" is empty, "." or "..", which no path segment can be', true],
		})
	}, 600_000)

	// v0: 2e44f6198e
	it("ends a lapsed per-call timeout as Timeout and a cancel before the call as Canceled, neither with a status", async () => {
		const late: Reply = { delayMs: 1000, json: { id: "i1", name: "n" }, status: 200 }
		const script: Script = { calls: [null, { cancel: "before" }] }
		const { hops, run } = await drive(driven("errors"), [late], [{ ...ITEM, timeoutMs: 50 }, ITEM], script)
		expect({ errors: errorsOf(run.trace?.calls), hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			errors: [
				plain({ text: "the call timed out", variant: "Timeout" }),
				plain({ text: "the call was canceled", variant: "Canceled" }),
			],
			hops: 1,
			observed: [{ kind: "timeout" }, null],
		})
	}, 600_000)
})

/** ErrorKind's variants in declaration order, as `kind_name` spells each. */
const KINDS =
	"BadRequest Unauthorized Forbidden NotFound Conflict UnprocessableEntity RateLimit InternalServer BadGateway ServiceUnavailable GatewayTimeout Other"

/** The `errors` consumer's own items: ApiError by value out of a call, and a name for every ErrorKind. */
const ERRORS_DECLS = `fn api<T>(r: Result<T, sdk::Error>) -> Result<sdk::ApiError, sdk::Error> {
    match r {
        Err(sdk::Error::Api(e)) => Ok(e),
        Err(e) => Err(e),
        Ok(_) => Err(sdk::Error::Config("an error status was expected".into())),
    }
}

fn kind_name(k: sdk::ErrorKind) -> &'static str {
    use sdk::ErrorKind as K;
    match k {
        K::BadRequest => "BadRequest", K::Unauthorized => "Unauthorized", K::Forbidden => "Forbidden",
        K::NotFound => "NotFound", K::Conflict => "Conflict", K::UnprocessableEntity => "UnprocessableEntity",
        K::RateLimit => "RateLimit", K::InternalServer => "InternalServer", K::BadGateway => "BadGateway",
        K::ServiceUnavailable => "ServiceUnavailable", K::GatewayTimeout => "GatewayTimeout", K::Other => "Other",
        _ => "unnamed",
    }
}`

/** The throw-mode consumer over `errors`: every kind matched, ApiError's accessors, the sources, the keys. */
const ERRORS = sections({
	kinds: `    use sdk::ErrorKind as K;
    let all = [${KINDS.split(" ")
			.map((k) => `K::${k}`)
			.join(", ")}];
    n.note(all.iter().map(|k| kind_name(*k)).collect::<Vec<_>>().join(" "));
    n.note(format!("small {}", std::mem::size_of::<sdk::Error>() <= 32));`,
	api: `    let c = client(base)?;
    let o = sdk::ItemsGetOpts::default();
    let e = api(c.items().get("i1", &o).await)?;
    let raw = e.body() == br#"{"message":"no such item"}"#.as_slice();
    let trace = e.headers().get("x-trace").and_then(|v| v.to_str().ok());
    n.note(format!("{} {} {raw} {trace:?} {e}", e.status(), e.message()));
    let e = api(c.items().get("i2", &o).await)?;
    let empty = e.envelope() == &sdk::ErrorEnvelope::default();
    n.note(format!("{} {empty} {} {:?}", e.message(), String::from_utf8_lossy(e.body()), e.key()));
    n.note(format!("{:?} {:?}", sdk::Error::Api(e).status(), sdk::Error::Timeout.status()));`,
	sources: `    let dead = client("http://127.0.0.1:9")?;
    let e = dead.items().get("i1", &sdk::ItemsGetOpts::default()).await.expect_err("a refused connection");
    let s: &(dyn std::error::Error + 'static) = std::error::Error::source(&e).expect("a source");
    n.note(format!("{} {} {}", matches!(e, sdk::Error::Transport(_)), e.to_string().starts_with("transport: "), !s.to_string().is_empty()));
    let h = sdk::Error::Hook("boom".into());
    n.note(format!("{h} {:?}", std::error::Error::source(&h).map(ToString::to_string)));
    n.note(format!("config {}", matches!(client("not a url"), Err(sdk::Error::Config(_)))));`,
	keys: `    use sdk::ErrorKey as K;
    let all = [${KEYS.map(([, v]) => `K::${v}`).join(", ")}];
    n.note(all.iter().map(|k| format!("{}={k}", k.as_str())).collect::<Vec<_>>().join(" "));
    n.note(format!("{:?} {}", K::from("nope"), K::from("nope") == K::Other("nope".into())));
    let c = client(base)?;
    let body = sdk::UsersCreateBody { email: "a@x.test".into() };
    let o = sdk::UsersCreateOpts::default();
    let e = api(c.users().create(&body, &o).await)?;
    let env = e.envelope();
    let mut extra: Vec<&String> = env.extra.keys().collect();
    extra.sort();
    let taken = e.key() == Some(K::EmailTaken);
    n.note(format!("{:?} {:?} {taken} {:?} {:?} {:?} {} {extra:?}", e.kind(), e.key(), env.status, env.status_key, env.message, env.fields["email"][0].path));
    let e = api(c.users().create(&body, &o).await)?;
    n.note(format!("{:?} {:?}", e.kind(), e.key()));
    let items = sdk::ItemsGetOpts::default();
    let e = api(c.items().get("i3", &items).await)?;
    n.note(format!("{:?}", e.key()));
    let e = api(c.items().get("i4", &items).await)?;
    let d = e.decode_body::<sdk::ItemLockedData>()?;
    n.note(format!("{:?} {:?} {}", d.until, e.key(), e.key() != Some(K::ItemLocked2)));
    let e = api(c.orders().close(&sdk::OrdersCloseOpts::default()).await)?;
    let lock: sdk::Lock = e.decode_body()?;
    n.note(format!("{} {:?}", lock.until, e.key()));`,
})

/** What the `errors` consumer's server answers, in order. */
const ERRORS_REPLIES: readonly Reply[] = [
	{ headers: { "x-trace": "t9" }, json: { message: "no such item" }, status: 404 },
	{ status: 422, text: "oops" },
	{ json: TAKEN, status: 400 },
	{ json: { ...TAKEN, error_key: "user_not_found", fields: {}, message: "no user", status: 404 }, status: 404 },
	{ json: { error_key: "item_missing", message: "gone", status: 404, success: false }, status: 404 },
	{ json: { error_key: "item.locked", until: "2026-10-17" }, status: 423 },
	{ json: { error_key: "order.locked", until: "noon" }, status: 423 },
]

/** Consumer `name` over registry SDK `key`, run against a server answering `replies`: the run and its wire. */
const consumed = (key: FixtureKey, name: string, replies: readonly Reply[], p: Omit<Consumer, "base">) =>
	served(replies, async (server) => {
		const run = await consume(key, name, { base: server.url, ...p })
		return { run, wire: server.hops.map((h) => `${h.method} ${h.url}`) }
	})

const ERRORS_PROGRAM = { ...ERRORS, decls: `${ERRORS.decls}\n\n${ERRORS_DECLS}` }
let errorsRun: Promise<{ run: Run; wire: string[] }> | undefined
const errorsConsumer = () => (errorsRun ??= consumed("errors", "errors", ERRORS_REPLIES, ERRORS_PROGRAM))

describe.skipIf(!RUST)("ApiError, ErrorKind and ErrorKey from a consumer program (errors, throw mode)", () => {
	// v0: 0506b8c599
	it("matches every ErrorKind by name with a wildcard arm (non_exhaustive), Error boxed to 32 bytes at most", async () => {
		const { run } = await errorsConsumer()
		expect(seen(run, "kinds"), run.stderr).toEqual({ built: true, out: [KINDS, "small true"] })
	}, 600_000)

	// v0: 8f9dbbf108
	it("reads an Api error by value: status, message, raw body, headers and text; a non-JSON body is the message", async () => {
		/* G6: v0's public message/body/status_code fields are accessors over a boxed payload */
		const { run, wire } = await errorsConsumer()
		expect({ ...seen(run, "api"), wire: wire.slice(0, 2) }, run.stderr).toEqual({
			built: true,
			out: ['404 no such item true Some("t9") 404 Not Found: no such item', "oops true oops None", "Some(422) None"],
			wire: ["GET /items/i1", "GET /items/i2"],
		})
	}, 600_000)

	// v0: 6a7678aada
	it("keeps a Transport error's source without naming reqwest, a Hook error's own, and a bad base_url as Config", async () => {
		const { run } = await errorsConsumer()
		expect(seen(run, "sources"), run.stderr).toEqual({
			built: true,
			out: ["true true true", 'hook: boom Some("boom")', "config true"],
		})
	}, 600_000)

	// v0: 0ba8f85a31
	// v0: 678b56b4d2
	// v0: 661b2b03d8
	// v0: 099f5c479f
	it("spells each key as the wire does, reads key() and the envelope, and decodes a key's body into its type", async () => {
		/* G6: v0's UsersCreateErr400 struct and per-op error enums are the envelope() and key() of one ApiError */
		const { run, wire } = await errorsConsumer()
		expect({ ...seen(run, "keys"), wire: wire.slice(2) }, run.stderr).toEqual({
			built: true,
			out: [
				KEYS.map(([w]) => `${w}=${w}`).join(" "),
				'Other("nope") true',
				'BadRequest Some(EmailTaken) true Some(400) Some("bad_request") Some("taken") email ["success"]',
				"NotFound Some(UserNotFound)",
				"Some(ItemMissing)",
				'Some("2026-10-17") Some(ItemLocked) true',
				"noon Some(OrderLocked)",
			],
			wire: ["POST /users", "POST /users", "GET /items/i3", "GET /items/i4", "POST /a"],
		})
	}, 600_000)
})

const missing = (name: string) => `E0425 cannot find type \`${name}\` in crate \`sdk\``

/** What no API emits (no per-op error types, no `<Key>Data` for an envelope or a ref) beside what it must, and Error's non_exhaustive. */
const ABSENT = `fn absent() {
    let _: sdk::UsersCreateError;
    let _: sdk::UsersCreateErr400;
    let _: sdk::OrderClosedData;
    let _: sdk::OrderLockedData;
}

fn present(e: &sdk::ApiError) -> (Option<sdk::ErrorKey>, Option<sdk::ItemLockedData>) {
    (e.key(), e.decode_body().ok())
}

fn exhaustive(e: sdk::Error) -> u8 {
    use sdk::Error as E;
    match e {
        E::Api(_) | E::Transport(_) | E::Decode(_) | E::Timeout | E::Canceled => 0,
        E::AuthExpired(_) | E::PathParam(_) | E::Config(_) | E::Closed | E::Hook(_) => 1,
    }
}`

describe.skipIf(!RUST)("what the errors crate does not declare, checked by its compile", () => {
	// v0: 661b2b03d8
	it("has no per-op error enum, no <Key>Data for an envelope or a ref key, and a non_exhaustive Error", async () => {
		/* §5.6 names E0412; the pinned 1.99.1 reports a missing type in a crate as E0425 */
		const run = await consume("errors", "absent", { body: 'n.note("built");', decls: ABSENT })
		const reported = [...run.stderr.matchAll(/^error\[(E\d+)\]: (.*)$/gm)].map((m) => `${m[1]} ${m[2]}`)
		expect({ built: run.built, reported }, run.stderr).toEqual({
			built: false,
			reported: [
				missing("UsersCreateError"),
				missing("UsersCreateErr400"),
				missing("OrderClosedData"),
				missing("OrderLockedData"),
				"E0004 non-exhaustive patterns: `_` not covered",
			],
		})
	}, 600_000)
})

/** The safe-mode consumer over `fixtures-safe`: error-keys users.create answered 400, then 201. */
const SAFE = sections({
	safe: `    let c = client(base)?;
    let b = serde_json::from_value(serde_json::json!({ "email": "a@x.test" })).expect("body");
    let o = Default::default();
    let r: sdk::SdkResult<sdk::ErrorKeysUser> = c.error_keys().users().create(&b, &o).await?;
    let e = r.error.as_ref().expect("the 400");
    n.note(format!("{} {:?} {:?} {:?} {} {} {}", r.is_ok(), e.kind(), e.key(), e.envelope().message, r.status, r.response.status, r.data.is_none()));
    let r: sdk::SdkResult<sdk::ErrorKeysUser> = c.error_keys().users().create(&b, &o).await?;
    let id = r.data.as_ref().map_or("-", |u| u.id.as_str());
    n.note(format!("{} {id} {} {} {} {}", r.is_ok(), r.status, r.error.is_none(), r.response.status, r.response.url.path()));`,
})

describe.skipIf(!RUST)("SdkResult from a consumer program (fixtures-safe)", () => {
	// v0: d59d370556
	// v0: 97f98d4e97
	it("holds a 400 as error with its kind, key and envelope, a 201 as data, is_ok() and the raw response in both", async () => {
		/* Fc5: v0's ok() is is_ok() (std's ok() is Option<T>), its response restored; G16: no SdkResult<T, E> */
		const user: Reply = { json: { email: "a@x.test", id: "u1" }, status: 201 }
		const { run, wire } = await consumed("fixtures-safe", "safe", [{ json: TAKEN, status: 400 }, user], SAFE)
		expect({ ...seen(run, "safe"), wire }, run.stderr).toEqual({
			built: true,
			out: ['false BadRequest Some(EmailTaken) Some("taken") 400 400 true', "true u1 201 true 201 /error-keys/users"],
			wire: ["POST /error-keys/users", "POST /error-keys/users"],
		})
	}, 600_000)
})
