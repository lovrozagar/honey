/**
 * A realtime operation in the Java SDK (bit 16 phase d2b, R1–R8; C#'s `realtime.test.ts`, contract 50 §5.6, Fd3, Fd6,
 * Fd7): the method dials WebSocket, else SSE, else long-poll and returns `ResumableConnection<T>` connected (`JsonNode`
 * untyped); the reading thread's interrupt before or during the dial ends the call, and under a later read it drops the
 * transport and leaves the connection reconnecting (R3); a reconnect reopens the chain from the advanced cursor; the
 * backoff; the give-up once; every dial's params, auth, headers and request id, the SSE and long-poll dials through the
 * exchange, the WebSocket dial with no hook; a send POSTed on the SSE and long-poll transports. Driven on `realtime`;
 * every timed call follows a warm one on its client. The consumer, type and surface legs: `realtime.api.test.ts`; the
 * default chain and the adapters alone: `realtime.transports.test.ts`; a caller's in-process adapters:
 * `realtime.adapters.test.ts`; the open bound and the interrupt's ownership in process: `realtime.loop.test.ts`.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { CallScript, Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { AT_1, bad, drivenRealtime, ev, FEED_URL, frame, refused, sse, unavailable } from "./__fixtures__/realtime.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }
/** The JDKs a cancel leg runs on (condition b, as d1 and d2a). */
const JDKS = [17, 21] as const

type Options = { readonly jdk?: 17 | 21; readonly script?: Script; readonly setup?: Setup }

/** `calls` run by the driver under `script` and `setup` against `replies`: the run, the bodies and the hops. */
async function drive(replies: readonly Reply[], calls: readonly Call[], o: Options = {}) {
	const sdk = drivenRealtime()
	return served(replies, async (server) => {
		const cell = { calls, setup: o.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { jdk: o.jdk, script: o.script ?? {} })
		return { base: server.url, bodies: [...server.bodies], hops: [...server.hops], run }
	})
}
type Drove = Awaited<ReturnType<typeof drive>>

const FEED = { operation: "feed.live", route: { method: "GET", path: "/feed" }, search: { channel: "c" } }
const live = (extra: Partial<Call> = {}): Call => ({ ...FEED, ...extra })
const RESUME: Call = { operation: "feed.resume", route: { method: "GET", path: "/resume" } }
/** a call's realtime fields; QUICK's short first backoff lands a reconnect within 5–10 ms */
const QUICK_ENTRY: CallScript = { realtime: { reconnectDelayMs: 10 } }
const budget = (realtime: CallScript["realtime"]): Script => ({ calls: [{ realtime }] })
const QUICK = budget({ reconnectDelayMs: 10 })
const framed = (...values: readonly unknown[]) => ({ frames: values, kind: "frames" })
const frames = (...values: readonly unknown[]) => [framed(...values)]
/** a long-poll answer: payload n, its cursor in `id` and `reconnect_token`; `Payload` declares no `id`, so a frame drops it */
const polled = (n: number, id: string): Reply => ({ json: { id, n, reconnect_token: `rt-${id}` }, status: 200 })
/** refused upgrade, refused event stream, then long-poll: two polls answered */
const POLLED: readonly Reply[] = [refused, unavailable, polled(1, "7"), polled(2, "8")]
const RECONNECTING: readonly Reply[] = [refused, sse([ev(1)], "drop"), refused, sse([ev(2)], "hold")]
/** The unbounded open a timed call follows on its client (per-call timeout 0): a refused upgrade, then SSE. */
const WARM = live({ take: 1, timeoutMs: 0 })
const WARMED: readonly Reply[] = [refused, sse([ev(0)], "hold")]
const WARM_SEEN = framed(frame(0))
/** a hop's resume wire: its URL, then its Last-Event-ID header (`-` without one) */
const wire = (hop: RecordedHop | undefined) => `${hop?.url} ${hop?.headers["last-event-id"] ?? "-"}`
/** which dial a hop is: a WebSocket upgrade, an event stream, else a poll */
const dialOf = (hop: RecordedHop) =>
	hop.headers.upgrade ? "upgrade" : hop.headers.accept === "text/event-stream" ? "sse" : "poll"
