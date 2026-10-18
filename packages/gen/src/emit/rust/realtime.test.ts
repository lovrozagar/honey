/**
 * The realtime answer (contract 20 §2.3/§5.5): a method resolves with its `ResumableConnection<E>` open over
 * WebSocket, else SSE, else long-poll, `cancel_on` bounding that open and ending an open connection (Fd1, Fd6);
 * `recv` reconnects after a drop and resumes from the cursor it advanced past each delivered message, on
 * every transport (G12); the backoff from the delay or an SSE `retry`, and a give-up returning the real error
 * once, then `None` (Fd9); every dial carrying the call's params, the client's auth and headers, the current
 * token and its own request id (Fd2, Fd5); `send` POSTing on a degraded connection (Fd4); and the surface the
 * compiler proves. Driven against the `realtime` registry document, with consumer programs beside it.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { consume, sections } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()
const rustDescribe = describe.skipIf(!RUST)

/** The `realtime` SDK compiled with the driver, which must build. */
function driven(): DrivenRustSdk {
	const sdk = drivenRustSdk("realtime")
	expect({ built: sdk.built }, sdk.stderr).toEqual({ built: true })
	return sdk
}

/** `calls` run on one client under `setup` and `script` against a server answering `replies`: the run, hops, streams and base. */
async function drive(replies: readonly Reply[], calls: readonly Call[], o: { script?: Script; setup?: Setup } = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup: o.setup ?? {} }, server, o.script ?? {})
		return { base: server.url, hops: [...server.hops], run, streams: [...server.streams] }
	})
}

const FEED = { operation: "feed.live", route: { method: "GET", path: "/feed" }, search: { channel: "c" } }
const live = (extra: Partial<Call> = {}): Call => ({ ...FEED, ...extra })
const RESUME = { operation: "feed.resume", route: { method: "GET", path: "/resume" } }
/** a short first backoff, so a reconnect lands within milliseconds (5–10 ms with jitter) */
const QUICK: Script = { calls: [{ realtime: { reconnectDelayMs: 10 } }] }
const refused: Reply = { json: { message: "no" }, status: 404 }
const unavailable: Reply = { status: 503, text: "" }
const ok: Reply = { json: {}, status: 200 }
const sse = (steps: readonly (string | { waitMs: number })[], end: "close" | "drop" | "hold"): Reply => ({
	sse: { end, steps },
	status: 200,
})
/** event n of a resumable stream: SSE id n, payload n with reconnect token rt-n */
const ev = (n: number) => `id: ${n}\ndata: {"n":${n},"reconnect_token":"rt-${n}"}\n\n`
/** the typed `Payload` an event reads as: an `id` member is not one of its fields */
const frame = (n: number, token = `rt-${n}`) => ({ n, reconnect_token: token })
const frames = (...values: readonly unknown[]) => [{ frames: values, kind: "frames" }]
/** a long-poll answer: payload n, its cursor in `id` and `reconnect_token` */
const polled = (n: number, id: string): Reply => ({ json: { id, n, reconnect_token: `rt-${id}` }, status: 200 })
/** refused upgrade, refused event stream, then long-poll: two polls answered */
const POLLED: readonly Reply[] = [refused, unavailable, polled(1, "7"), polled(2, "8")]
const RECONNECTING: readonly Reply[] = [refused, sse([ev(1)], "drop"), refused, sse([ev(2)], "hold")]
/** an SSE connection, then the answer to the POST its `send` makes */
const posted = (post: Reply): Reply[] => [refused, sse([ev(1)], "hold"), post]
/** a hop's resume wire: its URL and its Last-Event-ID header */
const wire = (hop: RecordedHop | undefined) => [hop?.url, hop?.headers["last-event-id"]]
const BARE = ["/feed?channel=c", undefined]
const cursor = (lastEventId: string, reconnectToken: string) => ({ lastEventId, reconnectToken })
const TOK: Setup = { auth: { kind: "bearer", token: "tok" } }
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const JSON_POST = { body: { contentType: "application/json", json: { hi: 1 } }, method: "POST", url: "/feed?channel=c" }

