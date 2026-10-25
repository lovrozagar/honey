/**
 * The Rust SDK's hooks and log (contract 19 §5.3, the Go `http.hooks.test.ts` analog), driven on `http`'s
 * `members.get`: `on_request` and `on_response` in declaration order, a hook's `Err` ending the call as
 * `Error::Hook` (Fc2), an auth retry running every hook again with `is_retry`, and `on_log`'s entries, named by
 * the operation template (`METHOD /template`) and never carrying a path value, header value, query or token,
 * for an answer, an error status, no answer and a canceled call. A consumer program `hooks` covers what the
 * driver cannot: the `state` map, a hook reading and replacing the request id, the redacted `Debug`s and a
 * panicking `on_log`.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { HookTrace, LogTrace, RustError, Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served, REFUSED_URL } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { consume, once, sections, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

/* values no log entry may carry: the path params, the query, the token and a configured header's value */
const ORG = "org-7f3a"
const USER_ID = "usr-9c2e"
const QUERY = "qry-41bd"
const TOKEN = "tok-d00d"
const HEADER = "hdr-5e1a"
const OPERATION = "GET /orgs/{org}/users/{user-id}"
const CONCRETE = `/orgs/${ORG}/users/${USER_ID}`

const GET: Call = {
	operation: "members.get",
	params: { org: ORG, "user-id": USER_ID },
	route: { method: "GET", path: "/orgs/{org}/users/{user-id}" },
	search: { ids: [QUERY] },
}
const FOUND: Reply = { json: { id: "u", name: "found" }, status: 200 }
const BEARER: Setup = { auth: { kind: "bearer", token: TOKEN }, headers: { "X-Trace": HEADER } }
const data = (value: Record<string, unknown>) => ({ data: value, kind: "data", status: 200 })

let memo: DrivenRustSdk | undefined
/** The `http` SDK compiled with the driver, once: it must build. */
function hooksSdk(): DrivenRustSdk {
	memo ??= drivenRustSdk("http")
	expect(memo.built, memo.stderr).toBe(true)
	return memo
}

/** `calls` under `script` against a server answering `replies`: the run, the hops and the origin. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script, setup: Setup = {}) {
	const sdk = hooksSdk()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, server, script)
		expect(run.status, run.stderr).toBe(0)
		return { hops: [...server.hops], run, url: server.url }
	})
}

/** A hook run as `<call> <phase> <index>`, its retry flag and status when it has them. */
const step = (h: HookTrace) =>
	[h.call, h.phase, h.index, h.isRetry ? "retry" : "", h.status ?? ""].filter((part) => part !== "").join(" ")

/** A Rust error as the trace records it: no source and the method's own Err unless given, any Debug text. */
const plain = (entry: Partial<RustError>) => ({ debug: expect.any(String), source: false, via: "return", ...entry })

/** on_log entries, as the trace records them. */
const start = { event: "request_start", level: "debug", operation: OPERATION }
const received = (level: string, status: number) => ({
	event: "response_received",
	level,
	operation: OPERATION,
	status,
})
const failed = (error: unknown, status?: number) => ({
	error,
	event: "error",
	level: "error",
	operation: OPERATION,
	...(status === undefined ? {} : { status }),
})

/** Every value of `log` that no entry may carry (G19 redaction): [] when it is clean. */
const secrets = (log: readonly LogTrace[] | undefined) =>
	[ORG, USER_ID, QUERY, TOKEN, HEADER].filter((value) => JSON.stringify(log ?? null).includes(value))

/** The stale fields of a client without invalidation, as every hook sees them. */
const OFF = { invalidatedBy: [], isRetry: false, isStale: false, selector: "" }

/** What request hook `index` of call 0 saw of GET against `url`. */
const asked = (index: number, url: string) => ({
	...OFF,
	call: 0,
	index,
	method: "GET",
	path: CONCRETE,
	phase: "request",
	url: `${url}${CONCRETE}?ids=${QUERY}`,
})

type Hooks = NonNullable<Script["hooks"]>

/** GET once with on_log on, under these request and response hooks. */
const failing = (request: Hooks["request"], response: Hooks["response"]) =>
	drive([FOUND], [GET], { hooks: { request, response }, log: true })

/** A failing-hook run as the test reads it: the call's error, the hops, the log, the observed and the hook runs. */
const outcome = ({ hops, run }: Awaited<ReturnType<typeof drive>>) => ({
	error: run.trace?.calls[0]?.error,
	hops: hops.length,
	log: run.trace?.log,
	observed: run.observed,
	order: run.trace?.hooks.map(step),
})

