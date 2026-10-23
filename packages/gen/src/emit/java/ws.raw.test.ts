/**
 * A WebSocket dial's answer in the Java SDK (bit 16 phase d2a, K3, K4, K10; C#'s `ws.raw.test.ts`): `RequestOptions.raw`
 * holds the 101's status and the dialed ws:// URL (its headers empty: the JDK's WebSocket exposes none, K10's FLAG) or a
 * refused handshake's status, headers and body (read at most 64 KiB); a refusal is its status exception; a closed origin
 * is ApiConnectionException; no redirect is followed; the call's timeout bounds the handshake; and a 101 the JDK
 * refuses fails closed, the SDK naming an unoffered subprotocol (W5) and, for an Accept mismatch or another Upgrade, the
 * handshake (K4's FLAG: the JDK owns the key).
 */
import { describe, expect, it } from "vitest"
import type { Call, Setup } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type Reply, REFUSED_URL, served } from "../shared/__fixtures__/recording-server.ts"
import { type DrivenJavaSdk, drivenJavaSdk } from "./__fixtures__/driven.ts"
import { withJava } from "./__fixtures__/java-env.ts"

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
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
/** The warm call a timed call follows on its client, unbounded (per-call timeout 0). */
const WARM = rooms({ take: 0, timeoutMs: 0 })
/** The ApiConnectionException a 101 the JDK refused throws from the method (K4). */
const handshake = (why?: string) => ({
	text: why === undefined ? "the WebSocket handshake failed" : `the WebSocket handshake failed: ${why}`,
	type: "ApiConnectionException",
	via: "return",
})

/** The `ws` SDK with the driver aimed at it, which must build. */
function driven(): DrivenJavaSdk {
	const sdk = drivenJavaSdk("ws")
	expect(sdk.built, sdk.diagnostics.join("\n")).toBe(true)
	return sdk
}

/** `calls` run by the `ws` driver under `script` and `setup` against a server answering `replies`: the run and the hops. */
async function drive(replies: readonly Reply[], calls: readonly Call[], script: Script = {}, setup: Setup = {}) {
	const sdk = driven()
	return served(replies, async (server) => {
		const run = await sdk.runCalls({ calls, setup }, { url: server.url }, { script })
		return { hops: [...server.hops], run }
	})
}

/** A traced error as these legs pin it: its type, its text and how it reached the driver; null for none. */
const failed = (error: { type: string; text: string; via: string } | undefined) =>
	error === undefined ? null : { text: error.text, type: error.type, via: error.via }

/**
 * The `raw` consumer: one accepted socket and one refused, each with its own box, printed as its status, URL (the
 * host as `H`), the `upgrade` and `x-handshake` headers (`-` when absent) and its body's text, an empty one as 0.
 */
const RAW = (url: string) => `package probe;

import ai.anyrow.*;

public class Probe {
  static String shown(RawResponse box) {
    String text = box.body().length == 0 ? "0" : new String(box.body(), java.nio.charset.StandardCharsets.UTF_8);
    String at = box.url().toString().replace(java.net.URI.create("${url}").getAuthority(), "H");
    return box.status() + " " + at + " " + box.headers().getOrDefault("upgrade", "-") + " "
        + box.headers().getOrDefault("x-handshake", "-") + " " + text;
  }

  public static void main(String[] args) {
    AnyrowClient c = AnyrowClient.builder().baseUrl("${url}").build();
    RawResponse raw = new RawResponse();
    TypedWebSocket w = c.rooms().socket(RoomsSocketParams.builder().room("r").since(3L).build(),
        RequestOptions.builder().raw(raw).build());
    System.out.println(shown(raw));
    w.close();
    RawResponse refused = new RawResponse();
    try {
      c.rooms().socket(RoomsSocketParams.builder().room("r").build(), RequestOptions.builder().raw(refused).build());
      System.out.println("opened");
    } catch (ForbiddenException e) {
      System.out.println(e.getClass().getSimpleName() + ": " + e.getMessage());
    }
    System.out.println(shown(refused));
    System.exit(0);
  }
}
`

describe.skipIf(!JAVA)("a WebSocket call's RequestOptions.raw: the handshake's answer (K10)", SLOW, () => {
	/* new: C# ws.raw.test.ts:99 (K10 FLAG: the JDK exposes no 101 headers, so the accepted box's are empty) */
	it("holds the 101's status and the dialed ws:// URL, and a refused handshake's status, headers and body", async () => {
		const accepted = ws([], { headers: { "x-handshake": "h-1" } })
		const refusal: Reply = { headers: { "x-handshake": "h-2" }, json: { message: "no" }, status: 403 }
		const ran = await served([accepted, refusal], (server) => driven().exec("probe.Probe", RAW(server.url)))
		expect({ out: ran.stdout.split("\n").filter((l) => l !== ""), status: ran.status }, ran.stderr).toEqual({
			out: [
				"101 ws://H/rooms/r?since=3 - - 0",
				"ForbiddenException: HTTP 403: no",
				'403 ws://H/rooms/r - h-2 {"message":"no"}',
			],
			status: 0,
		})
	})
})

