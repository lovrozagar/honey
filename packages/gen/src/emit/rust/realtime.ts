/**
 * A realtime operation's answer (contract 20 §2.0, §2.3): `ResumableConnection<E>`, `E` the declared event
 * schema's type (`serde_json::Value` for a string or absent one), opened before the call resolves over
 * WebSocket, else SSE, else long-poll. Its Opts carry the resume cursor, the offered subprotocols and the
 * reconnect policy as the `TransportOpts` of their names; a declared param on a resume channel is folded in.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import type { StreamAnswer, StreamOpts } from "./sdk-opts.ts"
import { eventType, isLastEventIdHeader, LAST_EVENT_ID } from "./sse.ts"
import type { RustTypeContext } from "./types.ts"
import { isReconnectToken, PROTOCOLS, RECONNECT_TOKEN } from "./ws.ts"

/* the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID */
const REALTIME: StreamOpts = {
	carries: (param, where) =>
		isReconnectToken(param, where) ||
		(where === "query" && param === "last_event_id") ||
		isLastEventIdHeader(param, where),
	fields: [
		LAST_EVENT_ID,
		RECONNECT_TOKEN,
		PROTOCOLS,
		{ doc: "Reconnects after a drop; 5 when None.", ident: "max_reconnect_attempts", type: "Option<u32>" },
		{
			doc: "The first backoff delay in milliseconds; 1000 when None.",
			ident: "reconnect_delay_ms",
			type: "Option<u64>",
		},
	],
	sends: [],
}

/* the realtime Opts' own fields, each the TransportOpts field of its name */
const TRANSPORT_OPTS =
	"TransportOpts { last_event_id: opts.last_event_id.clone(), reconnect_token: opts.reconnect_token.clone(), protocols: opts.protocols.clone(), max_reconnect_attempts: opts.max_reconnect_attempts, reconnect_delay_ms: opts.reconnect_delay_ms }"

const DOC =
	"Resolves once the connection is open over WebSocket, else SSE, else long-poll; `recv` reconnects after a drop and resumes after the last message it delivered. `cancel_on` ends it quietly; dropping it closes it."

/** The realtime operation `op`'s answer. */
export function realtimeAnswer(op: SdkOp, at: RustTypeContext): StreamAnswer {
	const events = eventType(op, at, "serde_json::Value")
	const run = `crate::realtime_loop::connect::<${events}>(${TRANSPORT_OPTS})`
	return { doc: DOC, run, stream: REALTIME, type: `ResumableConnection<${events}>` }
}
