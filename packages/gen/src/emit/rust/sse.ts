/**
 * An SSE operation's answer (contract 20 §2.0–2.1): `EventStream<E>`, `E` the declared event schema's type
 * (`String` for untyped events), and its Opts' `last_event_id`, sent as Last-Event-ID only when set and
 * non-empty; a declared Last-Event-ID header param is folded into that field (Fd3).
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { typeAt } from "./sdk-body.ts"
import type { OptsField, StreamAnswer, StreamOpts } from "./sdk-opts.ts"
import type { RustTypeContext } from "./types.ts"

/** The resume cursor's id, which the SSE and realtime Opts carry. */
export const LAST_EVENT_ID = { ident: "last_event_id", type: "Option<String>" }

/** Whether a declared param is the Last-Event-ID header (any casing), the resume channel an SSE dial sends. */
export const isLastEventIdHeader = (param: string, where: OptsField["in"]) =>
	where === "header" && param.toLowerCase() === "last-event-id"

/** A streamed event's type: the operation's declared event schema, else `fallback`. */
export const eventType = (op: SdkOp, at: RustTypeContext, fallback: string) =>
	op.events === undefined ? fallback : typeAt(op.events, op.id, "Event", at)

/* Last-Event-ID, sent only when set: an empty cursor names no position */
const SSE: StreamOpts = {
	carries: isLastEventIdHeader,
	fields: [LAST_EVENT_ID],
	sends: ['spec.header("Last-Event-ID", &crate::request::cursor(&opts.last_event_id));'],
}

const DOC =
	"Resolves once the stream is open: an error status is the answer's error (`Err(Error::Api)`, on `client.safe()` an `Answer::Err`). No timeout bounds the stream after that; `cancel_on` ends it quietly, and dropping it closes it."

/** The SSE operation `op`'s answer: its events as text, or JSON decoded into the event type. */
export function sseAnswer(op: SdkOp, at: RustTypeContext): StreamAnswer {
	const events = eventType(op, at, "String")
	const run = op.events === undefined ? "crate::events::text" : `crate::events::json::<${events}>`
	return { doc: DOC, run, stream: SSE, type: `EventStream<${events}>` }
}
