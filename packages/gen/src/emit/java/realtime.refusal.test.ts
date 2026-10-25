/**
 * A realtime open every transport refuses ends the connection (bit 19 e, carry-in #6), as C#'s does. Within one open a
 * refused transport still falls through to the next; the open is refused only when every transport of the chain
 * refused 400, 401, 403, 404, 405, 410 or 422 (the long-poll's lazily, on its first read). The loop then stops and
 * surfaces the most specific refusal (401, 403, 422, 400, 410, then 404 and 405; a tie goes to the earlier transport).
 * An open with any transient failure (408, 429, 5xx, a transport error) backs off. A 401 refreshes once per open,
 * through the client's onAuthExpired, and the chain restarts from its first transport with the new token; another 401
 * in that open is a refusal like the others.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { notesOf, runner } from "./__fixtures__/realtime-program.ts"
import { drivenRealtime, ev, refused } from "./__fixtures__/realtime.ts"

const JAVA = withJava()
const SLOW = { timeout: 600_000 }

const FEED: Call = {
	operation: "feed.live",
	route: { method: "GET", path: "/feed" },
	search: { channel: "c" },
	take: 2,
}
/** an upgrade refused, then an event stream delivering one event and dropping: the connection is open, then lost */
const OPENED: readonly Reply[] = [refused, { sse: { end: "drop", steps: [ev(1)] }, status: 200 }]
const answered = (status: number): Reply => ({ json: { message: `refused ${status}` }, status })
/** a reconnect pass: the upgrade, the event stream and the poll answered `statuses` */
const pass = (...statuses: number[]) => statuses.map(answered)
const SCRIPT: Script = { calls: [{ realtime: { maxReconnectAttempts: 3, reconnectDelayMs: 1 } }] }
/** a client sending "old", whose onAuthExpired answers "new" */
const AUTH = {
	script: { ...SCRIPT, onAuthExpired: { tokens: ["new"] } } satisfies Script,
	setup: { auth: { kind: "bearer", token: "old" } } satisfies Setup,
}

/** A hop as `<kind> <token>`: an upgrade, an event-stream open or a poll, and the bearer token it sent. */
const dial = (hop: RecordedHop) =>
	`${hop.headers.upgrade ?? (hop.headers.accept === "text/event-stream" ? "sse" : "poll")} ${hop.headers.authorization?.slice(7)}`

/** The feed driven against `replies`: the call's error as `[type, status]`, its hops, its dials and its refreshes. */
async function drove(replies: readonly Reply[], o: { script?: Script; setup?: Setup } = {}) {
	const sdk = drivenRealtime()
	return served(replies, async (server) => {
		const cell = { calls: [FEED], setup: o.setup ?? {} }
		const run = await sdk.runCalls(cell, { url: server.url }, { script: o.script ?? SCRIPT })
		const error = run.trace?.calls[0]?.error
		return {
			dials: server.hops.map(dial),
			error: error && [error.type, error.status],
			hops: server.hops.length,
			refreshes: run.trace?.authExpired,
			stderr: run.stderr,
		}
	})
}

/**
 * A caller's chain of the call's WebSocket adapter and `second` (over `sse`, the call's SSE adapter; `once` opens as
 * it once, then fails every connect with ApiConnectionException "reset"), no long-poll, so every adapter of a pass fails
 * at its connect: the setup call's two refused dials, the chain opening (OPENED), then two reads and the state after.
 */
const chain = (second: string) => `AnyrowClient c = AnyrowClient.builder().baseUrl(BASE).bearerToken("tok").build();
String url;
List<TransportAdapter> adapters;
try (ResumableConnection<Payload> setup = c.feed().live(feed())) {
  url = setup.url();
  adapters = setup.adapters();
}
TransportAdapter sse = adapters.get(1);
int[] opens = {0};
TransportAdapter once = new TransportAdapter() {
  public String name() { return sse.name(); }
  public TransportKind kind() { return sse.kind(); }
  public TransportConnection connect(String at, TransportOptions cursor) {
    if (opens[0]++ > 0) throw new ApiConnectionException("reset", null);
    return sse.connect(at, cursor);
  }
};
TransportOptions options = TransportOptions.builder().maxReconnectAttempts(3).reconnectDelay(Duration.ofMillis(1)).build();
try (ResumableConnection<JsonNode> rc = new ResumableConnection<>(url, List.of(adapters.get(0), ${second}), Rt.ELEMENT, options)) {
  rc.connect();
  note(Rt.json(Rt.take(rc, 2)));
  note(Rt.j(rc.state().toString()));
}`

const servedRun = runner()
/** The chain with `second` as program `name` against the setup's two refusals, OPENED and `passes`: its run and hops. */
const chained = (name: string, second: string, ...passes: Reply[][]) =>
	servedRun(`realtime-refusal-${name}`, { chain: chain(second) }, [...pass(404, 404), ...OPENED, ...passes.flat()])
/** The chain read its first event, then `error`, and ended DISCONNECTED, `hops` dialed. */
const ended = (hops: number, error = "ForbiddenException: HTTP 403: refused 403") => ({
	hops,
	notes: [[{ n: 1, reconnect_token: "rt-1" }, error], ["DISCONNECTED"]],
	ran: true,
})
/** A chain program's run as `ended` reads it. */
const read = ({ hops, run }: Awaited<ReturnType<typeof chained>>) => ({ ...notesOf(run, "chain"), hops: hops.length })