describe.skipIf(!RUST)("on_request and on_response hooks: declaration order", () => {
	// v0: 9cc3757568
	it("run in declaration order on every call: the last header set is sent, the last body set decodes", async () => {
		const hooks: Script["hooks"] = {
			request: [{ setHeader: ["X-Hooked", "first"] }, { setHeader: ["X-Hooked", "second"] }],
			response: [{ body: '{"id":"r0","name":"first"}' }, { body: '{"id":"r1","name":"second"}' }],
		}
		const { hops, run, url } = await drive([FOUND, FOUND], [GET, GET], { hooks })
		expect({
			first: run.trace?.hooks.slice(0, 4),
			observed: run.observed,
			order: run.trace?.hooks.map(step),
			sent: hops.map((h) => h.headers["x-hooked"]),
		}).toEqual({
			first: [
				asked(0, url),
				asked(1, url),
				{ ...OFF, call: 0, index: 0, phase: "response", status: 200 },
				{ ...OFF, call: 0, index: 1, phase: "response", status: 200 },
			],
			observed: [data({ id: "r1", name: "second" }), data({ id: "r1", name: "second" })],
			order: [
				"0 request 0",
				"0 request 1",
				"0 response 0 200",
				"0 response 1 200",
				"1 request 0",
				"1 request 1",
				"1 response 0 200",
				"1 response 1 200",
			],
			sent: ["second", "second"],
		})
	}, 600_000)
})

describe.skipIf(!RUST)("on_request and on_response hooks: a hook's error (Fc2)", () => {
	// v0: 081fe273c4
	// v0: c52a08eb7e
	it("ends the call as Error::Hook, its source the hook's error, runs no later hook, and reaches on_log as the error entry", async () => {
		const [before, after] = await Promise.all([
			failing([{ fail: "boom" }, {}], [{}]),
			failing([{}], [{ fail: "bad" }, { body: '{"id":"x","name":"x"}' }]),
		])
		expect({ after: outcome(after), before: outcome(before) }).toEqual({
			after: {
				error: plain({ source: true, text: "hook: bad", variant: "Hook" }),
				hops: 1,
				log: [start, failed("hook: bad")],
				observed: [null],
				order: ["0 request 0", "0 response 0 200"],
			},
			before: {
				error: plain({ source: true, text: "hook: boom", variant: "Hook" }),
				hops: 0,
				log: [start, failed("hook: boom")],
				observed: [null],
				order: ["0 request 0"],
			},
		})
	}, 600_000)
})

describe.skipIf(!RUST)("on_request and on_response hooks: an auth retry", () => {
	// v0: 9cc3757568
	it("runs every hook again with is_retry, its request carrying what they set; on_log sees one exchange", async () => {
		const script: Script = {
			hooks: { request: [{ setHeader: ["X-Hooked", "1"] }], response: [{}] },
			log: true,
			onAuthExpired: { tokens: ["tok-new"] },
		}
		const { hops, run } = await drive([{ status: 401 }, FOUND], [GET], script, BEARER)
		expect({
			expired: run.trace?.authExpired,
			hops: hops.map((h) => [h.headers.authorization, h.headers["x-hooked"]]),
			log: run.trace?.log,
			observed: run.observed,
			order: run.trace?.hooks.map(step),
		}).toEqual({
			expired: 1,
			hops: [
				[`Bearer ${TOKEN}`, "1"],
				["Bearer tok-new", "1"],
			],
			log: [start, received("info", 200)],
			observed: [data({ id: "u", name: "found" })],
			order: ["0 request 0", "0 response 0 401", "0 request 0 retry", "0 response 0 retry 200"],
		})
	}, 600_000)
})

describe.skipIf(!RUST)("on_request and on_response hooks: what a consumer's hook reads", () => {
	// v0: c241ecd603
	it("shares the state map between a call's hooks, and a caller's ClientConfig::state is that map", async () => {
		const { run } = await hooks()
		expect(seen(run, "state"), run.stderr).toEqual({ built: true, out: ["state r1", "caller r1"] })
	}, 600_000)

	// v0: 3d145530bf
	it("hands on_request the generated v4 X-Request-Id, and sends the one it sets in its place", async () => {
		const { hops, run } = await hooks()
		expect({ ...seen(run, "request-id"), sent: hops[2]?.headers["x-request-id"] }, run.stderr).toEqual({
			built: true,
			out: ["seen v4 true"],
			sent: "hooked",
		})
	}, 600_000)
})

