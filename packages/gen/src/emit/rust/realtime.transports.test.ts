/**
 * Realtime transports (contract 20 §5.6, Fd1–Fd5; the Go `realtime.test.ts` transport legs): the public,
 * object-safe `Transport` trait and its three default adapters, chained WebSocket → SSE → long-poll; the
 * standalone SSE and long-poll adapters on the wire (the long-poll wire as Go's: the unified
 * `last_event_id`/`reconnect_token` cursor, one message per answer, a 204 polling again, no poll ahead of the
 * reader, each poll bounded at 60 s and never by the client's timeout), sending by POSTing the JSON to the
 * endpoint; each transport's `RawResponse` url; and `ResumableConnection` over a caller's in-process
 * transports: one session, a custom chain, a mid-stream drop resumed through the next transport with the
 * advanced cursor, a cancel-safe `recv`, and the give-up. Two consumer programs on `realtime`: `transports`
 * (in process; the server behind its URL sees nothing) and `adapters` (against the server).
 */
import { describe, expect, it } from "vitest"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, once, type Run, sections } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

const IMPORTS = ["serde_json::Value", "serde_json::json", "std::sync::Arc", "std::sync::Mutex", "std::time::Duration"]

/**
 * `Fake`, a caller's transport: its i-th connect opens `conns[i]` (`(texts, fail, delay ms)`) after its delay,
 * `None` or one past the end refusing; it records the cursor each connect was handed as
 * `<last_event_id>/<reconnect_token>` and every text sent. A `Conn` delivers its texts, then fails or holds.
 * `take` reads n values within 5 s each; `cursor` is the connection's cursor, proven transport and state.
 */
const DECLS = `fn err(e: &sdk::Error) -> String {
    let debug = format!("{e:?}");
    let variant: String = debug.chars().take_while(char::is_ascii_alphanumeric).collect();
    format!("{variant} {e}")
}

fn bearer(base: &str, timeout: Option<Duration>) -> Result<sdk::Client, sdk::Error> {
    sdk::Client::new(sdk::ClientConfig { base_url: base.into(), bearer_token: Some("tok".into()), timeout, ..Default::default() })
}

struct Conn {
    texts: Vec<String>,
    fail: bool,
    sent: Arc<Mutex<Vec<String>>>,
}

impl sdk::TransportConn for Conn {
    fn recv(&mut self) -> sdk::TransportFuture<'_, Option<Result<sdk::TransportMessage, sdk::Error>>> {
        Box::pin(async move {
            if !self.texts.is_empty() {
                let text = self.texts.remove(0);
                return Some(Ok(sdk::TransportMessage { text, ..Default::default() }));
            }
            if self.fail {
                return Some(Err(sdk::Error::Closed));
            }
            std::future::pending().await
        })
    }

    fn send<'a>(&'a mut self, text: &'a str) -> sdk::TransportFuture<'a, Result<(), sdk::Error>> {
        self.sent.lock().expect("sent").push(text.to_owned());
        Box::pin(std::future::ready(Ok(())))
    }

    fn close(&mut self) -> sdk::TransportFuture<'_, Result<(), sdk::Error>> {
        Box::pin(std::future::ready(Ok(())))
    }
}

type Opens = Vec<Option<(Vec<&'static str>, bool, u64)>>;

#[derive(Clone)]
struct Fake {
    kind: sdk::TransportKind,
    conns: Arc<Opens>,
    got: Arc<Mutex<Vec<String>>>,
    sent: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    fn new(kind: sdk::TransportKind, conns: Opens) -> Self {
        Fake { kind, conns: Arc::new(conns), got: Arc::default(), sent: Arc::default() }
    }

    fn got(&self) -> String {
        json!(*self.got.lock().expect("got")).to_string()
    }

    fn sent(&self) -> String {
        json!(*self.sent.lock().expect("sent")).to_string()
    }
}

impl sdk::Transport for Fake {
    fn name(&self) -> &str {
        "fake"
    }

    fn kind(&self) -> sdk::TransportKind {
        self.kind
    }

    fn connect<'a>(
        &'a self,
        _url: &'a str,
        opts: &'a sdk::TransportOpts,
    ) -> sdk::TransportFuture<'a, Result<Box<dyn sdk::TransportConn>, sdk::Error>> {
        let next = {
            let mut got = self.got.lock().expect("got");
            let at = |v: &Option<String>| v.clone().unwrap_or_default();
            got.push(format!("{}/{}", at(&opts.last_event_id), at(&opts.reconnect_token)));
            self.conns.get(got.len() - 1).cloned().flatten()
        };
        let sent = Arc::clone(&self.sent);
        Box::pin(async move {
            let Some((texts, fail, delay)) = next else {
                return Err(sdk::Error::Config("refused".into()));
            };
            tokio::time::sleep(Duration::from_millis(delay)).await;
            let texts = texts.into_iter().map(str::to_owned).collect();
            Ok(Box::new(Conn { texts, fail, sent }) as Box<dyn sdk::TransportConn>)
        })
    }
}

fn object_safe(_: Box<dyn sdk::Transport>) {}

async fn take<E: serde::de::DeserializeOwned + serde::Serialize>(rc: &mut sdk::ResumableConnection<E>, n: usize) -> String {
    let mut out = Vec::new();
    for _ in 0..n {
        out.push(match tokio::time::timeout(Duration::from_secs(5), rc.recv()).await {
            Ok(Some(Ok(v))) => serde_json::to_value(v).unwrap_or(Value::Null),
            Ok(Some(Err(e))) => json!({ "error": err(&e) }),
            Ok(None) => json!("none"),
            Err(_) => json!("stalled"),
        });
    }
    Value::Array(out).to_string()
}

fn cursor<E>(rc: &sdk::ResumableConnection<E>) -> String {
    let (id, token) = (rc.last_event_id().unwrap_or(""), rc.reconnect_token().unwrap_or(""));
    format!("{id}/{token} {:?} {:?}", rc.proven_transport(), rc.state())
}`

