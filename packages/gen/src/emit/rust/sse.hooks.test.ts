/**
 * An SSE open runs through phase c's exchange (contract 20 §5.2; the Go `sse.test.ts:374-487` analog): its
 * typed `<Op>Headers` are filled at the open, and the `on_request` and `on_response` hooks, the 401 refresh and
 * `on_log` run on it as on a plain call. A hook's body replaces an error status's; a failing hook ends the open
 * as `Error::Hook` with the stream unread; the refreshed token is the client's current one, which a later open
 * sends; and every log entry names only the operation template, never a header value, query, path value or
 * token. Driven on the `sse` registry document (documents-streams.ts).
 */
import { describe, expect, it } from "vitest"
import type { Call, Observed, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { HookTrace, LogTrace, Script } from "../shared/__fixtures__/protocol.ts"
import { gone } from "../shared/__fixtures__/gone.ts"
import { type Reply, served, REFUSED_URL } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { consume, seen, sections } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

const route = (method: string, path: string) => ({ method, path })
const ticks = (extra: Partial<Call> = {}): Call => ({
	operation: "ticks.stream",
	route: route("GET", "/ticks"),
	...extra,
})
const pending = (id: string): Call => ({
	operation: "pending.stream",
	params: { id },
	route: route("GET", "/pending/{id}"),
})

const sse = (steps: readonly (string | { waitMs: number })[], end: "close" | "drop" | "hold" = "close"): Reply => ({
	sse: { end, steps },
	status: 200,
})
const TICK = sse(['data: {"n":1}\n\n'])
/* a held typed stream: only the client leaving ends it */
const HELD = sse(['id: 7\ndata: {"n":1}\n\n', { waitMs: 50 }, 'data: {"n":2}\n\n'], "hold")
const NOPE: Reply = { json: { message: "nope" }, status: 404 }
const TICKED: Observed = { events: [{ data: { n: 1 } }], kind: "events" }

let memo: DrivenRustSdk | undefined
/** The `sse` SDK compiled with the driver, once: it must build. */
function sseSdk(): DrivenRustSdk {
	memo ??= drivenRustSdk("sse")
	expect({ built: memo.built }, memo.stderr).toEqual({ built: true })
	return memo
}

/** `calls` under `script` against a server answering `replies`: the run (which must exit 0), hops, streams and origin. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script, setup: Setup = {}) {
	const sdk = sseSdk()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, server, script)
		expect(run.status, run.stderr).toBe(0)
		return { hops: [...server.hops], run, streams: [...server.streams], url: server.url }
	})
}

/** The hook runs as `<call> <phase> <index>`, a retry flag and status when they have them, joined by `|`. */
const steps = (hooks: readonly HookTrace[] | undefined) =>
	hooks
		?.map((h) => [h.call, h.phase, h.index, h.isRetry ? "retry" : "", h.status ?? ""].filter((p) => p !== "").join(" "))
		.join(" | ")

/** An on_log entry as the trace records it, named by the operation template. */
const logged = (operation: string, event: string, level: string, extra: Partial<LogTrace> = {}) => ({
	event,
	level,
	operation,
	...extra,
})
const TICKS = "GET /ticks"
const PENDING = "GET /pending/{id}"
const start = (operation: string) => logged(operation, "request_start", "debug")
const answered = (operation: string, level: string, status: number) =>
	logged(operation, "response_received", level, { status })

describe.skipIf(!RUST)("an SSE open's typed response headers and request hooks", () => {
	it("fills <Op>Headers at the open, and runs the request hooks on it, their header sent", async () => {
		const reply: Reply = { ...TICK, headers: { "x-stream-id": "s-1" } }
		const script: Script = { hooks: { request: [{ setHeader: ["x-hook", "1"] }] } }
		const { hops, run, url } = await drive([reply], [ticks()], script)
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: [TICKED],
			stream: { headers: { "x-stream-id": "s-1" }, retry: [null], yields: 1 },
		})
		expect({
			hook: hops.map((hop) => hop.headers["x-hook"]),
			ran: run.trace?.hooks.filter((hook) => hook.phase === "request"),
		}).toEqual({
			hook: ["1"],
			ran: [
				{
					call: 0,
					index: 0,
					invalidatedBy: [],
					isRetry: false,
					isStale: false,
					method: "GET",
					path: "/ticks",
					phase: "request",
					selector: "",
					url: `${url}/ticks`,
				},
			],
		})
	}, 600_000)
})