describe.skipIf(!RUST)(
	"on_log: the exchange by its operation template, never a path value, header value, query or token",
	() => {
		it("logs request_start, then response_received at info for a 2xx, warn plus an error entry for an error status", async () => {
			const missing: Reply = { json: { message: "no such user" }, status: 404 }
			const { run } = await drive([FOUND, missing], [GET, GET], { log: true }, BEARER)
			expect({ log: run.trace?.log, secrets: secrets(run.trace?.log) }).toEqual({
				log: [start, received("info", 200), start, received("warn", 404), failed("HTTP 404: no such user", 404)],
				secrets: [],
			})
		}, 600_000)

		it("logs request_start then an error entry with no status when no answer arrives, naming no secret", async () => {
			const closed = REFUSED_URL
			const run = await hooksSdk().runCalls({ calls: [GET], setup: BEARER }, { url: closed }, { log: true })
			expect(
				{ log: run.trace?.log, observed: run.observed, secrets: secrets(run.trace?.log), status: run.status },
				run.stderr,
			).toEqual({
				log: [start, failed(expect.stringContaining("transport: "))],
				observed: [null],
				secrets: [],
				status: 0,
			})
		}, 600_000)

		it("logs a call dropped in flight as an error entry with no status; a call canceled before it starts logs nothing", async () => {
			const late: Reply = { ...FOUND, delayMs: 2000 }
			const [inflight, before] = await Promise.all([
				drive([late], [GET], { calls: [{ cancel: { afterMs: 300 } }], log: true }, BEARER),
				drive([FOUND], [GET], { calls: [{ cancel: "before" }], log: true }, BEARER),
			])
			const read = ({ hops, run }: typeof before) => ({
				hops: hops.length,
				log: run.trace?.log,
				observed: run.observed,
			})
			expect({ before: read(before), inflight: read(inflight), secrets: secrets(inflight.run.trace?.log) }).toEqual({
				before: { hops: 0, log: [], observed: [null] },
				inflight: { hops: 1, log: [start, failed("the call was canceled")], observed: [null] },
				secrets: [],
			})
		}, 600_000)
	},
)

describe.skipIf(!RUST)("redaction and isolation: what a consumer can print or break", () => {
	it("prints no credential, URL user info or query, header value or response cookie in a Debug; a hook sees the credential as Sensitive", async () => {
		const { run } = await hooks()
		expect(seen(run, "redaction"), run.stderr).toEqual({
			built: true,
			out: ["config leaks false", "client leaks false", "auth Some(Sensitive)", "error leaks false"],
		})
	}, 600_000)

	it("catches a panicking on_log: the call still answers", async () => {
		const { run } = await hooks()
		expect(seen(run, "panic"), run.stderr).toEqual({ built: true, out: ["ok"] })
	}, 600_000)
})

/** The consumer's helpers: hooks from closures (signatures taken from the bound), a v4 check, a leak check. */
const HELPERS = `fn on_request<F>(f: F) -> sdk::OnRequestHook
where
    F: for<'a> Fn(&'a mut sdk::RequestContext) -> sdk::HookFuture<'a> + Send + Sync + 'static,
{
    std::sync::Arc::new(f)
}

fn on_response<F>(f: F) -> sdk::OnResponseHook
where
    F: for<'a> Fn(&'a mut sdk::ResponseContext) -> sdk::HookFuture<'a> + Send + Sync + 'static,
{
    std::sync::Arc::new(f)
}

fn mark(ctx: &mut sdk::RequestContext) -> sdk::HookFuture<'_> {
    Box::pin(async move {
        ctx.state.lock().await.insert("seen".to_owned(), serde_json::json!("r1"));
        Ok::<(), sdk::Error>(())
    })
}

type Lines = std::sync::Arc<std::sync::Mutex<Vec<String>>>;

fn noted(n: &mut Notes, lines: &Lines) {
    for line in lines.lock().expect("lock").iter() {
        n.note(line.clone());
    }
}

fn is_v4(id: &str) -> bool {
    let b = id.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            14 => *c == b'4',
            19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

fn leaks(text: &str) -> bool {
    text.contains("s3cret") || text.contains("pw-9")
}`

