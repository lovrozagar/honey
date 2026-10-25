/**
 * An event stream's resume cursor is the last event it delivered (bit 19 d1, sweep item 17): `last_event_id` names the
 * id of the last event `next()` handed out, never an `id:` the parser read but never dispatched or delivered, so a
 * caller resuming from it never skips an event. Go, C#, Java and the Rust realtime transports already resume from the
 * delivered event.
 */
import { describe, expect, it } from "vitest"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { consume, sections, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

const RUST = withRust()
const CARGO = 600_000

const sse = (steps: readonly string[]): Reply => ({ sse: { end: "close", steps }, status: 200 })

/** Reads `take` events (every one when unset), noting each event's data, then the stream's cursor. */
const reading = (take?: number) =>
	sections({
		resume: `    let c = client(base)?;
    let mut s = c.text().stream(&sdk::TextStreamOpts::default()).await?;
    let mut taken = 0;
    while let Some(ev) = s.next().await {
        n.note(ev?.data);
        taken += 1;
        if Some(taken) == ${take === undefined ? "None" : `Some(${take})`} {
            break;
        }
    }
    n.note(format!("cursor {}", s.last_event_id()));`,
	})

describe.skipIf(!RUST)("an event stream's cursor is the last event delivered (bit 19 d1)", () => {
	it(
		"keeps the delivered id when the stream ends on an `id:` it never dispatched",
		async () => {
			const program = reading()
			const run = await served([sse(["id: 7\ndata: a\n\n", "id: 9\ndata: b"])], (server) =>
				consume("sse", "resume_undispatched", { base: server.url, ...program }),
			)
			expect(seen(run, "resume"), run.stderr).toEqual({ built: true, out: ["a", "cursor 7"] })
		},
		CARGO,
	)

	it(
		"keeps the delivered id when a dispatched event is still unread",
		async () => {
			const program = reading(1)
			const run = await served([sse(["id: 7\ndata: a\n\nid: 8\ndata: b\n\n"])], (server) =>
				consume("sse", "resume_unread", { base: server.url, ...program }),
			)
			expect(seen(run, "resume"), run.stderr).toEqual({ built: true, out: ["a", "cursor 7"] })
		},
		CARGO,
	)
})
