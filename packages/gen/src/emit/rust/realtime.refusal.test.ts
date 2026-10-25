/**
 * A refusal ends a Rust realtime connection (bit 19 e, carry-in #6): a deterministic 4xx (400, 401, 403, 404, 405,
 * 410, 422) from every transport of the chain, or from the open transport, is the connection's end, its typed error
 * returned at once; the reconnect loop never backs off over it. A transient status (408, 429, 5xx) or a transport
 * error keeps reconnecting until the attempts run out. Within one open, a refused transport still falls through to
 * the next (a refused upgrade is how a server says it has no WebSocket), so the chain's failure is a refusal only when
 * every transport refused. Dials are counted on the recording server's hops.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, sections } from "./__fixtures__/consumer.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

const RUST = withRust()

/** The `realtime` SDK compiled with the driver, which must build. */
function driven(): DrivenRustSdk {
	const sdk = drivenRustSdk("realtime")
	expect({ built: sdk.built }, sdk.stderr).toEqual({ built: true })
	return sdk
}

const LIVE: Call = {
	operation: "feed.live",
	route: { method: "GET", path: "/feed" },
	search: { channel: "c" },
	take: 1,
}
/* two reconnects at most, a millisecond apart: a retried status shows as hops past the first chain's three */
const TWO: Script = { calls: [{ realtime: { maxReconnectAttempts: 2, reconnectDelayMs: 1 } }] }
/** Every dial answered `status`: the upgrade, the event stream, each poll. */
const every = (status: number): Reply[] => Array.from({ length: 12 }, () => ({ json: { message: "no" }, status }))

/** The feed opened under TWO against a server answering every dial `status`: its hops, and the error it returned. */
async function refusedWith(status: number) {
	const sdk = driven()
	const { hops, run } = await served(every(status), async (server) => {
		const ran = await sdk.runCalls({ calls: [LIVE], setup: {} }, server, TWO)
		return { hops: [...server.hops], run: ran }
	})
	const error = run.trace?.calls[0]?.error
	return { dials: hops.length, error: error && [error.variant, error.status] }
}

/**
 * A caller's [SSE, WebSocket] chain under three reconnects: one event, the stream's close, then the reconnects'
 * chains until the connection ends; the notes are the event, the error and the state.
 */
const CHAIN = sections({
	chain: `    let c = sdk::Client::new(sdk::ClientConfig { base_url: base.into(), ..Default::default() })?;
    let opts = sdk::TransportOpts { max_reconnect_attempts: Some(3), reconnect_delay_ms: Some(1), ..Default::default() };
    let chain: Vec<Box<dyn sdk::Transport>> = vec![Box::new(sdk::SseTransport::new(&c)), Box::new(sdk::WsTransport::new(&c))];
    let mut rc = sdk::ResumableConnection::<Value>::connect(format!("{base}/feed"), opts, chain).await?;
    for _ in 0..2 {
        match tokio::time::timeout(Duration::from_secs(10), rc.recv()).await {
            Ok(Some(Ok(v))) => n.note(v.to_string()),
            Ok(Some(Err(e))) => n.note(format!("{:?} {:?}", e.status(), rc.state())),
            Ok(None) => n.note("none"),
            Err(_) => n.note("stalled"),
        }
    }`,
})
const no = (status: number): Reply => ({ json: { message: "no" }, status })

/**
 * `expiring`: a client sending `old`, whose `on_auth_expired` counts its calls and answers `new`. `opened`: the
 * [WebSocket, SSE] chain over a client: the status its open failed with, else its transport and first event.
 */
const DECLS = `type Refreshed = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>, sdk::Error>> + Send>>;

fn expiring(base: &str, calls: Arc<AtomicUsize>) -> Result<sdk::Client, sdk::Error> {
    let hook: sdk::OnAuthExpiredHook = Arc::new(move |_| -> Refreshed {
        calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(Some("new".to_owned())) })
    });
    sdk::Client::new(sdk::ClientConfig { base_url: base.into(), bearer_token: Some("old".into()), on_auth_expired: Some(hook), ..Default::default() })
}

async fn opened(c: &sdk::Client, base: &str) -> String {
    let chain: Vec<Box<dyn sdk::Transport>> = vec![Box::new(sdk::WsTransport::new(c)), Box::new(sdk::SseTransport::new(c))];
    match sdk::ResumableConnection::<Value>::connect(format!("{base}/feed"), sdk::TransportOpts::default(), chain).await {
        Err(e) => format!("{:?}", e.status()),
        Ok(mut rc) => match tokio::time::timeout(Duration::from_secs(10), rc.recv()).await {
            Ok(Some(Ok(v))) => format!("{:?} {v}", rc.transport()),
            _ => "no event".to_owned(),
        },
    }
}`
const IMPORTS = [
	"serde_json::Value",
	"std::sync::Arc",
	"std::sync::atomic::{AtomicUsize, Ordering}",
	"std::time::Duration",
]