/** Sections run in order against one server: state 2 hops, request-id 1 (hop 2), redaction 1 (a 500), panic 1. */
const HOOKS = sections({
	state: `    let lines: Lines = Default::default();
    let out = std::sync::Arc::clone(&lines);
    let c = sdk::Client::new(sdk::ClientConfig {
        base_url: base.into(),
        on_request: vec![std::sync::Arc::new(mark)],
        on_response: vec![on_response(move |ctx| {
            let out = std::sync::Arc::clone(&out);
            Box::pin(async move {
                let state = ctx.state.lock().await;
                let value = state.get("seen").and_then(|v| v.as_str()).unwrap_or("none");
                out.lock().expect("lock").push(format!("state {value}"));
                Ok::<(), sdk::Error>(())
            })
        })],
        ..Default::default()
    })?;
    c.echo().get(&sdk::EchoGetOpts::default()).await?;
    noted(n, &lines);
    let shared: sdk::HookState = Default::default();
    let c = sdk::Client::new(sdk::ClientConfig {
        base_url: base.into(),
        on_request: vec![std::sync::Arc::new(mark)],
        state: Some(std::sync::Arc::clone(&shared)),
        ..Default::default()
    })?;
    c.echo().get(&sdk::EchoGetOpts::default()).await?;
    let value = shared.lock().await.get("seen").and_then(|v| v.as_str().map(str::to_owned));
    n.note(format!("caller {}", value.unwrap_or_default()));`,
	"request-id": `    let lines: Lines = Default::default();
    let out = std::sync::Arc::clone(&lines);
    let c = sdk::Client::new(sdk::ClientConfig {
        base_url: base.into(),
        on_request: vec![on_request(move |ctx| {
            let out = std::sync::Arc::clone(&out);
            Box::pin(async move {
                let id = ctx.headers.get("x-request-id").and_then(|v| v.to_str().ok()).unwrap_or("");
                out.lock().expect("lock").push(format!("seen v4 {}", is_v4(id)));
                ctx.headers.insert("x-request-id", reqwest::header::HeaderValue::from_static("hooked"));
                Ok::<(), sdk::Error>(())
            })
        })],
        ..Default::default()
    })?;
    c.echo().get(&sdk::EchoGetOpts::default()).await?;
    noted(n, &lines);`,
	redaction: `    let cfg = sdk::ClientConfig {
        base_url: "http://u:pw-9@h.test/v1?api_key=s3cret-q".into(),
        bearer_token: Some("s3cret-b".into()),
        api_key: Some("s3cret-k".into()),
        headers: [("X-Secret".to_owned(), "s3cret-h".to_owned())].into_iter().collect(),
        ..Default::default()
    };
    n.note(format!("config leaks {}", leaks(&format!("{cfg:?}"))));
    let c = sdk::Client::new(cfg)?;
    n.note(format!("client leaks {}", leaks(&format!("{c:?}"))));
    let lines: Lines = Default::default();
    let out = std::sync::Arc::clone(&lines);
    let c = sdk::Client::new(sdk::ClientConfig {
        base_url: base.into(),
        bearer_token: Some("s3cret-b".into()),
        on_request: vec![on_request(move |ctx| {
            let out = std::sync::Arc::clone(&out);
            Box::pin(async move {
                out.lock().expect("lock").push(format!("auth {:?}", ctx.headers.get("authorization")));
                Ok::<(), sdk::Error>(())
            })
        })],
        ..Default::default()
    })?;
    let answered = c.echo().get(&sdk::EchoGetOpts::default()).await;
    noted(n, &lines);
    match answered {
        Err(e) => n.note(format!("error leaks {}", leaks(&format!("{e:?}")))),
        Ok(_) => n.note("answered"),
    }`,
	panic: `    let c = sdk::Client::new(sdk::ClientConfig {
        base_url: base.into(),
        on_log: Some(std::sync::Arc::new(|_: sdk::LogEntry| -> () { panic!("a faulty logger") })),
        ..Default::default()
    })?;
    c.echo().get(&sdk::EchoGetOpts::default()).await?;
    n.note("ok");`,
})

/** The answers, section by section: two echoes; one; a 500 setting a cookie; one. */
const HOOKS_REPLIES: readonly Reply[] = [
	{ json: { ok: true }, status: 200 },
	{ json: { ok: true }, status: 200 },
	{ json: { ok: true }, status: 200 },
	{ headers: { "set-cookie": "sid=s3cret-c" }, json: { message: "boom" }, status: 500 },
	{ json: { ok: true }, status: 200 },
]

/** Consumer `hooks` on `http`, built and run once against one server: its run and every hop. */
const hooks = once(() =>
	served(HOOKS_REPLIES, async (server) => {
		const run = await consume("http", "hooks", { ...HOOKS, base: server.url, decls: `${HOOKS.decls}\n\n${HELPERS}` })
		return { hops: [...server.hops], run }
	}),
)
