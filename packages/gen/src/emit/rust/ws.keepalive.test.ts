/**
 * The Rust SDK's WebSocket ends (bit 19 d1, sweep items 25 and 26). An over-cap message closes the socket with 1009
 * "Message too big", RFC 6455's code, as Go, Python and C# send (it ended with no close frame). And an open socket
 * pings every `ClientConfig::ws_keepalive` (20 s by default) while a read waits, ending when a ping goes unanswered
 * as long, so `recv` on a peer gone dead behind a live connection fails within about twice the interval. The realtime
 * transport reads through the same socket. A test sets 200 ms; the server reads every ping and answers none.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { type DrivenRustSdk, drivenRustSdk } from "./__fixtures__/driven.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

const RUST = withRust()
const CARGO = { timeout: 600_000 }
const MESSAGE_CAP = 16 << 20
const rooms = (extra: Partial<Call> = {}): Call => ({
	operation: "rooms.socket",
	params: { room: "r" },
	route: { method: "GET", path: "/rooms/{room}" },
	...extra,
})

function driven(): DrivenRustSdk {
	const sdk = drivenRustSdk("ws")
	expect(sdk.built, sdk.stderr).toBe(true)
	return sdk
}

/** Open the socket under a 200 ms keepalive and `recv` with a 5 s bound: how the read ended, and whether in time. */
const BODY = `let config = sdk::ClientConfig {
        base_url: base.into(),
        ws_keepalive: Some(std::time::Duration::from_millis(200)),
        ..Default::default()
    };
    let c = sdk::Client::new(config).expect("client");
    let mut w = c.rooms().socket("r", &sdk::RoomsSocketOpts::default()).await.expect("open");
    let started = std::time::Instant::now();
    let read = tokio::time::timeout(std::time::Duration::from_secs(5), w.recv()).await;
    let in_time = started.elapsed() < std::time::Duration::from_millis(600);
    let ended = match read {
        Err(_) => "timed out".to_string(),
        Ok(None) => "ended quietly".to_string(),
        Ok(Some(Ok(_))) => "a message".to_string(),
        Ok(Some(Err(e))) => format!("{e:?}").split('(').next().unwrap_or("").to_string(),
    };
    n.note(format!("{ended} within 2x {in_time}"));`

describe.skipIf(!RUST)("the Rust SDK's WebSocket ends (bit 19 d1)", CARGO, () => {
	it("closes with 1009 on a message one byte over 16 MiB", async () => {
		const sdk = driven()
		const reply: Reply = { status: 101, ws: { steps: [{ text: "x".repeat(MESSAGE_CAP + 1) }] } }
		const { streams } = await served([reply], async (server) => {
			await sdk.runCalls({ calls: [rooms()], setup: {} }, server, {})
			return { streams: [...server.streams] }
		})
		expect(streams[0]?.received).toEqual([{ code: 1009, kind: "close", reason: "Message too big" }])
	})

	it("ends a socket whose peer never answers a ping within about twice the interval, having pinged", async () => {
		const { run, streams } = await served([{ status: 101, ws: { pong: false, steps: [] } }], async (server) => ({
			run: await consume("ws", "keepalive", { base: server.url, body: BODY }),
			streams: [...server.streams],
		}))
		expect({ built: run.built, out: run.out?.main, pinged: (streams[0]?.pings ?? 0) > 0 }, run.stderr).toEqual({
			built: true,
			out: ["Transport within 2x true"],
			pinged: true,
		})
	})
})