describe.skipIf(!RUST)("an SSE open through a plain call's pipeline: the on_response hooks", () => {
	it("runs them in order on the open, and an error status's last body set is the one observed", async () => {
		/* a 2xx stream's body is never buffered: its events come from the stream, whatever a hook set */
		const script: Script = { hooks: { response: [{}, { body: '{"message":"hooked"}' }] } }
		const { run } = await drive([TICK, NOPE], [ticks(), ticks()], script)
		expect({ observed: run.observed, order: steps(run.trace?.hooks) }, run.stderr).toEqual({
			observed: [TICKED, { body: { message: "hooked" }, errorKey: null, kind: "error", status: 404 }],
			order: "0 request 0 | 0 response 0 200 | 0 response 1 200 | 1 request 0 | 1 response 0 404 | 1 response 1 404",
		})
	}, 600_000)

	it("ends the open as Error::Hook when one fails: no stream, no later hook, the connection let go unread", async () => {
		/* a second call's answer waits until the first stream's client left (gone.ts): the driver still runs */
		const next = gone(TICK)
		const { run } = await drive([HELD, next.reply], [ticks(), ticks()], { hooks: { response: [{ fail: "bad" }, {}] } })
		const errors = run.trace?.calls.map(({ error }) => [error?.variant, error?.text, error?.via])
		expect(
			{ errors, observed: run.observed, order: steps(run.trace?.hooks), released: next.released() },
			run.stderr,
		).toEqual({
			errors: [
				["Hook", "hook: bad", "return"],
				["Hook", "hook: bad", "return"],
			],
			observed: [null, null],
			order: "0 request 0 | 0 response 0 200 | 1 request 0 | 1 response 0 200",
			released: true,
		})
	}, 600_000)
})

describe.skipIf(!RUST)("an SSE open's 401: one refresh, its token the client's current one", () => {
	it("refreshes once and streams on the retry, every hook again with isRetry, on_log one exchange", async () => {
		const script: Script = { hooks: { response: [{}] }, log: true, onAuthExpired: { tokens: ["new"] } }
		const replies: Reply[] = [{ json: { message: "expired" }, status: 401 }, TICK]
		const { hops, run } = await drive(replies, [ticks()], script, { auth: { kind: "bearer", token: "old" } })
		expect(
			{
				auth: hops.map((hop) => hop.headers.authorization),
				error: run.trace?.calls[0]?.error,
				expired: run.trace?.authExpired,
				log: run.trace?.log,
				observed: run.observed,
				order: steps(run.trace?.hooks),
			},
			run.stderr,
		).toEqual({
			auth: ["Bearer old", "Bearer new"],
			error: undefined,
			expired: 1,
			log: [start(TICKS), answered(TICKS, "info", 200)],
			observed: [TICKED],
			order: "0 request 0 | 0 response 0 401 | 0 request 0 retry | 0 response 0 retry 200",
		})
	}, 600_000)

	it("sends the refreshed token on the next open, never the one the client was built with", async () => {
		const script: Script = { onAuthExpired: { tokens: ["new"] } }
		const replies: Reply[] = [{ json: { message: "expired" }, status: 401 }, TICK, TICK]
		const { hops, run } = await drive(replies, [ticks(), ticks()], script, { auth: { kind: "bearer", token: "old" } })
		expect(
			{
				auth: hops.map((hop) => hop.headers.authorization),
				expired: run.trace?.authExpired,
				observed: run.observed,
			},
			run.stderr,
		).toEqual({ auth: ["Bearer old", "Bearer new", "Bearer new"], expired: 1, observed: [TICKED, TICKED] })
	}, 600_000)
})

/* values no log entry may carry: a header value, a query value, a path value and the token */
const SECRETS = ["t-secret", "987654321", "p-secret", "tok-secret"]
/** The secrets `logs` carry, as JSON: [] when they are clean (G19 redaction). */
const leaked = (...logs: (readonly LogTrace[] | undefined)[]) =>
	SECRETS.filter((value) => JSON.stringify(logs).includes(value))

