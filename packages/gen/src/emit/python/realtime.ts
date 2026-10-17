/**
 * A realtime operation's answer (contract 34 §2.0, §2.3; Fd3): `ResumableConnection[E]`, `E` the declared event
 * schema's type (`Any` for a string or absent one), opened by awaiting the method over WebSocket, else SSE, else
 * long-poll. Its five fields are the `TransportOpts` of their names: the resume cursor, the offered subprotocols
 * and the reconnect policy; a declared param on a resume channel is folded in, and one named like a policy field
 * is claimed as `…2` (`sdk-method.ts`).
 */
import { eventType, type PyStream } from "./sdk-answer.ts"
import { isLastEventIdHeader, sseStream } from "./sse.ts"
import { pyTypeOf } from "./types.ts"
import { isReconnectToken, PROTOCOLS, RECONNECT_TOKEN } from "./ws.ts"

/** The realtime operation's answer, its five fields and its docstring's lines. */
export const realtimeStream: PyStream = {
	answer: (op, env) => {
		const events = eventType(op, env, pyTypeOf({ kind: "unknown" }, env.at))
		return { returns: `ResumableConnection[${events}]`, run: "realtime", type: events }
	},
	/* the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID */
	carries: (name, where) =>
		isReconnectToken(name, where) ||
		(where === "query" && name === "last_event_id") ||
		isLastEventIdHeader(name, where),
	doc: [
		"Opens the connection over WebSocket, else SSE, else long-poll; recv() reconnects after a drop and",
		"resumes after the last message it delivered.",
	],
	fields: [
		...sseStream.fields,
		RECONNECT_TOKEN,
		PROTOCOLS,
		"max_reconnect_attempts: int | None = None",
		"reconnect_delay_ms: int | None = None",
	],
}
