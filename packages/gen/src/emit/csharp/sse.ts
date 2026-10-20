/**
 * An SSE operation's answer (contract 50 §2, Fd1, Fd4): `Task<EventStream<T>>` through `EventsAsync`, `T` the
 * declared event schema's type, or `Task<EventStream<string>>` through `TextEventsAsync` for untyped events, opened
 * by awaiting the method (G15). Its one field, `lastEventId`, is sent as Last-Event-ID only when set and non-empty;
 * a declared Last-Event-ID header param is folded into that field.
 */
import { type CsStream, eventType } from "./sdk-answer.ts"

/** The header the SSE and realtime dials resume an event stream with. */
export const LAST_EVENT_ID = "Last-Event-ID"

/** The resume cursor's event id, which the SSE and realtime methods take. */
export const LAST_EVENT_ID_FIELD = { ident: "lastEventId", type: "string?" }

/** Whether a declared param is the Last-Event-ID header (any casing), the resume channel an SSE dial sends. */
export const isLastEventIdHeader = (name: string, where: string) =>
	where === "header" && name.toLowerCase() === LAST_EVENT_ID.toLowerCase()

/** The SSE operation's answer, its one field and its `<returns>` text. */
export const sseStream: CsStream = {
	answer: (op, env) => {
		const type = op.events === undefined ? null : eventType(op.events, op, env)
		return {
			render: (spell) =>
				type === null
					? ["Task<EventStream<string>>", "TextEventsAsync"]
					: [`Task<EventStream<${spell.runtime(type)}>>`, "EventsAsync"],
			type,
		}
	},
	args: ["lastEventId"],
	carries: isLastEventIdHeader,
	fields: [LAST_EVENT_ID_FIELD],
	returns:
		"The open stream: an error status throws before any event. No timeout bounds it after that; the token, leaving await foreach or DisposeAsync ends it.",
}