/** The in-process sections: none of them sends a request. */
const TRANSPORTS = sections({
	chain: `    let c = client(base)?;
    let chain: Vec<Box<dyn sdk::Transport>> =
        vec![Box::new(sdk::WsTransport::new(&c)), Box::new(sdk::SseTransport::new(&c)), Box::new(sdk::LongpollTransport::new(&c))];
    for t in &chain {
        n.note(format!("{} {:?}", t.name(), t.kind()));
    }
    object_safe(Box::new(sdk::WsTransport::new(&c)));
    object_safe(Box::new(sdk::SseTransport::new(&c)));
    object_safe(Box::new(sdk::LongpollTransport::new(&c)));
    n.note(format!("{:?}", [sdk::TransportKind::WebSocket, sdk::TransportKind::Sse, sdk::TransportKind::LongPoll]));
    let o = sdk::TransportOpts::default();
    n.note(format!("{:?} {:?} {:?} {:?} {:?}", o.last_event_id, o.reconnect_token, o.protocols, o.max_reconnect_attempts, o.reconnect_delay_ms));
    let _never_awaited = sdk::ResumableConnection::<serde_json::Value>::connect(format!("{base}/feed"), o, chain);`,
	session: `    let ws = Fake::new(sdk::TransportKind::WebSocket, vec![Some((vec![r#"{"n":1}"#], false, 0))]);
    let mut rc: sdk::ResumableConnection =
        sdk::ResumableConnection::connect("http://rt.test/feed", sdk::TransportOpts::default(), vec![Box::new(ws.clone())]).await?;
    n.note(format!("{:?} {:?}", rc.state(), rc.transport()));
    n.note(format!("send {:?} {}", rc.send(&json!({"hi": 1})).await.map_err(|e| err(&e)), ws.sent()));
    n.note(take(&mut rc, 1).await);
    n.note(format!("close {:?} {:?} {:?}", rc.close().await.map_err(|e| err(&e)), rc.state(), rc.transport()));
    n.note(format!("recv {:?}", rc.recv().await.map(|r| r.is_ok())));
    n.note(format!("send {:?}", rc.send(&json!({"hi": 2})).await.map_err(|e| err(&e))));`,
	custom: `    let texts = vec![r#"{"kind":"custom","seq":1}"#, r#"{"kind":"custom","seq":2}"#];
    let custom = Fake::new(sdk::TransportKind::WebSocket, vec![Some((texts, false, 0))]);
    let opts = sdk::TransportOpts::default();
    let mut rc: sdk::ResumableConnection =
        sdk::ResumableConnection::connect(format!("{base}/feed"), opts, vec![Box::new(custom.clone())]).await?;
    n.note(take(&mut rc, 2).await);
    n.note(format!("{} {:?}", custom.got(), rc.proven_transport()));`,
	resume: `    let flaky = Fake::new(sdk::TransportKind::WebSocket, vec![Some((
        vec![r#"{"id":"1","reconnect_token":"rt-1"}"#, r#"{"id":"2","reconnect_token":"rt-2"}"#], true, 0))]);
    let stable = Fake::new(sdk::TransportKind::Sse, vec![Some((vec![r#"{"id":"3","reconnect_token":"rt-3"}"#], false, 0))]);
    let opts = sdk::TransportOpts {
        last_event_id: Some("0".into()), reconnect_token: Some("rt-0".into()), reconnect_delay_ms: Some(10), ..Default::default()
    };
    let chain: Vec<Box<dyn sdk::Transport>> = vec![Box::new(flaky.clone()), Box::new(stable.clone())];
    let mut rc: sdk::ResumableConnection = sdk::ResumableConnection::connect("http://rt.test/feed", opts, chain).await?;
    n.note(take(&mut rc, 3).await);
    n.note(format!("{} {} {}", flaky.got(), stable.got(), cursor(&rc)));`,
	"cancel-safe": `    let ok = || Some((vec![r#"{"ok":true}"#], false, 200));
    let dying = Fake::new(sdk::TransportKind::WebSocket, vec![Some((vec![], true, 0)), ok(), ok()]);
    let opts = sdk::TransportOpts { reconnect_delay_ms: Some(10), max_reconnect_attempts: Some(5), ..Default::default() };
    let mut rc: sdk::ResumableConnection = sdk::ResumableConnection::connect("http://rt.test/feed", opts, vec![Box::new(dying)]).await?;
    let dropped = tokio::time::timeout(Duration::from_millis(15), rc.recv()).await.is_err();
    n.note(format!("dropped {dropped} {:?}", rc.state()));
    n.note(take(&mut rc, 1).await);
    n.note(format!("{:?}", rc.state()));`,
	"give-up": `    let failing = Fake::new(sdk::TransportKind::WebSocket, vec![Some((vec![], true, 0))]);
    let opts = sdk::TransportOpts { reconnect_delay_ms: Some(1), max_reconnect_attempts: Some(3), ..Default::default() };
    let mut rc: sdk::ResumableConnection =
        sdk::ResumableConnection::connect("http://rt.test/feed", opts, vec![Box::new(failing.clone())]).await?;
    n.note(take(&mut rc, 2).await);
    n.note(format!("{} {:?} {:?}", failing.got(), rc.state(), rc.send(&1).await.map_err(|e| err(&e))));`,
})

