/**
 * A WebSocket call's `options["raw"]` (contract 34 §1, Rust's `opened`): the answer the handshake really got, as
 * the realtime call's raw holds the answer its connection opened with (`realtime.transports.test.ts`). An accepted
 * upgrade leaves its `101`, the `ws://` URL it dialed with the call's query, and the handshake's headers; a refused
 * one leaves the refusal: its status, headers and body, read whole, beside the status's error. Consumers on the
 * `ws` registry document against the recording server.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

/** A raw box as a note: its status, URL (the host as `H`), two headers and its body's text. */
const RAW = `host = BASE.split("://", 1)[1]


def shown(raw):
    headers = [raw.headers.get(name) for name in ("upgrade", "x-handshake")]
    return [raw.status, raw.url.replace(host, "H"), *headers, raw.body.decode()]
`

const BODY = `${RAW}
async with aclient(bearer_token="tok") as c:
    raw = sdk.RawResponse()
    w = await c.rooms.socket("r", since=3, options={"raw": raw})
    note(shown(raw))
    await w.close()
    refused = sdk.RawResponse()
    try:
        await c.rooms.socket("r", options={"raw": refused})
        note("opened")
    except sdk.ForbiddenError as e:
        note(f"{type(e).__name__}: {e}")
    note(shown(refused))`

describe.skipIf(!PY)("a WebSocket call's options['raw']: the handshake's real answer", SLOW, () => {
	it("holds the 101 with the dialed ws:// URL and its headers, and a refused handshake's status, headers and body", async () => {
		const accepted: Reply = { headers: { "x-handshake": "h-1" }, status: 101, ws: { steps: [] } }
		const refusal: Reply = { headers: { "x-handshake": "h-2" }, json: { message: "no" }, status: 403 }
		const run = await served([accepted, refusal], (server) => consume("ws", "raw", { base: server.url, body: BODY }))
		expect(seen(run), run.stderr).toEqual({
			out: [
				'[101, "ws://H/rooms/r?since=3", "websocket", "h-1", ""]',
				"ForbiddenError: HTTP 403: no",
				'[403, "ws://H/rooms/r", null, "h-2", "{\\"message\\":\\"no\\"}"]',
			],
			ran: true,
		})
	})
})
