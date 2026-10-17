/**
 * An SSE operation's answer (contract 34 §2.0–2.1): `EventStream[E]`, `E` the declared event schema's type (`str`
 * for untyped events), opened by awaiting the method (G15), and its `last_event_id` field, sent as Last-Event-ID
 * only when set and non-empty; a declared Last-Event-ID header param is folded into that field (Fd3).
 */
import { eventType, type PyStream } from "./sdk-answer.ts"

/** The header the SSE and realtime dials resume an event stream with. */
export const LAST_EVENT_ID = "Last-Event-ID"

/** Whether a declared param is the Last-Event-ID header (any casing), the resume channel an SSE dial sends. */
export const isLastEventIdHeader = (name: string, where: string) =>
	where === "header" && name.toLowerCase() === LAST_EVENT_ID.toLowerCase()

/** The SSE operation's answer, its one field and its docstring's lines. */
export const sseStream: PyStream = {
	answer: (op, env) => {
		const events = eventType(op, env, "str")
		return { returns: `EventStream[${events}]`, run: "sse", type: events }
	},
	carries: isLastEventIdHeader,
	doc: [
		"Opens the stream: an error status raises before any event. No timeout bounds it after that;",
		'options["cancel"], aclose() or dropping it ends it.',
	],
	fields: ["last_event_id: str | None = None"],
}