/** A consumer's view of a `recv`: none, the payload's n, or the error's text. */
const READ = `fn read(r: Option<Result<sdk::Payload, sdk::Error>>) -> String {
    match r {
        None => "none".into(),
        Some(Ok(p)) => format!("ok {:?}", p.n),
        Some(Err(e)) => format!("err {e}"),
    }
}`

/** Some(0) over a refused chain whose poll fails; then a reconnect whose upgrade is held past a `recv` timeout. */
const STATES = sections({
	"no-reconnect": `    let o = sdk::FeedLiveOpts { channel: "c".into(), max_reconnect_attempts: Some(0), reconnect_delay_ms: Some(1), ..Default::default() };
    let mut rc = client(base)?.feed().live(&o).await?;
    n.note(format!("{:?}", rc.state()));
    n.note(read(rc.recv().await));
    n.note(format!("{:?} {}", rc.state(), read(rc.recv().await)));`,
	reconnecting: `    let o = sdk::FeedLiveOpts { channel: "c".into(), reconnect_delay_ms: Some(1), ..Default::default() };
    let mut rc = client(base)?.feed().live(&o).await?;
    n.note(format!("{:?} {}", rc.state(), read(rc.recv().await)));
    let timed = tokio::time::timeout(std::time::Duration::from_millis(500), rc.recv()).await.is_err();
    n.note(format!("{timed} {:?}", rc.state()));
    n.note(format!("{:?} {:?} {}", rc.close().await, rc.state(), read(rc.recv().await)));`,
})

/** Each method's Call typed by its event schema, FeedResumeOpts named field by field, every state matched. */
const SURFACE = {
	body: `let c = client("http://127.0.0.1:9").expect("client");
    let o = sdk::FeedLiveOpts { channel: "c".into(), ..Default::default() };
    let _: sdk::Call<sdk::ResumableConnection<sdk::Payload>> = c.feed().live(&o);
    let r = sdk::FeedResumeOpts { protocols2: Some("p".into()), last_event_id: None, reconnect_token: None, protocols: Vec::new(), max_reconnect_attempts: None, reconnect_delay_ms: None };
    let _: sdk::Call<sdk::ResumableConnection<serde_json::Value>> = c.feed().resume(&r);
    let _: sdk::Call<sdk::ResumableConnection> = c.feed().resume(&r);
    for s in [sdk::ConnectionState::Connected, sdk::ConnectionState::Reconnecting, sdk::ConnectionState::Disconnected] {
        n.note(state(s));
    }`,
	decls: `fn state(s: sdk::ConnectionState) -> &'static str {
    match s {
        sdk::ConnectionState::Connected => "connected",
        sdk::ConnectionState::Reconnecting => "reconnecting",
        sdk::ConnectionState::Disconnected => "disconnected",
    }
}`,
}

rustDescribe("a realtime method resolves with its connection open, cancel_on bounding it (Fd1, Fd6)", () => {
	it("dials before it returns: a cancel before the call dials nothing, one during the dial ends it", async () => {
		/* V0BUG: v0's method returned before it dialed, so a canceled call still handed back a connection */
		const canceled = await drive([], [live({ take: 1 })], { script: { calls: [{ cancel: "before" }] } })
		const late = await drive([{ ...refused, delayMs: 2000 }], [live({ take: 1 })], {
			script: { calls: [{ cancel: { afterMs: 300 } }] },
		})
		const seen = [canceled, late].map(({ hops, run }) => {
			const c = run.trace?.calls[0]
			return [run.observed, c?.error?.variant, c?.error?.via, c?.stream, hops.length, (c?.elapsedMs ?? 1e9) < 1500]
		})
		expect(seen, canceled.run.stderr + late.run.stderr).toEqual([
			[[null], "Canceled", "return", undefined, 0, true],
			[[null], "Canceled", "return", undefined, 1, true],
		])
		expect(late.hops[0]?.headers.upgrade).toBe("websocket")
	}, 600_000)

	it("ends an open connection quietly on a later cancel: the frames so far, no error, no reconnect", async () => {
		/* Fd6, ruled the alternative: `cancel_on` reaches past the open and ends the connection, as Go's ctx does */
		const held = sse([ev(1), { waitMs: 4000 }, ev(2)], "hold")
		const { hops, run } = await drive([refused, held], [live({ take: 2 })], {
			script: { calls: [{ cancel: { afterMs: 1000 }, realtime: { reconnectDelayMs: 10 } }] },
		})
		const c = run.trace?.calls[0]
		expect({ error: c?.error, hops: hops.length, observed: run.observed, stream: c?.stream }, run.stderr).toEqual({
			error: undefined,
			hops: 2,
			observed: frames(frame(1)),
			stream: { realtime: { cursor: cursor("1", "rt-1"), errors: [], proven: "sse" }, yields: 1 },
		})
		expect(c?.elapsedMs).toBeLessThan(3000)
	}, 600_000)
})