/** A hop as its kind and the credential it sent. */
const dialed = (h: RecordedHop) =>
	`${h.headers.upgrade === "websocket" ? "upgrade" : "sse"} ${h.headers.authorization ?? "-"}`

/** Consumer `name` running `body` against a server answering `replies`: its notes, and each hop as its kind and credential. */
async function chained(name: string, body: string, replies: readonly Reply[]) {
	const program = sections({ [name]: body })
	const { hops, run } = await served(replies, async (server) => {
		const decls = `${program.decls}\n\n${DECLS}`
		const ran = await consume("realtime", name, { ...program, base: server.url, decls, imports: IMPORTS })
		return { hops: [...server.hops], run: ran }
	})
	return {
		dials: hops.map(dialed),
		out: run.out?.[name],
		stderr: run.stderr,
	}
}

describe.skipIf(!RUST)("a refusal ends a Rust realtime connection; a transient status backs off (bit 19 e)", () => {
	it.each([400, 401, 403, 404, 405, 410, 422])(
		"ends at %i from every transport: the first chain's three dials, the typed error, no reconnect",
		async (status) => {
			expect(await refusedWith(status)).toEqual({ dials: 3, error: ["Api", status] })
		},
		600_000,
	)

	it.each([408, 429, 503])(
		"backs off over %i: the first chain and two reconnects' chains, nine dials, then the error",
		async (status) => {
			expect(await refusedWith(status)).toEqual({ dials: 9, error: ["Api", status] })
		},
		600_000,
	)
})

describe.skipIf(!RUST)("the failure of a chain that did not open, and its one refresh (bit 19 e)", () => {
	it("ends a chain only when every transport refused: a 503 then a 404 retries, two 404s end it", async () => {
		const stream: Reply = { sse: { end: "close", steps: ['data: {"n":1}\n\n'] }, status: 200 }
		const replies = [stream, no(503), no(404), no(404), no(404), no(503), no(503)]
		const { hops, run } = await served(replies, async (server) => {
			const ran = await consume("realtime", "chain", {
				...CHAIN,
				base: server.url,
				imports: ["serde_json::Value", "std::time::Duration"],
			})
			return { hops: server.hops.length, run: ran }
		})
		expect({ hops, out: run.out?.chain }, run.stderr).toEqual({ hops: 5, out: ['{"n":1}', "Some(404) Disconnected"] })
	}, 600_000)

	it("surfaces the most specific refusal when every transport refused: 401 > 403 > 422 > 400 > 410 > 404 = 405, a tie the first", async () => {
		const body = `    let c = sdk::Client::new(sdk::ClientConfig { base_url: base.into(), ..Default::default() })?;
    for _ in 0..5 {
        n.note(opened(&c, base).await);
    }`
		const pairs: [number, number][] = [
			[401, 404],
			[404, 401],
			[422, 403],
			[405, 404],
			[404, 404],
		]
		const { out, stderr } = await chained("rank", body, pairs.flat().map(no))
		expect(out, stderr).toEqual(["Some(401)", "Some(401)", "Some(403)", "Some(405)", "Some(404)"])
	}, 600_000)

	it("refreshes once on a 401 and restarts the chain from its first transport with the new token", async () => {
		const body = `    let calls = Arc::new(AtomicUsize::new(0));
    let c = expiring(base, Arc::clone(&calls))?;
    n.note(opened(&c, base).await);
    n.note(calls.load(Ordering::SeqCst).to_string());`
		const stream: Reply = { sse: { end: "hold", steps: ['data: {"n":1}\n\n'] }, status: 200 }
		expect(await chained("refresh", body, [no(404), no(401), no(404), stream])).toMatchObject({
			dials: ["upgrade Bearer old", "sse Bearer old", "upgrade Bearer new", "sse Bearer new"],
			out: ['Some(Sse) {"n":1}', "1"],
		})
	}, 600_000)

	it("refreshes once per open: a second 401 in the restarted chain is a refusal like the others", async () => {
		const body = `    let calls = Arc::new(AtomicUsize::new(0));
    let c = expiring(base, Arc::clone(&calls))?;
    n.note(opened(&c, base).await);
    n.note(calls.load(Ordering::SeqCst).to_string());`
		const replies = [no(404), no(401), no(401), no(404), ...Array.from({ length: 6 }, () => no(404))]
		expect(await chained("twice", body, replies)).toMatchObject({
			dials: ["upgrade Bearer old", "sse Bearer old", "upgrade Bearer new", "sse Bearer new"],
			out: ["Some(401)", "1"],
		})
	}, 600_000)
})
