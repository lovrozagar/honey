/**
 * A WebSocket call's handshake in C# (contract 50 §5.5; Python's `ws.raw.test.ts` and its `ws.test.ts` handshake
 * legs): `RequestOptions.Raw` holds the answer the upgrade really got, an accepted `101` with the `ws://` URL it
 * dialed and its headers, or a refusal with its status, headers and body; a refused handshake is its status's
 * exception with that body; a closed origin, a redirect the dial never follows (a caller primary that follows them
 * included), and a slow handshake under the call's timeout each fail the method itself, nothing read; and the three
 * RFC 6455 §4.1 checks no BCL layer makes (Q-d1, the 2b probe): `Upgrade: websocket`, `Sec-WebSocket-Accept` against
 * the key the SDK sent, and a chosen subprotocol that was offered. Driven on the `ws` registry document; `Raw` is a consumer.
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, served, REFUSED_URL } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { withDotnet } from "./__fixtures__/csharp-env.ts"
import { type DrivenCSharpSdk, drivenCSharpSdk } from "./__fixtures__/driven.ts"

/** Whether .NET is here: a missing SDK fails where it is required and skips these legs elsewhere (csharp-env). */
const DOTNET = withDotnet()
/** Every executed describe's bound: a cold gate builds the SDK and the driver first. */
const SLOW = { timeout: 600_000 }

const rooms = (extra: Partial<Call> = {}): Call => ({
	operation: "rooms.socket",
	params: { room: "r" },
	route: { method: "GET", path: "/rooms/{room}" },
	...extra,
})
/** An accepted upgrade running `steps`, answering with `protocol` and `headers` (spread last, so they override). */
const ws = (steps: NonNullable<Reply["ws"]>["steps"], more: Omit<Reply, "status" | "ws"> = {}, protocol?: string) =>
	({ ...more, status: 101, ws: protocol === undefined ? { steps } : { protocol, steps } }) satisfies Reply
/** A socket that opened and was read for nothing (`take: 0`), then closed by the driver. */
const OPENED = { frames: [], kind: "frames" }
/**
 * The warm call a timed call follows on its client, unbounded (per-call timeout 0): .NET's first request on a
 * starved core pays JIT, handler init and the connect inside the timed window (4d1f701).
 */
const WARM = rooms({ take: 0, timeoutMs: 0 })
/** The ApiConnectionException a failed RFC 6455 check throws from the method (contract 50 §1, "WS dial"). */
const handshake = (why: string) => ({
	text: `the WebSocket handshake failed: ${why}`,
	type: "ApiConnectionException",
	via: "return",
})

