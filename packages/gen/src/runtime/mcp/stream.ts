/**
 * An event stream as a tool (bit 18 phase e, Q6): one bounded collect, never a loop the agent does not see. It gathers
 * events until the stream ends, `max_events` arrive, the whole would pass 100,000 characters, or the call's timeout
 * from its start passes, and says which (`ended`), with the last event id to resume from; each event a progress step.
 * A cut is a success. Only a stream that never opened in time, its own client having had no answer, is a timeout.
 */
import { json, TEXT_MAX } from "./result.ts"
import type { ToolResult } from "./server.ts"

/** One event as the TS SDK yields it. */
type Event = { readonly data: unknown; readonly event?: string; readonly id?: string }

/** A collect's call: its abort and timeout, whether its stream opened, each event's progress step and scrubber. */
type CollectCall = {
	readonly signal: AbortSignal
	readonly timeout: number
	readonly opened: () => boolean
	readonly progress: (done: number) => void
	readonly scrub: (value: unknown) => unknown
}

/** `iterator`'s events until it ends, `max` arrive, the cap, or `bound` aborts; and why it stopped. */
async function gather(iterator: AsyncIterator<Event>, max: number, bound: AbortSignal, at: CollectCall) {
	const cut = new Promise<"timeout">((settle) => bound.addEventListener("abort", () => settle("timeout")))
	const events: object[] = []
	let last: string | null = null
	let chars = 0
	for (;;) {
		const next = bound.aborted ? "timeout" : await Promise.race([iterator.next(), cut])
		if (next === "timeout" || next.done)
			return { ended: next === "timeout" ? "timeout" : "end", events, last_event_id: last }
		const { data, event, id } = next.value
		const one = at.scrub({ data, ...(event === undefined ? {} : { event }), ...(id === undefined ? {} : { id }) })
		chars += JSON.stringify(one).length
		if (chars > TEXT_MAX) return { ended: "cap", events, last_event_id: last }
		events.push(one as object)
		last = id ?? last
		at.progress(events.length)
		if (events.length >= max) return { ended: "max_events", events, last_event_id: last }
	}
}

/** The collect `send` opens, reading its `[max_events, last_event_id]` properties of `args`. */
export async function collected(
	[max, lastEventId]: readonly [string, string],
	args: Record<string, unknown>,
	send: (more: object) => unknown,
	at: CollectCall,
): Promise<ToolResult> {
	const bound = AbortSignal.any([at.signal, AbortSignal.timeout(at.timeout)])
	const resume = typeof args[lastEventId] === "string" ? { lastEventId: args[lastEventId] } : {}
	const iterator = ((await send({ ...resume, signal: bound })) as AsyncIterable<Event>)[Symbol.asyncIterator]()
	try {
		const value = await gather(iterator, (args[max] as number | undefined) ?? 20, bound, at)
		if (value.ended === "timeout" && value.events.length === 0 && !at.opened())
			return json({ kind: "timeout", message: "The stream did not open within the call's timeout" }, true)
		return { ...json(value), structuredContent: value }
	} finally {
		/* closes the stream's body; a read still pending settles once the bound has aborted the request */
		void iterator.return?.().catch(() => undefined)
	}
}