describe.skipIf(!JAVA)("what fails at the handshake: the method throws, nothing read", SLOW, () => {
	/* new: C# ws.raw.test.ts:116 */
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

	/* new: the W2 ruling (C# Exchange.cs:18, :209): a refused handshake's body is read at most 64 KiB */
	it("reads a refused handshake's body at most 64 KiB: a 200 KiB body is cut", async () => {
		const big: Reply = { headers: { "content-type": "text/plain" }, status: 403, text: "x".repeat(200 * 1024) }
		const { run } = await drive([big], [rooms()])
		const observed = run.observed?.[0] as { body?: unknown } | undefined
		expect({ size: typeof observed?.body === "string" ? observed.body.length : null }, run.stderr).toEqual({
			size: 65_536,
		})
	})

	/* new: C# ws.raw.test.ts:132 */
	it("is ApiConnectionException for a closed origin, its text the call's route", async () => {
		const run = await driven().runCalls({ calls: [rooms()], setup: {} }, { url: REFUSED_URL }, { script: {} })
		expect({ error: failed(run.trace?.calls[0]?.error), observed: run.observed }, run.stderr).toEqual({
			error: { text: expect.stringMatching(/^GET \/rooms\/\{room\}: /), type: "ApiConnectionException", via: "return" },
			observed: [null],
		})
	})
})

describe.skipIf(!JAVA)("the dial follows no redirect and waits no longer than the call's timeout", SLOW, () => {
	/* new: C# ws.raw.test.ts:147 (W3: the JDK follows nothing on a client built on NEVER; the dial takes no exchange loop) */
	it("follows no redirect on the upgrade, under Follow: each 307 is the answer, one hop", async () => {
		const away: Reply = { redirect: { origin: "alt", path: "/rooms/r" }, status: 307 }
		const back: Reply = { redirect: { origin: "primary", path: "/rooms/r" }, status: 307 }
		const { hops, run } = await drive([away, back, ws([]), ws([])], [rooms(), rooms()], {}, { redirect: "follow" })
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

	/* new: C# ws.raw.test.ts:168 (W6: the deadline as connectTimeout bounds the whole handshake) */
	it("bounds a slow handshake by the call's timeout: ApiTimeoutException via return, the grid's timeout", async () => {
		const slow = { ...ws([]), delayMs: 3000 }
		const { hops, run } = await drive([ws([]), slow], [WARM, rooms()], {}, { timeoutMs: 300 })
		const call = run.trace?.calls[1]
		const elapsed = call?.elapsedMs ?? -1
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

describe.skipIf(!JAVA)("a 101 the JDK refuses: it fails closed, the subprotocol named (K4, W4, W5)", SLOW, () => {
	/* new: C# ws.raw.test.ts:188 (K4 FLAG: the JDK owns the key, so the reason is the handshake's) */
	it("refuses a 101 whose Sec-WebSocket-Accept is not the key's: ApiConnectionException, nothing read", async () => {
		const bogus = ws([{ text: "unread" }], { headers: { "sec-websocket-accept": "bogus" } })
		const { hops, run } = await drive([bogus], [rooms({ take: 1 })])
		expect(
			{ error: failed(run.trace?.calls[0]?.error), hops: hops.length, observed: run.observed },
			run.stderr,
		).toEqual({
			error: handshake(),
			hops: 1,
			observed: [null],
		})
	})

	/* new: C# ws.raw.test.ts:204 */
	it("refuses a 101 whose Upgrade is not websocket, another token or none: ApiConnectionException", async () => {
		const replies = [ws([], { headers: { upgrade: "h2c" } }), ws([], { headers: { upgrade: "" } })]
		const { hops, run } = await drive(replies, [rooms({ take: 0 }), rooms({ take: 0 })])
		const errors = run.trace?.calls.map((call) => failed(call.error))
		expect({ errors, hops: hops.length, observed: run.observed }, run.stderr).toEqual({
			errors: [handshake(), handshake()],
			hops: 2,
			observed: [null, null],
		})
	})

	/* new: C# ws.raw.test.ts:217 (W5: the SDK checks the answer's Sec-WebSocket-Protocol against what it offered) */
	it("refuses a subprotocol that was not offered, offered or not, naming it; none chosen when none was offered opens", async () => {
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