const BARE = `${FEED_URL} -`
/** a connection's stream trace: its frames read, the cursor its options settled on ("id token"), the proven transport */
const settled = (yields: number, at: string, proven: string | null, errors: readonly unknown[] = []) => {
	const [lastEventId, reconnectToken] = at.split(" ")
	return { realtime: { cursor: { lastEventId, reconnectToken }, errors, proven }, yields }
}
const TOK: Setup = { auth: { kind: "bearer", token: "tok" } }
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const JSON_POST = { body: { contentType: "application/json", json: { hi: 1 } }, method: "POST", url: FEED_URL }
/** A stream's cancel as traced: the reader's interrupt ended the read (R3), via the stream. */
const CANCELED = expect.objectContaining({ canceled: true, via: "stream" })
/** what a dial sent: whether its URL is the call's, then these headers */
const SENT = ["x-tenant", "authorization", "x-cfg"]
const sent = ({ headers, url }: RecordedHop) => [url.startsWith(FEED_URL), ...SENT.map((k) => headers[k])]
const TWICE: Script = { calls: [QUICK_ENTRY, QUICK_ENTRY] }
const ids = ({ hops }: Drove) => hops.map((hop) => hop.headers["x-request-id"])
const call = ({ run }: Drove, i = 0) => run.trace?.calls[i]
const failure = (drove: Drove, i = 0) => ((e) => e && [e.type, e.status, e.via])(call(drove, i)?.error)

describe.skipIf(!JAVA)("a realtime method: it returns ResumableConnection<T> connected (Fd6, R1, R8)", SLOW, () => {
	/* new: C# realtime.test.ts:149 (300 ms against a dial held 2,700 ms past it, after a warm open) */
	it.each(JDKS)(
		"dials before it returns: an interrupt before the call dials nothing, one during the dial ends it (JDK %i)",
		async (jdk) => {
			const script: Script = { calls: [{}, { cancel: "before" }, { cancel: { afterMs: 300 } }] }
			const calls = [WARM, live({ take: 1 }), live({ take: 1 })]
			const drove = await drive([...WARMED, { ...refused, delayMs: 3000 }], calls, { jdk, script })
			const seen = { hops: drove.hops.length, observed: drove.run.observed, upgrade: drove.hops[2]?.headers.upgrade }
			expect(seen, drove.run.stderr).toEqual({ hops: 3, observed: [WARM_SEEN, null, null], upgrade: "websocket" })
			const ends = [1, 2].map((i) => call(drove, i)).map((c) => [c?.error, c?.stream, (c?.elapsedMs ?? 1e9) < 2500])
			const returned = [expect.objectContaining({ canceled: true, via: "return" }), undefined, true]
			expect(ends).toEqual([returned, returned])
		},
	)

	/* new: C# realtime.test.ts:161, at R3 (Fd3): the interrupt drops the transport, so nothing is proven after it */
	it.each(JDKS)(
		"ends a read on a later interrupt: the frames so far, the cancel traced, the transport dropped, no reconnect (JDK %i)",
		async (jdk) => {
			/* the interrupt lands 1,000 ms in, after the first event, and 4,000 ms before the second */
			const script: Script = { calls: [{}, { cancel: { afterMs: 1000 }, ...QUICK_ENTRY }] }
			const held = sse([ev(1), { waitMs: 5000 }, ev(2)], "hold")
			const drove = await drive([...WARMED, refused, held], [WARM, live({ take: 2 })], { jdk, script })
			const c = call(drove, 1)
			const seen = [c?.error, drove.hops.length, drove.run.observed, c?.stream]
			const want = [CANCELED, 4, [WARM_SEEN, framed(frame(1))], settled(1, "1 rt-1", null, [c?.error?.text])]
			expect(seen, drove.run.stderr).toEqual(want)
			expect([(c?.elapsedMs ?? 0) >= 990, (c?.elapsedMs ?? 1e9) < 4000], `${c?.elapsedMs}`).toEqual([true, true])
		},
	)
})

