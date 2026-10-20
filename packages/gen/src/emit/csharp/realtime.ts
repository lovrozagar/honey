/**
 * A realtime operation's answer (contract 50 §2, Fd6, Fd7): `Task<ResumableConnection<T>>` through `RealtimeAsync`,
 * `T` the declared event schema's type (`JsonElement` for a string or absent one), opened by awaiting the method over
 * WebSocket, else SSE, else long-poll. Its five fields are `TransportOptions.Of`'s: the resume cursor, the offered
 * subprotocols and the reconnect policy (`TimeSpan? reconnectDelay`). A declared param on a resume channel is folded
 * in, and one named like a field is claimed as `…2` (`sdk-method.ts`).
 */
import { type CsStream, eventType } from "./sdk-answer.ts"
import { isLastEventIdHeader, LAST_EVENT_ID_FIELD } from "./sse.ts"
import { isReconnectToken, PROTOCOLS, RECONNECT_TOKEN } from "./ws.ts"

/** The realtime operation's answer, its five fields and its `<returns>` text. */
export const realtimeStream: CsStream = {
	answer: (op, env) => {
		const type = op.events === undefined ? "JsonElement" : eventType(op.events, op, env)
		return {
			render: (spell) => [`Task<ResumableConnection<${spell.runtime(type)}>>`, "RealtimeAsync"],
			type,
		}
	},
	args: ["TransportOptions.Of(lastEventId, reconnectToken, protocols, maxReconnectAttempts, reconnectDelay)"],
	/* the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID */
	carries: (name, where) =>
		isReconnectToken(name, where) ||
		(where === "query" && name === "last_event_id") ||
		isLastEventIdHeader(name, where),
	fields: [
		LAST_EVENT_ID_FIELD,
		RECONNECT_TOKEN,
		PROTOCOLS,
		{ ident: "maxReconnectAttempts", type: "int?" },
		{ ident: "reconnectDelay", type: "TimeSpan?" },
	],
	returns:
		"The connection over WebSocket, else SSE, else long-poll: it reconnects after a drop and resumes after the last message it delivered; the token, CloseAsync or DisposeAsync ends it.",
}