/** The `ws` SDK with the driver aimed at it, which must build. */
function driven(): DrivenCSharpSdk {
	const sdk = drivenCSharpSdk("ws")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` run by the `ws` driver under `script` and `setup` against a server answering `replies`: the run and the hops. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script = {}, setup: Setup = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const cell = { calls, setup }
		const run = await sdk.runCalls(cell, { url: server.url }, { script })
		return { hops: [...server.hops], run }
	})
}

/** A traced error as these legs pin it: its type, its text and how it reached the driver; null for none. */
const failed = (error: { type: string; text: string; via: string } | undefined) =>
	error === undefined ? null : { text: error.text, type: error.type, via: error.via }

/**
 * The `raw` consumer: one accepted socket and one refused, each with its own box. `Shown` prints a box as its
 * status, URL (the host as `H`), the `upgrade` and `x-handshake` headers (`-` when absent) and its body's text,
 * an empty body as its length.
 */
const RAW = `string Shown(RawResponse box)
{
    var text = box.Body.Length == 0 ? "0" : System.Text.Encoding.UTF8.GetString(box.Body);
    var url = box.Url?.ToString().Replace(new Uri(_base).Authority, "H");
    var upgrade = box.Headers.GetValueOrDefault("upgrade", "-");
    var mark = box.Headers.GetValueOrDefault("x-handshake", "-");
    return $"{box.Status} {url} {upgrade} {mark} {text}";
}
using var c = Client();
var raw = new RawResponse();
var w = await c.Rooms.SocketAsync("r", since: 3, options: new RequestOptions { Raw = raw });
Note(Shown(raw));
await w.CloseAsync();
var refused = new RawResponse();
try
{
    await c.Rooms.SocketAsync("r", options: new RequestOptions { Raw = refused });
    Note("opened");
}
catch (ForbiddenException e)
{
    Note($"{e.GetType().Name}: {e.Message}");
}
Note(Shown(refused));`

describe.skipIf(!DOTNET)("a WebSocket call's RequestOptions.Raw: the handshake's real answer", SLOW, () => {
	/* ported: python ws.raw.test.ts:42 (options["raw"] becomes RequestOptions.Raw) */
	it("holds the 101 with the dialed ws:// URL and its headers, and a refused handshake's status, headers and body", async () => {
		const accepted = ws([], { headers: { "x-handshake": "h-1" } })
		const refusal: Reply = { headers: { "x-handshake": "h-2" }, json: { message: "no" }, status: 403 }
		const run = await served([accepted, refusal], (server) => consume("ws", "raw", { base: server.url, body: RAW }))
		expect(seen(run), run.stderr).toEqual({
			out: [
				"101 ws://H/rooms/r?since=3 websocket h-1 0",
				"ForbiddenException: HTTP 403: no",
				'403 ws://H/rooms/r - h-2 {"message":"no"}',
			],
			ran: true,
		})
	})
})

describe.skipIf(!DOTNET)("what fails at the handshake: the method throws, nothing read", SLOW, () => {
	/* ported: python ws.test.ts:380 */
	it("is the status's exception for a refused handshake, its body read: ForbiddenException, HTTP 403: no", async () => {
		const { hops, run } = await drive([{ json: { message: "no" }, status: 403 }], [rooms()])
		const call = run.trace?.calls[0]
		expect(run.observed, run.stderr).toEqual([{ body: { message: "no" }, errorKey: null, kind: "error", status: 403 }])
		expect({
			error: failed(call?.error),
			stream: call?.stream,
			upgrades: hops.map((hop) => `${hop.url} ${hop.headers.upgrade}`),
		}).toEqual({
			error: { text: "HTTP 403: no", type: "ForbiddenException", via: "return" },
			stream: undefined,
			upgrades: ["/rooms/r websocket"],
		})
	})

	/* ported: python ws.test.ts:393 (phase c's closed origin: a server that closed, never a fixed port) */
	it("is ApiConnectionException for a closed origin, its text the call's route, never a raw HttpRequestException", async () => {
		const closed = REFUSED_URL
		const run = await driven().runCalls({ calls: [rooms()], setup: {} }, { url: closed }, { script: {} })
		expect({ error: failed(run.trace?.calls[0]?.error), observed: run.observed }, run.stderr).toEqual({
			error: { text: expect.stringMatching(/^GET \/rooms\/\{room\}: /), type: "ApiConnectionException", via: "return" },
			observed: [null],
		})
	})
})

describe.skipIf(!DOTNET)("the dial follows no redirect and waits no longer than the call's timeout", SLOW, () => {
	/*
	 * ported: python ws.test.ts:401; red under M8 (the dial through the exchange's redirect loop): under Follow that
	 * loop takes the cross-origin 307, and it takes a same-origin one under any policy
	 */
	it("follows no redirect on the upgrade through a caller primary, under Follow: each 307 is the answer, one hop", async () => {
		const away: Reply = { redirect: { origin: "alt", path: "/rooms/r" }, status: 307 }
		const back: Reply = { redirect: { origin: "primary", path: "/rooms/r" }, status: 307 }
		const replies = [away, back, ws([]), ws([])]
		const script: Script = { config: { httpClient: true } }
		const { hops, run } = await drive(replies, [rooms(), rooms()], script, { redirect: "follow" })
		const errors = run.trace?.calls.map(({ error }) => [error?.type, error?.status, error?.via])
		const refused = expect.objectContaining({ kind: "error", status: 307 })
		expect({ errors, hops: hops.map((hop) => `${hop.origin} ${hop.url}`), observed: run.observed }, run.stderr).toEqual(
			{
				errors: [
					["UnexpectedStatusException", 307, "return"],
					["UnexpectedStatusException", 307, "return"],
				],
				hops: ["primary /rooms/r", "primary /rooms/r"],
				observed: [refused, refused],
			},
		)
	})

	/* ported: python ws.test.ts:411 (the timed call is the client's second, after an unbounded one) */
	it("bounds a slow handshake by the call's timeout: ApiTimeoutException via return, the grid's timeout", async () => {
		const slow = { ...ws([]), delayMs: 3000 }
		const { hops, run } = await drive([ws([]), slow], [WARM, rooms()], {}, { timeoutMs: 300 })
		const call = run.trace?.calls[1]
		const elapsed = call?.elapsedMs ?? -1
		/* the outcome tells a bounded handshake from one that waited for the 101; the ceiling has a load margin */
		expect(
			{ error: [call?.error?.type, call?.error?.via], fast: elapsed < 2500, hops: hops.length, observed: run.observed },
			`${run.stderr} elapsed ${elapsed}`,
		).toEqual({
			error: ["ApiTimeoutException", "return"],
			fast: true,
			hops: 2,
			observed: [OPENED, { kind: "timeout" }],
		})
	})
})

describe.skipIf(!DOTNET)("the RFC 6455 §4.1 checks the SDK makes on a 101 (Q-d1: no BCL layer does)", SLOW, () => {
	/* RFC 6455 §4.1, Q-d1; red under M13 (the accept check off) */
	it("refuses a 101 whose Sec-WebSocket-Accept is not the key's: ApiConnectionException from the method", async () => {
		const bogus = ws([{ text: "unread" }], { headers: { "sec-websocket-accept": "bogus" } })
		const { hops, run } = await drive([bogus], [rooms({ take: 1 })])
		const error = failed(run.trace?.calls[0]?.error)
		expect({ error, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			error: handshake("the Sec-WebSocket-Accept does not match"),
			hops: 1,
			observed: [null],
		})
	})

	/*
	 * the implementer's leg (bit 15 2b probe): .NET hands a 101 whose Upgrade is another token or empty to the SDK
	 * (its handler chain saw `101 upgrade=[h2c]` and `101 upgrade=[]`), so the SDK's own check is the only one; red
	 * with that check off, the socket opening on both
	 */
	it("refuses a 101 whose Upgrade is not websocket, another token or none: ApiConnectionException from the method", async () => {
		const replies = [ws([], { headers: { upgrade: "h2c" } }), ws([], { headers: { upgrade: "" } })]
		const { hops, run } = await drive(replies, [rooms({ take: 0 }), rooms({ take: 0 })])
		const errors = run.trace?.calls.map((call) => failed(call.error))
		const refused = handshake("the answer has no Upgrade: websocket")
		expect({ errors, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			errors: [refused, refused],
			hops: 2,
			observed: [null, null],
		})
	})

	/* RFC 6455 §4.1, Q-d1; red under M13 (the subprotocol check off) */
	it("refuses a subprotocol that was not offered, offered or not; none chosen when none was offered opens", async () => {
		const replies = [ws([], {}, "v9"), ws([]), ws([], {}, "v9")]
		const calls = [rooms({ take: 0 }), rooms({ take: 0 }), rooms({ take: 0 })]
		const script: Script = { calls: [{ protocols: ["v1"] }, null, null] }
		const { hops, run } = await drive(replies, calls, script)
		const errors = run.trace?.calls.map((call) => failed(call.error))
		const offered = hops.map((hop) => hop.headers["sec-websocket-protocol"])
		const unoffered = handshake("the server chose subprotocol v9, which was not offered")
		expect({ errors, observed: run.observed, offered }, run.stderr).toEqual({
			errors: [unoffered, null, unoffered],
			observed: [null, OPENED, null],
			offered: ["v1", undefined, undefined],
		})
	})
})