describe.skipIf(!JAVA)("the cursor advances past each delivered message; a reconnect reopens the chain", SLOW, () => {
	/* new: C# realtime.test.ts:177 (red under a delivery without the cursor advance: the bare URL again) */
	it("reconnects after a drop, the next upgrade and event stream carrying the last id and token", async () => {
		const replies = [refused, sse([ev(1), ev(2)], "drop"), refused, sse([ev(3)], "hold")]
		const drove = await drive(replies, [live({ take: 3 })], { script: QUICK })
		const resumed = "/feed?channel=c&last_event_id=2&reconnect_token=rt-2 -"
		expect([drove.run.observed, call(drove)?.stream, drove.hops.map(wire)], drove.run.stderr).toEqual([
			frames(frame(1), frame(2), frame(3)),
			settled(3, "3 rt-3", "sse"),
			[BARE, BARE, resumed, "/feed?channel=c&reconnect_token=rt-2 2"],
		])
	})

	/* new: C# realtime.test.ts:189 (the three cursors as three calls on one client) */
	it("opens with the caller's cursor on each transport's wire, and with none when it is unset or empty", async () => {
		const given = [{ lastEventId: "0", reconnectToken: "rt-0" }, {}, { lastEventId: "", reconnectToken: "" }]
		const replies = given.flatMap(() => [refused, sse([ev(1)], "hold")])
		const calls = given.map((cursor) => live({ ...cursor, take: 1 }))
		const drove = await drive(replies, calls)
		const wires = drove.hops.map(wire)
		const opened = ["/feed?channel=c&last_event_id=0&reconnect_token=rt-0 -", "/feed?channel=c&reconnect_token=rt-0 0"]
		expect([drove.run.observed, [0, 2, 4].map((i) => wires.slice(i, i + 2))], drove.run.stderr).toEqual([
			given.map(() => framed(frame(1))),
			[opened, [BARE, BARE], [BARE, BARE]],
		])
	})
})

describe.skipIf(!JAVA)("the long-poll fallback advances its own cursor and polls once per read", SLOW, () => {
	/* new: C# realtime.test.ts:205 (red under a poll's cursor copied at connect; Payload drops the id) */
	it("falls back past a refused upgrade and event stream, each poll carrying the cursor before it", async () => {
		const drove = await drive(POLLED, [live({ take: 2 })], { script: QUICK })
		expect([drove.run.observed, call(drove)?.stream], drove.run.stderr).toEqual([
			frames({ n: 1, reconnect_token: "rt-7" }, { n: 2, reconnect_token: "rt-8" }),
			settled(2, "8 rt-8", "longpoll"),
		])
		/* the hop URL, not the cursor: a poll that never advances its own still reports the connection's */
		const bare = ["upgrade", "sse", "poll"].map((dial) => `GET ${dial} ${FEED_URL}`)
		const polls = [...bare, "GET poll /feed?channel=c&last_event_id=7&reconnect_token=rt-7"]
		expect(drove.hops.map((hop) => `${hop.method} ${dialOf(hop)} ${hop.url}`)).toEqual(polls)
	})

	/* new: C# realtime.test.ts:218 (feed.resume is untyped: JsonNode, Fd7) */
	it("delivers one message per answer, a JSON array as one, and polls no further ahead than the reader", async () => {
		const replies = [refused, unavailable, { json: [{ n: 1 }, { n: 2 }], status: 200 }, { json: { n: 3 }, status: 200 }]
		const { hops, run } = await drive(replies, [{ ...RESUME, take: 2 }], { script: QUICK })
		expect([run.observed, hops.map((hop) => hop.url)], run.stderr).toEqual([
			frames([{ n: 1 }, { n: 2 }], { n: 3 }),
			Array.from({ length: 4 }, () => "/resume"),
		])
	})
})

describe.skipIf(!JAVA)("a reconnect backs off from an SSE retry, else the delay, else 1 s; a give-up", SLOW, () => {
	/* new: C# realtime.test.ts:230 (the four on one warmed client; the ceilings at 500 ms, the realistic mutant's floor) */
	it("waits at least half the base before the first reconnect: retry 2000, delay 10, the default; 0 none", async () => {
		/* the first backoff is jittered into the upper half of its base: 2000 → [1000, 2000], 10 → [5, 10], the
		 * default 1000 → [500, 1000], 0 → 0 */
		const hinted = [refused, sse([`retry: 2000\n${ev(1)}`], "drop"), refused, sse([ev(2)], "hold")]
		const replies = [...WARMED, ...hinted, ...RECONNECTING, ...RECONNECTING, ...RECONNECTING]
		const calls = [WARM, ...Array.from({ length: 4 }, () => live({ take: 2 }))]
		const script: Script = { calls: [{}, QUICK_ENTRY, QUICK_ENTRY, {}, { realtime: { reconnectDelayMs: 0 } }] }
		const drove = await drive(replies, calls, { script })
		const both = framed(frame(1), frame(2))
		expect([drove.run.observed, drove.hops.length], drove.run.stderr).toEqual([[WARM_SEEN, both, both, both, both], 18])
		const ms = [1, 2, 3, 4].map((i) => call(drove, i)?.elapsedMs ?? Number.NaN)
		const timing = { hinted: ms[0]! >= 1000, quick: ms[1]! < 500, unset: ms[2]! >= 500, zero: ms[3]! < 500 }
		expect(timing, ms.join(" ")).toEqual({ hinted: true, quick: true, unset: true, zero: true })
		expect(Math.max(ms[0]!, ms[2]!)).toBeLessThan(5000)
	})

	/* new: C# realtime.test.ts:248 */
	it("reconnects after a clean end, keeps the cursor on every attempt, and gives up after the max", async () => {
		/* each attempt runs the whole chain: upgrade, event stream, then a poll answered 500 */
		const down: Reply = { json: { message: "down" }, status: 500 }
		const replies = [refused, sse([ev(1)], "close"), refused, refused, down, refused, refused, down]
		const script = budget({ maxReconnectAttempts: 2, reconnectDelayMs: 1 })
		const drove = await drive(replies, [live({ take: 2 })], { script })
		const attempt = [`${AT_1} -`, "/feed?channel=c&reconnect_token=rt-1 1", `${AT_1} -`]
		expect([failure(drove), drove.run.observed, call(drove)?.stream, drove.hops.map(wire)], drove.run.stderr).toEqual([
			["InternalServerException", 500, "stream"],
			frames(frame(1)),
			settled(1, "1 rt-1", null, ["HTTP 500: down"]),
			[BARE, BARE, ...attempt, ...attempt],
		])
	})
})