/** Consumer `transports`, built and run once against a server it never dials: its run and the hops it saw. */
const transports = once(() =>
	served([], async (server) => {
		const decls = `${TRANSPORTS.decls}\n\n${DECLS}`
		const run = await consume("realtime", "transports", { ...TRANSPORTS, base: server.url, decls, imports: IMPORTS })
		return { hops: server.hops.length, run }
	}),
)

/** The adapter sections, in order against one server; each one's replies and hop count are in ADAPTED. */
const ADAPTERS = sections({
	defaults: `    let c = bearer(base, None)?;
    let url = format!("{base}/feed");
    for chain in ["defaults", "sse first", "defaults", "defaults"] {
        let rc: sdk::ResumableConnection = if chain == "defaults" {
            sdk::ResumableConnection::connect_with_defaults(&c, url.as_str(), sdk::TransportOpts::default()).await?
        } else {
            let custom: Vec<Box<dyn sdk::Transport>> =
                vec![Box::new(sdk::SseTransport::new(&c)), Box::new(sdk::WsTransport::new(&c)), Box::new(sdk::LongpollTransport::new(&c))];
            sdk::ResumableConnection::connect(url.as_str(), sdk::TransportOpts::default(), custom).await?
        };
        n.note(format!("{chain} {:?}", rc.transport()));
    }`,
	raw: `    let c = bearer(base, None)?;
    for _ in 0..3 {
        let o = sdk::FeedLiveOpts { channel: "c".into(), ..Default::default() };
        let (rc, raw) = c.feed().live(&o).with_response().await?;
        n.note(format!("{:?} {} {} {} {:?}", rc.transport(), raw.status, raw.url.scheme(), raw.url.path(), raw.url.query()));
    }`,
	sse: `    let c = bearer(base, None)?;
    let chain: Vec<Box<dyn sdk::Transport>> = vec![Box::new(sdk::SseTransport::new(&c))];
    let mut rc: sdk::ResumableConnection = sdk::ResumableConnection::connect(format!("{base}/feed"), sdk::TransportOpts::default(), chain).await?;
    n.note(take(&mut rc, 1).await);
    n.note(format!("send {:?}", rc.send(&json!({"hi": 1})).await.map_err(|e| err(&e))));
    n.note(format!("send {:?} {:?}", rc.send(&json!({"hi": 2})).await.map_err(|e| err(&e)), rc.state()));`,
	longpoll: `    let c = bearer(base, None)?;
    let chain: Vec<Box<dyn sdk::Transport>> = vec![Box::new(sdk::LongpollTransport::new(&c))];
    let mut rc: sdk::ResumableConnection = sdk::ResumableConnection::connect(format!("{base}/feed"), sdk::TransportOpts::default(), chain).await?;
    n.note(take(&mut rc, 2).await);
    n.note(format!("send {:?}", rc.send(&json!({"hi": 1})).await.map_err(|e| err(&e))));
    n.note(format!("send {:?} {:?}", rc.send(&json!({"hi": 2})).await.map_err(|e| err(&e)), rc.state()));
    let slow = bearer(base, Some(Duration::from_millis(200)))?;
    let opts = sdk::TransportOpts { max_reconnect_attempts: Some(0), ..Default::default() };
    let chain: Vec<Box<dyn sdk::Transport>> = vec![Box::new(sdk::LongpollTransport::new(&slow))];
    let mut rc: sdk::ResumableConnection = sdk::ResumableConnection::connect(format!("{base}/feed"), opts, chain).await?;
    n.note(take(&mut rc, 1).await);`,
	refused: `    let c = bearer(base, None)?;
    let opts = sdk::TransportOpts { max_reconnect_attempts: Some(0), ..Default::default() };
    let chain: Vec<Box<dyn sdk::Transport>> = vec![Box::new(sdk::LongpollTransport::new(&c))];
    let mut rc: sdk::ResumableConnection = sdk::ResumableConnection::connect(format!("{base}/feed"), opts, chain).await?;
    n.note(take(&mut rc, 2).await);
    let chain: Vec<Box<dyn sdk::Transport>> = vec![Box::new(sdk::SseTransport::new(&c))];
    let sse = sdk::ResumableConnection::<Value>::connect(format!("{base}/feed"), sdk::TransportOpts::default(), chain).await;
    n.note(format!("{:?}", sse.map(|_| ()).map_err(|e| err(&e))));`,
})

