/**
 * How each stream surface ends when it is closed under a read waiting in another task (contract 34 Fd1–Fd3, §1
 * rules): `EventStream.aclose()` ends the read quietly; `TypedWebSocket.close()` ends it with `None`, the close
 * handler fired once and no error; and when httpx2 closed the session itself (as it does when a send's write
 * fails) after the server's close frame came, the read still ends on `closed_by`. `ResumableConnection.close()`
 * ends a `recv` waiting in the reconnect's backoff or on a poll in flight at once, with `None` and no reconnect
 * (v0 N-CL). Consumers on the `sse`, `ws` and `realtime` registry documents.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import type { FixtureKey } from "./__fixtures__/documents.ts"
import { withPython } from "./__fixtures__/python-env.ts"

/** Whether Python is here: a missing interpreter fails where it is required and skips these legs elsewhere (python-env). */
const PY = withPython()
/** Every executed describe's bound: a cold gate builds the venv and the package first. */
const SLOW = { timeout: 600_000 }

/** The consumer `name` over `key` against a server answering `replies`: its run. */
const consumed = (key: FixtureKey, name: string, replies: readonly Reply[], body: string) =>
	served(replies, (server) => consume(key, name, { base: server.url, body }))

/** `reader` awaited at most 2 s after the close: its value's repr, its error, or `stalled`. */
const SETTLED = `async def settled(reader):
    try:
        return repr(await asyncio.wait_for(reader, 2))
    except TimeoutError:
        return "stalled"
    except Exception as e:
        return f"{type(e).__name__}: {e}"
`

const STREAM = `${SETTLED}
async with aclient() as c:
    s = await c.ticks.stream()
    note((await anext(s)).data["n"])
    reader = asyncio.ensure_future(anext(s, None))
    await asyncio.sleep(0.2)
    await s.aclose()
    note(await settled(reader))`

const SOCKET = `${SETTLED}
async with aclient() as c:
    w = await c.rooms.socket("r")
    w.on("close", lambda by: note(f"close {by.code}"))
    w.on("error", lambda e: note(f"error {e}"))
    reader = asyncio.ensure_future(w.recv())
    await asyncio.sleep(0.2)
    await w.close()
    note(await settled(reader))`

/** The server's close frame read (the session remote-closing), then the session closed 1011 as httpx2 does on a failed write. */
const CLOSED_UNDER = `async with aclient() as c:
    w = await c.rooms.socket("r")
    await asyncio.sleep(0.3)
    await w.session.close(1011, "Stream write error")
    note([repr(await w.recv()), repr(w.closed_by)])`

/** A caller's adapter whose one conn ends at once: the connection's next reconnect backs off 2.5 to 5 s. */
const BACKOFF = `${SETTLED}
class Ended:
    async def recv(self):
        return None
    async def send(self, text):
        pass
    async def close(self):
        pass
class Once:
    def __init__(self):
        self.connects = 0
    def name(self):
        return "once"
    def kind(self):
        return sdk.TransportKind.SSE
    async def connect(self, url, opts):
        self.connects += 1
        return Ended()
once = Once()
rc = sdk.ResumableConnection("http://rt.test/feed", [once], sdk.TransportOpts(reconnect_delay_ms=5000))
await rc.connect()
reader = asyncio.ensure_future(rc.recv())
await asyncio.sleep(0.2)
await rc.close()
note([await settled(reader), str(rc.state), once.connects])`

/** A call refused over WebSocket and SSE, open over long-poll, its first poll answered after 3 s. */
const POLLING = `${SETTLED}
rc = await aclient().feed.live(channel="c")
reader = asyncio.ensure_future(rc.recv())
await asyncio.sleep(0.3)
await rc.close()
note([await settled(reader), str(rc.state), str(rc.proven_transport)])`

const refused: Reply = { json: { message: "no" }, status: 404 }

describe.skipIf(!PY)("an EventStream and a TypedWebSocket closed under a read in another task", SLOW, () => {
	it("ends the read of an EventStream closed by aclose() quietly: no event, no error", async () => {
		const run = await consumed(
			"sse",
			"stream",
			[{ sse: { end: "hold", steps: ['data: {"n":1}\n\n'] }, status: 200 }],
			STREAM,
		)
		expect(seen(run), run.stderr).toEqual({ out: ["1", "None"], ran: true })
	})

	it("ends the read of a TypedWebSocket closed by close() with None, close fired once and no error", async () => {
		const run = await consumed("ws", "socket", [{ status: 101, ws: { steps: [] } }], SOCKET)
		expect(seen(run), run.stderr).toEqual({ out: ["close 1000", "None"], ran: true })
	})

	it("ends a read on the server's close frame as closed_by once httpx2 closed the session itself", async () => {
		const closing: Reply = { status: 101, ws: { steps: [{ close: { code: 4401, reason: "unauthorized" } }] } }
		const run = await consumed("ws", "closed_under", [closing], CLOSED_UNDER)
		expect(seen(run), run.stderr).toEqual({
			out: ['["None", "WsClose(code=4401, reason=\'unauthorized\')"]'],
			ran: true,
		})
	})
})

describe.skipIf(!PY)("a ResumableConnection closed under a recv in another task", SLOW, () => {
	it("ends a recv waiting in the reconnect's backoff at once: None, disconnected, no reconnect", async () => {
		const run = await consume("realtime", "backoff", { body: BACKOFF })
		expect(seen(run), run.stderr).toEqual({ out: ['["None", "disconnected", 1]'], ran: true })
	})

	it("ends a recv waiting on a poll in flight at once: None, disconnected, the poll let go", async () => {
		const replies = [refused, { status: 503, text: "" }, { delayMs: 3000, json: { n: 1 }, status: 200 }]
		const run = await consumed("realtime", "polling", replies, POLLING)
		expect(seen(run), run.stderr).toEqual({ out: ['["None", "disconnected", "longpoll"]'], ran: true })
	})
})