describe.skipIf(!JAVA)("every dial carries the call's params, auth, headers and its own request id", SLOW, () => {
	/* new: C# realtime.test.ts:342 (both chains as two calls on one client) */
	it("sends the bearer, the config headers and the call's params on every upgrade, stream, poll and reconnect", async () => {
		const setup: Setup = { ...TOK, headers: { "X-Cfg": "1" } }
		const tenant = live({ headers: { "x-tenant": "acme" }, take: 2 })
		const { hops, run } = await drive([...RECONNECTING, ...POLLED], [tenant, tenant], { script: TWICE, setup })
		const read = run.observed?.map((o) => (o as { frames?: unknown[] } | null)?.frames?.length)
		const want = [[2, 2], Array.from({ length: 8 }, () => [true, "acme", "Bearer tok", "1"])]
		expect([read, hops.map(sent)], run.stderr).toEqual(want)
	})

	/* new: C# realtime.test.ts:352 */
	it("gives each dial a fresh X-Request-Id, the config's kept on each; a refused chain raises the typed status", async () => {
		const twice = [live({ take: 2 }), live({ take: 2 })]
		const script: Script = { calls: [QUICK_ENTRY, QUICK_ENTRY, { realtime: { maxReconnectAttempts: 0 } }] }
		const chains = [...RECONNECTING, ...POLLED]
		const fresh = await drive([...chains, refused, unavailable, bad], [...twice, live({ take: 1 })], { script })
		const fixed = await drive(chains, twice, { script: TWICE, setup: { headers: { "X-Request-Id": "fixed" } } })
		expect([new Set(ids(fresh)).size, ids(fresh), ids(fixed)], fresh.run.stderr + fixed.run.stderr).toEqual([
			11,
			Array.from({ length: 11 }, () => expect.stringMatching(UUID4)),
			Array.from({ length: 8 }, () => "fixed"),
		])
		const refusal = [failure(fresh, 2), call(fresh, 2)?.stream?.realtime?.errors, fresh.run.observed?.[2]]
		expect(refusal).toEqual([["BadRequestException", 400, "stream"], ["HTTP 400: bad"], framed()])
	})
})