describe.skipIf(!RUST)("an SSE open through a plain call's pipeline: on_log, by the operation template only", () => {
	it("logs request_start, then response_received at info for a 2xx, warn plus an error entry for an error status", async () => {
		const calls = [
			ticks({ headers: { "x-tenant": "t-secret" }, search: { since: 987654321 } }),
			ticks(),
			pending("p-secret"),
		]
		const setup: Setup = { auth: { kind: "bearer", token: "tok-secret" } }
		const { hops, run } = await drive([TICK, NOPE, sse(["data: x\n\n"])], calls, { log: true }, setup)
		expect({ log: run.trace?.log, observed: run.observed }, run.stderr).toEqual({
			log: [
				start(TICKS),
				answered(TICKS, "info", 200),
				start(TICKS),
				answered(TICKS, "warn", 404),
				logged(TICKS, "error", "error", { error: "404 Not Found: nope", status: 404 }),
				start(PENDING),
				answered(PENDING, "info", 200),
			],
			observed: [
				TICKED,
				{ body: { message: "nope" }, errorKey: null, kind: "error", status: 404 },
				{ events: [{ data: "x" }], kind: "events" },
			],
		})
		/* the secrets did reach the wire: the log is what leaves them out */
		expect(hops.map((hop) => [hop.url, hop.headers["x-tenant"], hop.headers.authorization])[0]).toEqual([
			"/ticks?since=987654321",
			"t-secret",
			"Bearer tok-secret",
		])
		expect(leaked(run.trace?.log)).toEqual([])
	}, 600_000)

	it("logs request_start then an error entry with no status when no answer arrives, naming no secret", async () => {
		const closed = REFUSED_URL
		const setup: Setup = { auth: { kind: "bearer", token: "tok-secret" } }
		const run = await sseSdk().runCalls({ calls: [pending("p-secret")], setup }, { url: closed }, { log: true })
		expect({ log: run.trace?.log, observed: run.observed, status: run.status }, run.stderr).toEqual({
			log: [start(PENDING), logged(PENDING, "error", "error", { error: expect.stringMatching(/^transport: /) })],
			observed: [null],
			status: 0,
		})
		expect(leaked(run.trace?.log)).toEqual([])
	}, 600_000)
})

/** Each request hook run as `<ctx.path> <ctx.url>`; a test program's own record, read once the dials are done. */
const PATHS = `static SEEN: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

fn seen_by(ctx: &mut sdk::RequestContext) -> sdk::HookFuture<'_> {
    SEEN.lock().expect("seen").push(format!("{} {}", ctx.path, ctx.url.as_str()));
    Box::pin(async { Ok(()) })
}`

/** A standalone SseTransport, then a LongpollTransport resuming from 7, each handed the same escaped URL. */
const STANDALONE = sections({
	standalone: `    let c = sdk::Client::new(sdk::ClientConfig { base_url: base.into(), on_request: vec![std::sync::Arc::new(seen_by)], ..Default::default() })?;
    let url = format!("{base}/a%2Fb%20c/feed?q=a%20b");
    let chain: Vec<Box<dyn sdk::Transport>> = vec![Box::new(sdk::SseTransport::new(&c))];
    let mut rc: sdk::ResumableConnection = sdk::ResumableConnection::connect(url.as_str(), sdk::TransportOpts::default(), chain).await?;
    n.note(format!("{:?}", rc.recv().await.map(|r| r.is_ok())));
    let opts = sdk::TransportOpts { last_event_id: Some("7".into()), ..Default::default() };
    let chain: Vec<Box<dyn sdk::Transport>> = vec![Box::new(sdk::LongpollTransport::new(&c))];
    let mut rc: sdk::ResumableConnection = sdk::ResumableConnection::connect(url.as_str(), opts, chain).await?;
    n.note(format!("{:?}", rc.recv().await.map(|r| r.is_ok())));
    for line in SEEN.lock().expect("seen").iter() {
        n.note(line.replace(base, ""));
    }`,
})

describe.skipIf(!RUST)("a standalone adapter's dial: the request hooks see the handed URL's own path", () => {
	it("runs the hooks with ctx.path the URL's path, the URL sent as it was handed, its escapes kept", async () => {
		/* ruled: as a method dial's hook sees its operation's path, a standalone dial's sees its URL's, never "" */
		const replies = [sse(['data: {"n":1}\n\n'], "hold"), { json: { n: 2 }, status: 200 }]
		const { hops, run } = await served(replies, async (server) => {
			const decls = `${STANDALONE.decls}\n\n${PATHS}`
			const ran = await consume("realtime", "standalone", { base: server.url, body: STANDALONE.body, decls })
			return { hops: server.hops.map((hop) => hop.url), run: ran }
		})
		const sent = ["/a%2Fb%20c/feed?q=a%20b", "/a%2Fb%20c/feed?q=a%20b&last_event_id=7"]
		expect({ ...seen(run, "standalone"), hops }, run.stderr).toEqual({
			built: true,
			hops: sent,
			out: ["Some(true)", "Some(true)", ...sent.map((url) => `/a%2Fb%20c/feed ${url}`)],
		})
	}, 600_000)
})
