/**
 * A refusal ends a Python realtime connection (bit 19 e, carry-in #6): a deterministic 4xx (400, 401, 403, 404, 405,
 * 410, 422) from every transport of the chain, or from the open transport, is the connection's end, its typed error
 * raised at once; the reconnect loop never backs off over it. A transient status (408, 429, 5xx) or a transport error
 * keeps reconnecting until the attempts run out. Within one open, a refused transport still falls through to the
 * next (a refused upgrade is how a server says it has no WebSocket), so the chain's failure is a refusal only when
 * every transport refused. Dials are counted on the recording server's hops.
 */
import { describe, expect, it } from "vitest"
import type { Call } from "../../../tests/integration/conformance/matrix.ts"
import type { Script } from "../shared/__fixtures__/protocol.ts"
import { type RecordedHop, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume } from "./__fixtures__/consumer.ts"
import { drivenPythonSdk } from "./__fixtures__/driven.ts"
import { withPython } from "./__fixtures__/python-env.ts"

const PY = withPython()
const SLOW = { timeout: 600_000 }

const LIVE: Call = {
	operation: "feed.live",
	route: { method: "GET", path: "/feed" },
	search: { channel: "c" },
	take: 1,
}
/* two reconnects at most, a millisecond apart: a retried status shows as hops past the first chain's three */
const TWO: Script = { calls: [{ realtime: { maxReconnectAttempts: 2, reconnectDelayMs: 1 } }] }
/** Every dial answered `status`: the upgrade, the event stream, each poll. */
const every = (status: number): Reply[] => Array.from({ length: 12 }, () => ({ json: { message: "no" }, status }))

/** The feed opened on AsyncSDK under TWO against a server answering every dial `status`: its hops, and its error. */
async function refusedWith(status: number) {
	const sdk = drivenPythonSdk("realtime")
	expect(sdk.imported, sdk.stderr).toBe(true)
	const { hops, run } = await served(every(status), async (server) => {
		const ran = await sdk.runCalls({ calls: [LIVE], setup: {} }, { url: server.url }, { client: "async", script: TWO })
		return { hops: [...server.hops], run: ran }
	})
	const error = run.trace?.calls[0]?.error
	return { dials: hops.length, error: error && [error.chain.includes("APIStatusError"), error.status] }
}

/**
 * A caller's [SSE, WebSocket] chain, its adapters from a feed whose upgrade and stream were refused, under three
 * reconnects: one event, the stream's close, then the reconnects' chains until the connection ends.
 */
const CHAIN = `c = aclient()
async with await c.feed.live(channel="c") as setup:
    adapters = setup.adapters
opts = sdk.TransportOpts(max_reconnect_attempts=3, reconnect_delay_ms=1)
async with sdk.ResumableConnection(setup.url, [adapters[1], adapters[0]], opts) as rc:
    await rc.connect()
    for _ in range(2):
        try:
            note(await asyncio.wait_for(rc.recv(), 10))
        except sdk.APIStatusError as e:
            note([e.status, str(rc.state)])`
const no = (status: number): Reply => ({ json: { message: "no" }, status })

/**
 * `times` opens of the [WebSocket, SSE] chain from a feed whose upgrade and stream were refused, over a client
 * (`hooked`: sending `old`, `on_auth_expired` counted and answering `new`): each open's refusal status, else its
 * transport and first event; then the refreshes.
 */
const opened = (times: number, hooked: boolean) => `calls = []
async def expired():
    calls.append(1)
    return "new"
c = ${hooked ? 'aclient(bearer_token="old", on_auth_expired=expired)' : "aclient()"}
async with await c.feed.live(channel="c") as setup:
    adapters = setup.adapters
for _ in range(${times}):
    rc = sdk.ResumableConnection(setup.url, adapters[:2])
    try:
        await rc.connect()
        note([str(rc.proven_transport), await asyncio.wait_for(rc.recv(), 10)])
    except sdk.APIStatusError as e:
        note(e.status)
    await rc.close()
note(len(calls))`

/** A hop as its kind and the credential it sent. */
const dialed = (h: RecordedHop) =>
	`${h.headers.upgrade === "websocket" ? "upgrade" : "sse"} ${h.headers.authorization ?? "-"}`

/** `body` run against a server answering the setup's two refusals, then `replies`: its notes, each later hop as kind and credential. */
async function chained(body: string, replies: readonly Reply[]) {
	const { hops, run } = await served([no(404), no(404), ...replies], async (server) => {
		const ran = await consume("realtime", "pins", { base: server.url, body })
		return { hops: [...server.hops], run: ran }
	})
	return {
		dials: hops.slice(2).map(dialed),
		out: run.out?.main,
		stderr: run.stderr,
	}
}

describe.skipIf(!PY)(
	"a refusal ends a Python realtime connection; a transient status backs off (bit 19 e)",
	SLOW,
	() => {
		it.each([400, 401, 403, 404, 405, 410, 422])(
			"ends at %i from every transport: the first chain's three dials, the typed error, no reconnect",
			async (status) => {
				expect(await refusedWith(status)).toEqual({ dials: 3, error: [true, status] })
			},
		)

		it.each([408, 429, 503])(
			"backs off over %i: the first chain and two reconnects' chains, nine dials, then the error",
			async (status) => {
				expect(await refusedWith(status)).toEqual({ dials: 9, error: [true, status] })
			},
		)
	},
)

describe.skipIf(!PY)("the failure of a chain that did not open, and its one refresh (bit 19 e)", SLOW, () => {
	it("ends a chain only when every transport refused: a 503 then a 404 retries, two 404s end it", async () => {
		const stream: Reply = { sse: { end: "close", steps: ['data: {"n":1}\n\n'] }, status: 200 }
		const replies = [no(404), no(404), stream, no(503), no(404), no(404), no(404), no(503), no(503)]
		const { hops, run } = await served(replies, async (server) => {
			const ran = await consume("realtime", "chain", { base: server.url, body: CHAIN })
			return { hops: server.hops.length, run: ran }
		})
		expect({ hops, out: run.out?.main }, run.stderr).toEqual({
			hops: 7,
			out: ['{"n": 1}', '[404, "disconnected"]'],
		})
	})

	it("surfaces the most specific refusal when every transport refused: 401 > 403 > 422 > 400 > 410 > 404 = 405, a tie the first", async () => {
		const pairs: [number, number][] = [
			[401, 404],
			[404, 401],
			[422, 403],
			[405, 404],
			[404, 404],
		]
		const { out, stderr } = await chained(opened(5, false), pairs.flat().map(no))
		expect(out, stderr).toEqual(["401", "401", "403", "405", "404", "0"])
	})

	it("refreshes once on a 401 and restarts the chain from its first transport with the new token", async () => {
		const stream: Reply = { sse: { end: "hold", steps: ['data: {"n":1}\n\n'] }, status: 200 }
		expect(await chained(opened(1, true), [no(404), no(401), no(404), stream])).toMatchObject({
			dials: ["upgrade Bearer old", "sse Bearer old", "upgrade Bearer new", "sse Bearer new"],
			out: ['["sse", {"n": 1}]', "1"],
		})
	})

	it("refreshes once per open: a second 401 in the restarted chain is a refusal like the others", async () => {
		const replies = [no(404), no(401), no(401), no(404), ...Array.from({ length: 6 }, () => no(404))]
		expect(await chained(opened(1, true), replies)).toMatchObject({
			dials: ["upgrade Bearer old", "sse Bearer old", "upgrade Bearer new", "sse Bearer new"],
			out: ["401", "1"],
		})
	})
})