rustDescribe("the resume cursor advances past each delivered event, and a reconnect resumes from it (G12)", () => {
	// v0: 252b9e2381
	// v0: 9b1096f635
	it("reconnects after a drop, the next upgrade and event stream carrying the last id and token", async () => {
		/* V0BUG: v0 froze transport_opts at connect (realtime.rs:482-485,646) */
		const replies = [refused, sse([ev(1), ev(2)], "drop"), refused, sse([ev(3)], "hold")]
		const { hops, run } = await drive(replies, [live({ take: 3 })], { script: QUICK })
		const resumed = ["/feed?channel=c&last_event_id=2&reconnect_token=rt-2", undefined]
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream, wire: hops.map(wire) }, run.stderr).toEqual({
			observed: frames(frame(1), frame(2), frame(3)),
			stream: { realtime: { cursor: cursor("3", "rt-3"), errors: [], proven: "sse" }, yields: 3 },
			wire: [BARE, BARE, resumed, ["/feed?channel=c&reconnect_token=rt-2", "2"]],
		})
	}, 600_000)

	// v0: 0503013ae2
	it("opens with the caller's cursor on each transport's wire, and with none when it is unset or empty", async () => {
		/* the empty pair: HEAD's `texts("")` is `[""]`, so it sends `last_event_id=` and `Last-Event-ID: ` */
		const runs = []
		for (const given of [{ lastEventId: "0", reconnectToken: "rt-0" }, {}, { lastEventId: "", reconnectToken: "" }])
			runs.push(await drive([refused, sse([ev(1)], "hold")], [live({ ...given, take: 1 })], { script: QUICK }))
		expect(
			runs.map(({ hops, run }) => [run.observed, hops.map(wire)]),
			runs.map(({ run }) => run.stderr).join("\n"),
		).toEqual([
			[
				frames(frame(1)),
				[
					["/feed?channel=c&last_event_id=0&reconnect_token=rt-0", undefined],
					["/feed?channel=c&reconnect_token=rt-0", "0"],
				],
			],
			[frames(frame(1)), [BARE, BARE]],
			[frames(frame(1)), [BARE, BARE]],
		])
	}, 600_000)
})

rustDescribe("the long-poll fallback advances its own cursor and polls once per read (G12, Fd3)", () => {
	// v0: ce70fd9b5c
	it("falls back past a refused upgrade and event stream, each poll carrying the cursor before it", async () => {
		/* V0BUG: v0's LongpollTransport::connect reset the cursor (realtime.rs:360). Fd3: the cursor goes as
		 * last_event_id/reconnect_token, the pair every transport resumes from; v0's `?cursor=` is a ruling change */
		const { hops, run } = await drive(POLLED, [live({ take: 2 })], { script: QUICK })
		expect({ observed: run.observed, stream: run.trace?.calls[0]?.stream }, run.stderr).toEqual({
			observed: frames(frame(1, "rt-7"), frame(2, "rt-8")),
			stream: { realtime: { cursor: cursor("8", "rt-8"), errors: [], proven: "longpoll" }, yields: 2 },
		})
		/* the hop URL, not the cursor: a conn that never advances its own still reports the connection's */
		expect([hops.length, hops]).toMatchObject([
			4,
			[
				{ headers: { upgrade: "websocket" }, url: "/feed?channel=c" },
				{ headers: { accept: "text/event-stream" }, url: "/feed?channel=c" },
				{ method: "GET", url: "/feed?channel=c" },
				{ method: "GET", url: "/feed?channel=c&last_event_id=7&reconnect_token=rt-7" },
			],
		])
	}, 600_000)

	// v0: 6eaacf1a73
	it("delivers one message per answer, a JSON array as one, and polls no further ahead than the reader", async () => {
		/* Fd3: one message per 2xx answer, so a declared array event type still decodes (v0 split it) */
		const replies = [refused, unavailable, { json: [{ n: 1 }, { n: 2 }], status: 200 }, { json: { n: 3 }, status: 200 }]
		const { hops, run } = await drive(replies, [{ ...RESUME, take: 2 }], { script: QUICK })
		expect({ observed: run.observed, urls: hops.map((hop) => hop.url) }, run.stderr).toEqual({
			observed: frames([{ n: 1 }, { n: 2 }], { n: 3 }),
			urls: ["/resume", "/resume", "/resume", "/resume"],
		})
	}, 600_000)
})

