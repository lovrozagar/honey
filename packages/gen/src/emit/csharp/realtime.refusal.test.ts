/**
 * A realtime open every transport refuses ends the connection (bit 19 e, carry-in #6). Within one open a refused
 * transport still falls through to the next (a refused upgrade is how a server without WebSockets sends a client on to
 * the event stream); the open is refused only when every transport of the chain refused 400, 401, 403, 404, 405, 410
 * or 422 (the long-poll's lazily, on its first read). The loop then stops and surfaces the most specific refusal (401,
 * 403, 422, 400, 410, then 404 and 405; a tie goes to the earlier transport), never backing off to hammer a server that
 * said no. An open with any transient failure (408, 429, 5xx, a transport error) backs off, as before. A 401 refreshes
 * once per open, through the client's OnAuthExpired, and the chain restarts from its first transport with the new
 * token; another 401 in that open is a refusal like the others.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { drivenCSharpSdk } from "./__fixtures__/driven.ts"

const DOTNET = withDotnet()
const SLOW = { timeout: 600_000 }

const FEED: Call = {
	operation: "feed.live",
	route: { method: "GET", path: "/feed" },
	search: { channel: "c" },
	take: 2,
}
const refused: Reply = { json: { message: "no" }, status: 404 }
const ev = (n: number) => `id: ${n}\ndata: {"n":${n},"reconnect_token":"rt-${n}"}\n\n`
/** an upgrade refused, then an event stream delivering one event and dropping: the connection is open, then lost */
const OPENED: readonly Reply[] = [refused, { sse: { end: "drop", steps: [ev(1)] }, status: 200 }]
const answered = (status: number): Reply => ({ json: { message: `refused ${status}` }, status })
/** a reconnect pass: the upgrade, the event stream and the poll answered `statuses` */
const pass = (...statuses: number[]) => statuses.map(answered)
const SCRIPT: Script = { calls: [{ realtime: { maxReconnectAttempts: 3, reconnectDelayMs: 1 } }] }
/** a client sending "old", whose OnAuthExpired answers "new" */
const AUTH = {
	script: { ...SCRIPT, onAuthExpired: { tokens: ["new"] } } satisfies Script,
	setup: { auth: { kind: "bearer", token: "old" } } satisfies Setup,
}

/** A hop as `<kind> <token>`: an upgrade, an event-stream open or a poll, and the bearer token it sent. */
const dial = (hop: RecordedHop) =>
	`${hop.headers.upgrade ?? (hop.headers.accept === "text/event-stream" ? "sse" : "poll")} ${hop.headers.authorization?.slice(7)}`

/** The feed driven against `replies`: the call's error as `[type, status]`, its hops, its dials and its refreshes. */
async function drove(replies: readonly Reply[], o: { script?: Script; setup?: Setup } = {}) {
	const sdk = drivenCSharpSdk("realtime")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
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

/** Beside `Program`: an adapter opening as `inner` once, then failing every connect with an IOException. */
const DECLS = `internal sealed class Once(ITransportAdapter inner) : ITransportAdapter
{
    private int _opens;
    public string Name => inner.Name;
    public TransportKind Kind => inner.Kind;
    public Task<ITransportConnection> ConnectAsync(string url, TransportOptions options, System.Threading.CancellationToken token) =>
        _opens++ == 0 ? inner.ConnectAsync(url, options, token) : throw new System.IO.IOException("reset");
}`

/**
 * A caller's chain of the call's WebSocket adapter and `second` (over `sse`, the call's SSE adapter), no long-poll, so
 * every adapter of a pass fails at its connect: the setup call's two refused dials, the chain opening (OPENED), then
 * two reads, each noted as its value or `<Type> <State>`.
 */
const chain = (second: string) => `using var c = Client(new ClientConfig { BearerToken = "tok" });
string url;
IReadOnlyList<ITransportAdapter> adapters;
await using (var setup = await c.Feed.LiveAsync("c")) (url, adapters) = (setup.Url, setup.Adapters);
var sse = adapters[1];
var options = new TransportOptions { MaxReconnectAttempts = 3, ReconnectDelay = TimeSpan.FromMilliseconds(1) };
await using var rc = new ResumableConnection<JsonElement>(url, [adapters[0], ${second}], HoneySdkJsonContext.Default.JsonElement, options);
await rc.ConnectAsync();
var e = rc.GetAsyncEnumerator();
for (var i = 0; i < 2; i++)
{
    try { Note(await e.MoveNextAsync() ? e.Current.GetRawText() : "ended"); }
    catch (Exception x) { Note($"{x.GetType().Name} {rc.State}"); }
}`

/** The chain with `second` against the setup's two refusals, OPENED and `passes`: its hops and its run. */
const chained = (second: string, ...passes: Reply[][]) =>
	served([...pass(404, 404), ...OPENED, ...passes.flat()], async (server) => {
		const run = await consume("realtime", "realtime-refusal-chain", {
			base: server.url,
			body: chain(second),
			decls: DECLS,
		})
		return { hops: server.hops.length, run }
	})
const FIRST = '{"n":1,"reconnect_token":"rt-1"}'

describe.skipIf(!DOTNET)("a realtime open every transport refuses ends the connection (bit 19 e)", SLOW, () => {
	it("ends a caller's chain whose every adapter refuses 403 at connect after one pass", async () => {
		const { hops, run } = await chained("sse", pass(403, 403), pass(403, 403), pass(403, 403))
		const notes = [FIRST, "ForbiddenException Disconnected"]
		expect({ hops, notes: run.out?.main }, run.stderr).toEqual({ hops: 2 + 2 + 2, notes })
	})

	it("retries a caller's chain pass refused 503 then 404, and ends at the next pass refused throughout", async () => {
		const { hops, run } = await chained("sse", pass(503, 404), pass(403, 403), pass(403, 403))
		const notes = [FIRST, "ForbiddenException Disconnected"]
		expect({ hops, notes: run.out?.main }, run.stderr).toEqual({ hops: 2 + 2 + 2 + 2, notes })
	})

	it("backs off on a refusal mixed with a transient failure, a 503 or a transport error, never ending at it", async () => {
		const unavailable = await chained("sse", pass(404, 503), pass(404, 503), pass(404, 503))
		const reset = await chained("new Once(sse)", pass(404), pass(404), pass(404))
		const seen = [unavailable, reset].map(({ hops, run }) => ({ hops, notes: run.out?.main }))
		expect(seen, unavailable.run.stderr + reset.run.stderr).toEqual([
			{ hops: 2 + 2 + 6, notes: [FIRST, "ServiceUnavailableException Disconnected"] },
			{ hops: 2 + 2 + 3, notes: [FIRST, "IOException Disconnected"] },
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

describe.skipIf(!DOTNET)("a 401 refreshes once per open, the chain restarting from its first transport", SLOW, () => {
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