const refused: Reply = { json: { message: "no" }, status: 404 }
const held = (steps: readonly string[]): Reply => ({ sse: { end: "hold", steps }, status: 200 })
const upgraded: Reply = { status: 101, ws: { steps: [] } }
const posted: Reply = { json: {}, status: 200 }
const unposted: Reply = { json: { message: "no" }, status: 405 }
const unavailable: Reply = { status: 503, text: "" }
const bad: Reply = { json: { message: "no" }, status: 400 }

/** Each adapter section's replies, in order; a section's hops are as many as its replies. */
const ADAPTED: Readonly<Record<string, readonly Reply[]>> = {
	defaults: [upgraded, held([]), refused, held([]), refused, unavailable],
	raw: [upgraded, refused, held([]), refused, unavailable],
	sse: [held(['data: {"n":1}\n\n']), posted, unposted],
	longpoll: [
		{ json: { id: "7", n: 2, reconnect_token: "rt-7" }, status: 200 },
		{ status: 204 },
		{ json: [{ n: 3 }, { n: 4 }], status: 200 },
		posted,
		unposted,
		{ delayMs: 1000, json: { n: 5 }, status: 200 },
	],
	refused: [bad, bad],
}

/** Consumer `adapters`, built and run once against one server answering ADAPTED: its run and every hop. */
const adapters = once(() =>
	served(Object.values(ADAPTED).flat(), async (server) => {
		const decls = `${ADAPTERS.decls}\n\n${DECLS}`
		const run = await consume("realtime", "adapters", { ...ADAPTERS, base: server.url, decls, imports: IMPORTS })
		return { hops: [...server.hops], run }
	}),
)