rustDescribe("a reconnect backs off from an SSE retry, else the reconnect delay, else 1000 ms", () => {
	// v0: 69f44913bd
	it("waits at least half the base before the first reconnect: retry 2000, delay 10, the default", async () => {
		/* V0BUG: v0 stored retry_hint_ms and never read it (realtime.rs:309,695). The first backoff is jittered
		 * into the upper half of its base: 2000 → [1000, 2000], 10 → [5, 10], the default 1000 → [500, 1000] */
		const hinted = [refused, sse([`retry: 2000\n${ev(1)}`], "drop"), refused, sse([ev(2)], "hold")]
		const runs = [
			await drive(hinted, [live({ take: 2 })], { script: QUICK }),
			await drive(RECONNECTING, [live({ take: 2 })], { script: QUICK }),
			await drive(RECONNECTING, [live({ take: 2 })]),
		]
		const ms = runs.map(({ run }) => run.trace?.calls[0]?.elapsedMs ?? Number.NaN)
		expect(
			runs.map(({ hops, run }) => [run.observed, hops.length]),
			runs.map(({ run }) => run.stderr).join("\n"),
		).toEqual(Array.from({ length: 3 }, () => [frames(frame(1), frame(2)), 4]))
		expect({ hinted: ms[0]! >= 1000, quick: ms[1]! < 1000, unset: ms[2]! >= 500 }, ms.join(" ")).toEqual({
			hinted: true,
			quick: true,
			unset: true,
		})
		expect(Math.max(ms[0]!, ms[2]!)).toBeLessThan(5000)
	}, 600_000)
})

rustDescribe("a realtime connection gives up with the real error once, then None (Fd9)", () => {
	// v0: 9b1096f635
	// v0: 693d01e26d
	it("reconnects after a clean end, keeps the cursor on every attempt, and gives up after the max", async () => {
		/* V0BUG: v0's give-up returned Closed forever (realtime.rs:559,599-608), and its long-poll reset the
		 * cursor (realtime.rs:360). Each attempt runs the chain: upgrade, event stream, then a poll answered 500 */
		const down: Reply = { json: { message: "down" }, status: 500 }
		const replies = [refused, sse([ev(1)], "close"), refused, refused, down, refused, refused, down]
		const { hops, run } = await drive(replies, [live({ take: 2 })], {
			script: { calls: [{ realtime: { maxReconnectAttempts: 2, reconnectDelayMs: 1 } }] },
		})
		const c = run.trace?.calls[0]
		const upgradeOrPoll = ["/feed?channel=c&last_event_id=1&reconnect_token=rt-1", undefined]
		const attempt = [upgradeOrPoll, ["/feed?channel=c&reconnect_token=rt-1", "1"], upgradeOrPoll]
		const error = c?.error && [c.error.variant, c.error.status, c.error.via]
		expect(
			{ error, observed: run.observed, realtime: c?.stream?.realtime, wire: hops.map(wire) },
			run.stderr,
		).toMatchObject({
			error: ["Api", 500, "stream"],
			observed: frames(frame(1)),
			realtime: { cursor: cursor("1", "rt-1"), errors: ["500 Internal Server Error: down"] },
			wire: [BARE, BARE, ...attempt, ...attempt],
		})
	}, 600_000)

	it("is Connected, Reconnecting or Disconnected; Some(0) never reconnects and returns the failure", async () => {
		/* Fd9: a pull API never shows a Connecting instance, and v0's `0` meant unlimited. A `recv` timed out
		 * mid-reconnect is dropped, the state then Reconnecting: the upgrade is held past the timeout */
		const bad: Reply = { json: { message: "bad" }, status: 400 }
		const replies = [refused, refused, bad, refused, sse([ev(1)], "drop"), { ...refused, delayMs: 3000 }]
		const [run, hops] = await served(replies, async (server) => {
			const p = { base: server.url, body: STATES.body, decls: `${STATES.decls}\n\n${READ}` }
			return [await consume("realtime", "states", p), server.hops.map((hop) => hop.url)] as const
		})
		expect({ built: run.built, hops, out: run.out }, run.stderr).toEqual({
			built: true,
			hops: [...Array.from({ length: 5 }, () => BARE[0]), "/feed?channel=c&last_event_id=1&reconnect_token=rt-1"],
			out: {
				"no-reconnect": ["Connected", "err 400 Bad Request: bad", "Disconnected none"],
				reconnecting: ["Connected ok Some(1)", "true Reconnecting", "Ok(()) Disconnected none"],
			},
		})
	}, 600_000)
})