describe.skipIf(!JAVA)("the SSE and long-poll dials ride the exchange; the WebSocket dial runs no hook", SLOW, () => {
	/* new: C# realtime.test.ts:370 */
	it("carries a refresh to the next upgrade, the hooks seeing the cursor sent and the operation's path", async () => {
		/* each stream dial gets the hooks, the log and the 401 refresh; the WebSocket dial reads the current
		 * token and runs no hook and no log */
		const expired: Reply = { json: { message: "expired" }, status: 401 }
		const replies = [refused, sse([ev(1)], "drop"), refused, expired, sse([ev(2)], "drop"), refused]
		replies.push(sse([ev(3)], "hold"))
		/* `hooks: {}` installs the driver's recording hooks (one per phase), which C#'s driver always installs */
		const script: Script = { ...QUICK, hooks: {}, log: true, onAuthExpired: { tokens: ["new"] } }
		const setup: Setup = { auth: { kind: "bearer", token: "old" } }
		const { base, hops, run } = await drive(replies, [live({ take: 3 })], { script, setup })
		const hooks = run.trace?.hooks ?? []
		const at = (url: string | undefined) => (url?.startsWith(base) ? url.slice(base.length) : url)
		const [first, second] = [`${FEED_URL}&reconnect_token=rt-1`, `${FEED_URL}&reconnect_token=rt-2`]
		const exchanged = ["request_start", "response_received 200"]
		const seen = {
			answered: hooks.filter((h) => h.phase === "response").map((h) => `${h.status} ${h.isRetry}`),
			authExpired: run.trace?.authExpired,
			hooked: hooks.filter((h) => h.phase === "request").map((h) => `${at(h.url)} ${h.path} ${h.isRetry}`),
			log: run.trace?.log.map((e) => [e.event, e.status].filter((v) => v !== undefined).join(" ")),
			observed: run.observed,
		}
		expect(seen, run.stderr).toEqual({
			answered: ["200 false", "401 false", "200 true", "200 false"],
			authExpired: 1,
			hooked: [`${FEED_URL} /feed false`, `${first} /feed false`, `${first} /feed true`, `${second} /feed false`],
			log: [...exchanged, ...exchanged, ...exchanged],
			observed: frames(frame(1), frame(2), frame(3)),
		})
		const dials = hops.map((hop) => `${hop.headers.upgrade ?? "sse"} ${hop.headers.authorization?.slice(7)}`)
		expect(dials.join(", ")).toBe("websocket old, sse old, websocket old, sse old, sse new, websocket new, sse new")
	})

	/* new: C# realtime.test.ts:402 */
	it("follows a same-origin redirect on the event-stream dial, and caps a poll's answer at maxResponseBytes", async () => {
		const moved: Reply = { redirect: { origin: "primary", path: "/moved?channel=c" }, status: 307 }
		const followed = await drive([refused, moved, sse([ev(1)], "hold")], [live({ take: 1 })], { script: QUICK })
		expect([followed.run.observed, followed.hops.map((hop) => hop.url)], followed.run.stderr).toEqual([
			frames(frame(1)),
			[FEED_URL, FEED_URL, "/moved?channel=c"],
		])
		const big: Reply = { json: { n: 1, pad: "x".repeat(100) }, status: 200 }
		const script: Script = { ...budget({ maxReconnectAttempts: 0 }), config: { maxResponseBytes: 64 } }
		const capped = await drive([refused, unavailable, big], [live({ take: 1 })], { script })
		const seen = [capped.run.observed, failure(capped), call(capped)?.stream?.realtime?.errors]
		const want = [frames(), ["ApiConnectionException", undefined, "stream"], ["the answer exceeds 64 bytes"]]
		expect(seen, capped.run.stderr).toEqual(want)
	})
})

describe.skipIf(!JAVA)("a send POSTs on the SSE and long-poll transports, its error status thrown", SLOW, () => {
	/* new: C# realtime.test.ts:430 */
	it("POSTs on a long-poll connection with the call's params, the bearer and compact JSON, then polls", async () => {
		const replies = [refused, unavailable, { json: {}, status: 200 }, polled(1, "7")]
		const sending = live({ headers: { "x-tenant": "acme" }, send: ['{"hi":1}'], take: 1 })
		const drove = await drive(replies, [sending], { script: QUICK, setup: TOK })
		const seen = [failure(drove), drove.run.observed]
		expect(seen, drove.run.stderr).toEqual([undefined, frames({ n: 1, reconnect_token: "rt-7" })])
		expect(drove.hops.slice(2)).toMatchObject([
			{ ...JSON_POST, headers: { authorization: "Bearer tok", "x-tenant": "acme" } },
			{ method: "GET", url: FEED_URL },
		])
		expect(drove.bodies[2]?.toString()).toBe('{"hi":1}')
	})

	/* new: C# realtime.test.ts:444 (a 405 has no class of its own: UnexpectedStatusException) */
	it("POSTs on an SSE connection; a POST answered 405 throws its status exception, no frames", async () => {
		const replies = [refused, sse([ev(1)], "hold"), { json: { message: "no" }, status: 405 }]
		const drove = await drive(replies, [live({ send: ['{"hi":1}'], take: 1 })], { script: QUICK, setup: TOK })
		const e = call(drove)?.error
		expect(drove.hops[2], drove.run.stderr).toMatchObject({ ...JSON_POST, headers: { authorization: "Bearer tok" } })
		const seen = [drove.run.observed, e?.type, e?.chain.includes("ApiException"), e?.status, e?.via]
		expect(seen).toEqual([frames(), "UnexpectedStatusException", true, 405, "stream"])
	})
})