/** A hop as `METHOD url kind`: an upgrade, an event-stream open, a poll, or a POST's JSON body. */
function dial(hop: RecordedHop): string {
	if (hop.method === "POST") return `POST ${hop.url} ${hop.body.contentType} ${JSON.stringify(hop.body.json)}`
	const kind =
		hop.headers.upgrade === "websocket" ? "upgrade" : hop.headers.accept === "text/event-stream" ? "sse" : "poll"
	return `${hop.method} ${hop.url} ${kind}`
}

/** Section `name` of the `adapters` run: whether it built, its notes, and its own hops. */
async function adapted(name: string) {
	const { hops, run } = await adapters()
	const names = Object.keys(ADAPTED)
	const start = names.slice(0, names.indexOf(name)).reduce((at, key) => at + (ADAPTED[key]?.length ?? 0), 0)
	return { built: run.built, hops: hops.slice(start, start + (ADAPTED[name]?.length ?? 0)), out: run.out?.[name], run }
}

/** Section `name` of the `transports` run: whether it built and its notes. */
const inProcess = async (name: string) => {
	const { run } = await transports()
	return { built: run.built, out: run.out?.[name] }
}
const stderrOf = (run: Run) => run.stderr
/** The `raw` note of a realtime method opened over `kind`: its transport, then the real status and the URL it dialed. */
const opened = (kind: string, status: number, scheme: string) =>
	`Some(${kind}) ${status} ${scheme} /feed Some("channel=c")`