rustDescribe("every realtime dial carries the call's params, the client's auth and headers (Fd2)", () => {
	// v0: 491f9f971d
	it("sends them on every upgrade, stream, poll and reconnect, each with its own X-Request-Id", async () => {
		/* V0BUG: v0 built the URL with `&[]` (codegen-rust.ts:694), never sent reconnect_token (realtime.rs:483),
		 * and kept one request id per connection (codegen-rust.ts:695). Fd2: an id names one request, a
		 * caller's id is kept on every dial */
		const setup: Setup = { ...TOK, headers: { "X-Cfg": "1" } }
		const runs = []
		const stderr: string[] = []
		for (const replies of [RECONNECTING, POLLED])
			for (const id of [undefined, "fixed"]) {
				const headers = { "x-tenant": "acme", ...(id && { "X-Request-Id": id }) }
				const { hops, run } = await drive(replies, [live({ headers, take: 2 })], { script: QUICK, setup })
				stderr.push(run.stderr)
				const ids = hops.map((hop) => hop.headers["x-request-id"])
				const sent = hops.map(({ headers: h, url }) => [
					url.startsWith(BARE[0]!),
					h["x-tenant"],
					h.authorization,
					h["x-cfg"],
				])
				const read = (run.observed?.[0] as { frames?: unknown[] } | null)?.frames?.length
				runs.push({ distinct: new Set(ids).size, frames: read, ids, sent })
			}
		const fresh = { distinct: 4, frames: 2, ids: Array.from({ length: 4 }, () => expect.stringMatching(UUID4)) }
		const kept = { distinct: 1, frames: 2, ids: Array.from({ length: 4 }, () => "fixed") }
		const sent = Array.from({ length: 4 }, () => [true, "acme", "Bearer tok", "1"])
		expect(runs, stderr.join("\n")).toEqual([fresh, kept, fresh, kept].map((want) => ({ ...want, sent })))
	}, 600_000)
})

rustDescribe("every reconnect dials with the client's current token (Fd5)", () => {
	it("carries a refresh on one reconnect's stream to the next upgrade; only stream dials run hooks", async () => {
		/* Fd5: the SSE and long-poll dials ride the shared exchange (hooks, the 401 refresh); the WebSocket dial
		 * runs no hooks but reads the current token. Go dialed every reconnect with the construction-time token.
		 * A dial's hook sees its operation's path, as an ordinary call's does (ruled): never "" */
		const expired: Reply = { json: { message: "expired" }, status: 401 }
		const replies = [refused, sse([ev(1)], "drop"), refused, expired, sse([ev(2)], "drop"), refused]
		const script: Script = { ...QUICK, onAuthExpired: { tokens: ["new"] } }
		const setup: Setup = { auth: { kind: "bearer", token: "old" } }
		const { base, hops, run } = await drive([...replies, sse([ev(3)], "hold")], [live({ take: 3 })], {
			script,
			setup,
		})
		const hooked = run.trace?.hooks
			.filter((h) => h.phase === "request")
			.map((h) => [h.url?.slice(base.length), h.path, h.isRetry])
		const [first, second] = ["/feed?channel=c&reconnect_token=rt-1", "/feed?channel=c&reconnect_token=rt-2"]
		expect({ authExpired: run.trace?.authExpired, hooked, observed: run.observed }, run.stderr).toEqual({
			authExpired: 1,
			hooked: [
				[BARE[0], "/feed", false],
				[first, "/feed", false],
				[first, "/feed", true],
				[second, "/feed", false],
			],
			observed: frames(frame(1), frame(2), frame(3)),
		})
		const dials = hops.map((hop) => `${hop.headers.upgrade ?? "sse"} ${hop.headers.authorization}`)
		const [ws, stream] = [(t: string) => `websocket Bearer ${t}`, (t: string) => `sse Bearer ${t}`]
		expect(dials).toEqual([ws("old"), stream("old"), ws("old"), stream("old"), stream("new"), ws("new"), stream("new")])
	}, 600_000)
})

