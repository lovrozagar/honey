/**
 * The Python SDK's WebSocket keepalive (bit 19 d1, sweep item 26): httpx2's session pings every
 * `ClientConfig.ws_keepalive` seconds (20 by default, as it always did: probes/python-ws.txt) and, with no pong within
 * as long, closes 1011 "Keepalive ping timeout", so `recv` on a peer gone dead behind a live connection raises within
 * about twice the interval. The config passes the interval through; a test sets 0.2 s and the server reads every ping
 * and answers none. Its 1009 on an over-cap message is httpx2's (the probe; ws.test.ts pins the error text).
 */
import { describe, expect, it } from "vitest"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { withPython } from "./__fixtures__/python-env.ts"

const PY = withPython()
const SLOW = { timeout: 600_000 }

/** Open the socket under a 0.2 s keepalive and `recv` with a 5 s bound: how the read ended, and whether in time. */
const BODY = `import time
async with aclient(ws_keepalive=0.2) as c:
    w = await c.rooms.socket("r")
    started = time.monotonic()
    try:
        await asyncio.wait_for(w.recv(), 5)
        ended = "a message"
    except TimeoutError:
        ended = "timed out"
    except sdk.APIConnectionError:
        ended = "APIConnectionError"
    note(f"{ended} within 2x {time.monotonic() - started < 0.6}")`

describe.skipIf(!PY)("the Python SDK's WebSocket keepalive (bit 19 d1)", SLOW, () => {
	it("ends a socket whose peer never answers a ping within about twice the interval, having pinged, 1011 on the wire", async () => {
		const { run, streams } = await served([{ status: 101, ws: { pong: false, steps: [] } }], async (server) => ({
			run: await consume("ws", "keepalive", { base: server.url, body: BODY }),
			streams: [...server.streams],
		}))
		expect(
			{ out: run.out?.main, pinged: (streams[0]?.pings ?? 0) > 0, received: streams[0]?.received, ran: run.ran },
			run.stderr,
		).toEqual({
			out: ["APIConnectionError within 2x True"],
			pinged: true,
			ran: true,
			received: [{ code: 1011, kind: "close", reason: "Keepalive ping timeout" }],
		})
	})
})