describe.skipIf(!RUST)(
	"the Transport trait and its default adapters, chained WebSocket, then SSE, then long-poll",
	() => {
		/* v0 only built a runner naming the trait, the adapters and connect; v1 runs it: the names and kinds */
		// v0: 06bd42975a
		it("ships the object-safe Transport, TransportOpts, TransportKind and the ws, sse and longpoll adapters a chain connects over", async () => {
			const { run } = await transports()
			expect(await inProcess("chain"), stderrOf(run)).toEqual({
				built: true,
				out: ["ws WebSocket", "sse Sse", "longpoll LongPoll", "[WebSocket, Sse, LongPoll]", "None None [] None None"],
			})
		}, 600_000)

		/* v0's grep for no new_ws/new_sse/new_longpoll and no #[deprecated is migration text and drops (H22) */
		// v0: c44adb510e
		it("opens connect_with_defaults over WebSocket, then SSE, then long-poll, and a custom chain in its own order", async () => {
			const { built, hops, out, run } = await adapted("defaults")
			expect({ built, out }, stderrOf(run)).toEqual({
				built: true,
				out: ["defaults Some(WebSocket)", "sse first Some(Sse)", "defaults Some(Sse)", "defaults Some(LongPoll)"],
			})
			/* the long-poll open sends nothing: its first poll waits for the first recv */
			expect(hops.map(dial)).toEqual([
				"GET /feed upgrade",
				"GET /feed sse",
				"GET /feed upgrade",
				"GET /feed sse",
				"GET /feed upgrade",
				"GET /feed sse",
			])
		}, 600_000)

		/* phase c's RawResponse (contract 19 :110/:118): the real answer, never rewritten to the endpoint's: the
		 * upgrade's 101 and ws URL, the event stream's 200, the open's poll URL (no cursor set) and 200 */
		it("answers a realtime method's with_response with the URL it dialed: ws for WebSocket, http for SSE and long-poll", async () => {
			const { built, hops, out, run } = await adapted("raw")
			expect({ built, out }, stderrOf(run)).toEqual({
				built: true,
				out: [opened("WebSocket", 101, "ws"), opened("Sse", 200, "http"), opened("LongPoll", 200, "http")],
			})
			expect(hops.map(dial)).toEqual([
				"GET /feed?channel=c upgrade",
				"GET /feed?channel=c upgrade",
				"GET /feed?channel=c sse",
				"GET /feed?channel=c upgrade",
				"GET /feed?channel=c sse",
			])
		}, 600_000)
	},
)

describe.skipIf(!RUST)("the default SSE and long-poll adapters on their own, sending by POSTing the JSON", () => {
	/* v0 grepped realtime.rs for SseTransport and fn connect; v1 receives over it */
	// v0: 55ae56c783
	it("receives the event stream over SseTransport with the client's auth and no cursor, a send POSTed and a 405 its error", async () => {
		const { built, hops, out, run } = await adapted("sse")
		expect({ built, out }, stderrOf(run)).toEqual({
			built: true,
			out: ['[{"n":1}]', "send Ok(())", 'send Err("Api HTTP 405: no") Connected'],
		})
		expect(hops.map(dial)).toEqual([
			"GET /feed sse",
			'POST /feed application/json {"hi":1}',
			'POST /feed application/json {"hi":2}',
		])
		expect(hops.map((hop) => [hop.headers.authorization, hop.headers["last-event-id"]])).toEqual([
			["Bearer tok", undefined],
			["Bearer tok", undefined],
			["Bearer tok", undefined],
		])
	}, 600_000)

	/* v0 grepped realtime.rs for impl Transport for LongpollTransport; v1 polls. The cursor is Go's (Fd3), never
	 * v0's ?cursor=; phase-b defect: a poll inherited the client's 30 s timeout, so a 200 ms client timeout
	 * failed a poll the server answers after 1000 ms */
	// v0: c9d8776277
	it("polls over LongpollTransport with its own advancing cursor, one message per answer, a poll bounded by 60 s", async () => {
		const { built, hops, out, run } = await adapted("longpoll")
		expect({ built, out }, stderrOf(run)).toEqual({
			built: true,
			out: [
				'[{"id":"7","n":2,"reconnect_token":"rt-7"},[{"n":3},{"n":4}]]',
				"send Ok(())",
				'send Err("Api HTTP 405: no") Connected',
				'[{"n":5}]',
			],
		})
		/* exactly one poll per recv (a 204 polls again), none ahead of the reader */
		expect(hops.map(dial)).toEqual([
			"GET /feed poll",
			"GET /feed?last_event_id=7&reconnect_token=rt-7 poll",
			"GET /feed?last_event_id=7&reconnect_token=rt-7 poll",
			'POST /feed application/json {"hi":1}',
			'POST /feed application/json {"hi":2}',
			"GET /feed poll",
		])
		expect(hops.every((hop) => hop.headers.authorization === "Bearer tok")).toBe(true)
	}, 600_000)
})