rustDescribe("send on a degraded connection POSTs the JSON to the endpoint through the exchange (Fd4)", () => {
	// v0: 87e8577c45
	it("POSTs on a long-poll connection with the call's params, the bearer and a JSON body, then polls", async () => {
		const replies = [refused, unavailable, ok, polled(1, "7")]
		const call = live({ headers: { "x-tenant": "acme" }, send: ['{"hi":1}'], take: 1 })
		const { hops, run } = await drive(replies, [call], { script: QUICK, setup: TOK })
		expect({ error: run.trace?.calls[0]?.error, observed: run.observed }, run.stderr).toEqual({
			error: undefined,
			observed: frames(frame(1, "rt-7")),
		})
		expect(hops.slice(2)).toMatchObject([
			{ ...JSON_POST, headers: { authorization: "Bearer tok", "x-tenant": "acme" } },
			{ method: "GET", url: "/feed?channel=c" },
		])
	}, 600_000)

	// v0: 6810f1bf1d
	it("POSTs on an SSE connection, Ok on a 2xx; a POST answered 405 is a typed Api error, no frames", async () => {
		const call = live({ send: ['{"hi":1}'], take: 1 })
		const sent = await drive(posted(ok), [call], { script: QUICK, setup: TOK })
		const no = await drive(posted({ json: { message: "no" }, status: 405 }), [call], { script: QUICK, setup: TOK })
		expect(sent.hops[2], sent.run.stderr).toMatchObject({ ...JSON_POST, headers: { authorization: "Bearer tok" } })
		const outcome = ({ run }: typeof sent) => {
			const c = run.trace?.calls[0]
			return [run.observed, c?.error && [c.error.variant, c.error.status, c.error.via], c?.stream?.realtime?.errors]
		}
		expect([outcome(sent), outcome(no)], sent.run.stderr + no.run.stderr).toEqual([
			[frames(frame(1)), undefined, []],
			[frames(), ["Api", 405, "stream"], []],
		])
	}, 600_000)
})

rustDescribe("the realtime surface: ResumableConnection<E>, three states and the folded Opts (Fd3, Fd9)", () => {
	// v0: 475b19a883
	it("types each Call by its event schema and folds a declared resume param into the stream fields", async () => {
		/* V0BUG: v0 emitted reconnect_token2 beside reconnect_token and sent both pairs. The struct literal
		 * names every field: one more is E0560, one fewer E0063; the match names every state: one more is E0004 */
		const run = await consume("realtime", "surface", SURFACE)
		expect({ built: run.built, out: run.out }, run.stderr).toEqual({
			built: true,
			out: { main: ["connected", "reconnecting", "disconnected"] },
		})
	}, 600_000)

	it("sends one resume pair beside the declared protocols query, and closes the socket with 1000", async () => {
		/* Go's close-race lesson: the close frame is never lost */
		const call: Call = { ...RESUME, lastEventId: "5", reconnectToken: "rt", search: { protocols: "p" }, take: 1 }
		const accepted: Reply = { status: 101, ws: { steps: [{ json: { n: 1 } }] } }
		const { hops, run, streams } = await drive([accepted], [call])
		expect([run.observed, hops.map(wire), streams[0]?.received.at(-1)], run.stderr).toEqual([
			frames({ n: 1 }),
			[["/resume?protocols=p&last_event_id=5&reconnect_token=rt", undefined]],
			{ code: 1000, kind: "close", reason: "" },
		])
	}, 600_000)
})