describe.skipIf(!JAVA)("a realtime open every transport refuses ends the connection (bit 19 e)", SLOW, () => {
	it("ends a caller's chain whose every adapter refuses 403 at connect after one pass", async () => {
		const run = await chained("all", "sse", pass(403, 403), pass(403, 403), pass(403, 403))
		expect(read(run), run.run.stderr).toEqual(ended(2 + 2 + 2))
	})

	it("retries a caller's chain pass refused 503 then 404, and ends at the next pass refused throughout", async () => {
		const run = await chained("retried", "sse", pass(503, 404), pass(403, 403), pass(403, 403))
		expect(read(run), run.run.stderr).toEqual(ended(2 + 2 + 2 + 2))
	})

	it("backs off on a refusal mixed with a transient failure, a 503 or a transport error, never ending at it", async () => {
		const unavailable = await chained("unavailable", "sse", pass(404, 503), pass(404, 503), pass(404, 503))
		const reset = await chained("reset", "once", pass(404), pass(404), pass(404))
		expect([read(unavailable), read(reset)], unavailable.run.stderr + reset.run.stderr).toEqual([
			ended(2 + 2 + 6, "ServiceUnavailableException: HTTP 503: refused 503"),
			ended(2 + 2 + 3, "ApiConnectionException: reset"),
		])
	})

	it("stops after one pass refused 403 on every dial, the typed 403, no backoff", async () => {
		const { error, hops, stderr } = await drove([...OPENED, ...pass(403, 403, 403), ...pass(403, 403, 403)])
		expect({ error, hops }, stderr).toEqual({ error: ["ForbiddenException", 403], hops: 2 + 3 })
	})

	it("surfaces a refused pass's most specific refusal: 422 over 400 over 404", async () => {
		const { error, hops, stderr } = await drove([...OPENED, ...pass(404, 422, 400), ...pass(403, 403, 403)])
		expect({ error, hops }, stderr).toEqual({ error: ["UnprocessableEntityException", 422], hops: 2 + 3 })
	})

	it("surfaces the 401 of a WebSocket 404 then an SSE 401, and the first 404 when all three are 404", async () => {
		const unauthorized = await drove([...OPENED, ...pass(404, 401, 404), ...pass(403, 403, 403)])
		const missing = await drove([...OPENED, ...pass(404, 404, 404), ...pass(403, 403, 403)])
		const seen = [unauthorized, missing].map(({ error, hops }) => ({ error, hops }))
		expect(seen, unauthorized.stderr + missing.stderr).toEqual([
			{ error: ["UnauthorizedException", 401], hops: 2 + 3 },
			{ error: ["NotFoundException", 404], hops: 2 + 3 },
		])
	})

	it("backs off and retries a pass refused 503, giving up at the attempt budget", async () => {
		const passes = [...pass(503, 503, 503), ...pass(503, 503, 503), ...pass(503, 503, 503)]
		const { error, hops, stderr } = await drove([...OPENED, ...passes])
		expect({ error, hops }, stderr).toEqual({ error: ["ServiceUnavailableException", 503], hops: 2 + 9 })
	})

	it("retries a pass whose refusals are mixed with a 429: only a pass refused deterministically throughout ends", async () => {
		const passes = [...pass(403, 429, 403), ...pass(403, 429, 403), ...pass(403, 429, 403)]
		const { error, hops, stderr } = await drove([...OPENED, ...passes])
		expect({ error, hops }, stderr).toEqual({ error: ["ForbiddenException", 403], hops: 2 + 9 })
	})
})

describe.skipIf(!JAVA)("a 401 refreshes once per open, the chain restarting from its first transport", SLOW, () => {
	it("refreshes an SSE 401 once, then opens the restarted chain on SSE with the new token", async () => {
		const opened: Reply = { sse: { end: "hold", steps: [ev(1), ev(2)] }, status: 200 }
		const { dials, error, refreshes, stderr } = await drove([refused, answered(401), refused, opened], AUTH)
		const sent = ["websocket old", "sse old", "websocket new", "sse new"]
		expect({ dials, error, refreshes }, stderr).toEqual({ dials: sent, error: undefined, refreshes: 1 })
	})

	it("refreshes a long-poll's first-read 401 once, then opens the restarted chain on SSE with the new token", async () => {
		const opened: Reply = { sse: { end: "hold", steps: [ev(1), ev(2)] }, status: 200 }
		const { dials, error, refreshes, stderr } = await drove([...pass(404, 404, 401), refused, opened], AUTH)
		const sent = ["websocket old", "sse old", "poll old", "websocket new", "sse new"]
		expect({ dials, error, refreshes }, stderr).toEqual({ dials: sent, error: undefined, refreshes: 1 })
	})

	it("refreshes once in an open every transport answers 401: the restarted chain's 401s are refusals", async () => {
		const { dials, error, refreshes, stderr } = await drove(pass(401, 401, 401, 401, 401, 401), AUTH)
		const sent = ["websocket old", "websocket new", "sse new", "poll new"]
		expect({ dials, error, refreshes }, stderr).toEqual({
			dials: sent,
			error: ["UnauthorizedException", 401],
			refreshes: 1,
		})
	})
})