describe.skipIf(!RUST)("an adapter's error status: from recv over long-poll, from connect over SSE", () => {
	/* the http legs of v0's runtime_check are phase c's: 6ab5bbb7de (the 401 resend, one Authorization and one
	 * Content-Type), c424958b5c (the base path), 876d9e16dc (`..`), 5330fd78cf (the error cap), 7ec4544c22
	 * (the LRU eviction); the stale lookup budget is http.stale.test.ts's; the sync-hooks leg is CUT */
	// v0: edee99d992
	it("surfaces a long-poll 400 from recv, then None, and an SSE 400 from connect", async () => {
		const { built, hops, out, run } = await adapted("refused")
		expect({ built, out }, stderrOf(run)).toEqual({
			built: true,
			out: ['[{"error":"Api HTTP 400: no"},"none"]', 'Err("Api HTTP 400: no")'],
		})
		expect(hops.map(dial)).toEqual(["GET /feed poll", "GET /feed sse"])
	}, 600_000)
})

describe.skipIf(!RUST)("ResumableConnection over a caller's in-process transports", () => {
	/* v0 grepped realtime.rs for the six fn names; v1 drives one session through them */
	// v0: 29efc769b7
	it("drives one session: Connected, a send, a recv, a close to Disconnected, then None and Closed", async () => {
		const { run } = await transports()
		expect(await inProcess("session"), stderrOf(run)).toEqual({
			built: true,
			out: [
				"Connected Some(WebSocket)",
				'send Ok(()) ["{\\"hi\\":1}"]',
				'[{"n":1}]',
				"close Ok(()) Disconnected None",
				"recv None",
				'send Err("Closed closed")',
			],
		})
	}, 600_000)

	// v0: 328426dae5
	it("dials only the caller's transport: one connect, proven WebSocket, and the server behind the URL sees no request", async () => {
		const { hops, run } = await transports()
		expect({ ...(await inProcess("custom")), hops }, stderrOf(run)).toEqual({
			built: true,
			hops: 0,
			out: ['[{"kind":"custom","seq":1},{"kind":"custom","seq":2}]', '["/"] Some(WebSocket)'],
		})
	}, 600_000)

	/* V0BUG: v0 froze transport_opts at connect (realtime.rs:482-485,646), so the reconnect resumed from the
	 * caller's cursor; v0's runner never asserted the cursor at all */
	// v0: be1a90be06
	it("reconnects after a mid-stream drop through the next transport, each dial handed the advanced cursor", async () => {
		const { run } = await transports()
		const ids = [1, 2, 3].map((id) => `{"id":"${id}","reconnect_token":"rt-${id}"}`)
		expect(await inProcess("resume"), stderrOf(run)).toEqual({
			built: true,
			out: [`[${ids.join(",")}]`, '["0/rt-0","2/rt-2"] ["2/rt-2"] 3/rt-3 Some(Sse) Connected'],
		})
	}, 600_000)

	/* a 15 ms timeout drops recv inside the reconnect's 200 ms dial; the next recv reconnects and delivers */
	// v0: edee99d992
	it("keeps recv cancel-safe: a recv dropped mid-reconnect leaves it Reconnecting, and the next recv delivers", async () => {
		const { run } = await transports()
		expect(await inProcess("cancel-safe"), stderrOf(run)).toEqual({
			built: true,
			out: ["dropped true Reconnecting", '[{"ok":true}]', "Connected"],
		})
	}, 600_000)

	/* V0BUG: v0's give-up returned Closed forever (realtime.rs:559,599-608); v1 returns the last failure once */
	it("gives up after max_reconnect_attempts: the last failure once, then None, Disconnected, and a send Closed", async () => {
		const { run } = await transports()
		expect(await inProcess("give-up"), stderrOf(run)).toEqual({
			built: true,
			out: ['[{"error":"Config config: refused"},"none"]', '["/","/","/","/"] Disconnected Err("Closed closed")'],
		})
	}, 600_000)
})
