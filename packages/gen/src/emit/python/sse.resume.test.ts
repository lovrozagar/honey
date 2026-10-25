/**
 * An event stream's resume cursor is the last event it delivered (bit 19 d1, sweep item 17): `last_event_id` names the
 * id of the last event `anext()` handed out, never an `id:` the parser read but never dispatched or delivered, so a
 * caller resuming from it never skips an event. Go, C#, Java and the Python realtime transports already resume from
 * the delivered event.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, seen } from "./__fixtures__/consumer.ts"
import { withPython } from "./__fixtures__/python-env.ts"

const PY = withPython()
const SLOW = { timeout: 600_000 }

const sse = (steps: readonly string[]): Reply => ({ sse: { end: "close", steps }, status: 200 })

/** Reads `take` events (every one when unset), noting each event's data, then the stream's cursor. */
const reading = (take?: number) => `async with aclient() as c:
    async with await c.text.stream() as s:
        taken = 0
        async for ev in s:
            note(ev.data)
            taken += 1
            if taken == ${take ?? -1}:
                break
        note(f"cursor {s.last_event_id}")`

describe.skipIf(!PY)("an event stream's cursor is the last event delivered (bit 19 d1)", SLOW, () => {
	it("keeps the delivered id when the stream ends on an `id:` it never dispatched", async () => {
		const run = await served([sse(["id: 7\ndata: a\n\n", "id: 9\ndata: b"])], (server) =>
			consume("sse", "resume_undispatched", { base: server.url, body: reading() }),
		)
		expect(seen(run), run.stderr).toEqual({ out: ["a", "cursor 7"], ran: true })
	})

	it("keeps the delivered id when a dispatched event is still unread", async () => {
		const run = await served([sse(["id: 7\ndata: a\n\nid: 8\ndata: b\n\n"])], (server) =>
			consume("sse", "resume_unread", { base: server.url, body: reading(1) }),
		)
		expect(seen(run), run.stderr).toEqual({ out: ["a", "cursor 7"], ran: true })
	})
})
