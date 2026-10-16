/**
 * A WebSocket or realtime operation as a Go method. A WebSocket operation dials its socket and
 * returns `(*TypedWebSocket, error)`: `<Op>Opts.ReconnectToken` rides as the `reconnect_token`
 * query param after the declared ones, and `Protocols` are the subprotocols it offers. A realtime
 * operation returns `(*ResumableConnection, error)`, already open over the WebSocket, SSE and
 * long-poll chain, its ctx bounding the open (Fd1); its Opts carry the resume cursor, the protocols
 * and the reconnect policy. A declared param on a resume channel the runtime sends itself is carried
 * by those fields, so the wire holds one pair (Fd3). Neither declares a response a caller receives.
 */
import { type GoStream, sendArgs } from "./sdk-answer.ts"
import type { OptsField, StreamField } from "./sdk-opts.ts"
import { isLastEventIdHeader } from "./sse.ts"

/** Whether a declared param is the `reconnect_token` query param a WebSocket dial sends. */
const isReconnectToken = (param: string, where: OptsField["in"]) => where === "query" && param === "reconnect_token"

/* both open a socket: a dial fails before any stream exists */
const FAIL = "nil, err"

const WS_STREAM: GoStream = {
	doc: "",
	opts: {
		before: [],
		carries: isReconnectToken,
		fields: [
			{ name: "ReconnectToken", type: "string" },
			{ name: "Protocols", type: "[]string" },
		],
		sets: [
			'if opts.ReconnectToken != "" {',
			'\tc.query.set("reconnect_token", opts.ReconnectToken)',
			"}",
			"c.protocols = opts.Protocols",
		],
	},
	shape: {
		fail: FAIL,
		returns: "(*TypedWebSocket, error)",
		tail: (client) => [`\treturn dialWebSocket(${sendArgs(client)})`],
	},
}

/* the realtime Opts' own fields: each is the TransportOpts field of its name, which `sets` copies */
const REALTIME_FIELDS: readonly StreamField[] = [
	{ name: "LastEventID", type: "string" },
	{ name: "ReconnectToken", type: "string" },
	{ name: "Protocols", type: "[]string" },
	{
		doc: "MaxReconnectAttempts caps reconnects after a drop. Zero means 5; negative means unlimited.",
		name: "MaxReconnectAttempts",
		type: "int",
	},
	{ doc: "ReconnectDelayMs is the first backoff delay. Zero means 1000.", name: "ReconnectDelayMs", type: "int" },
]

const REALTIME_STREAM: GoStream = {
	doc: "The connection is open on return; Close it when done.",
	opts: {
		before: ["var topts TransportOpts"],
		/* the WebSocket and long-poll dials send the cursor as query params, the SSE dial its id as Last-Event-ID */
		carries: (param, where) =>
			isReconnectToken(param, where) ||
			(where === "query" && param === "last_event_id") ||
			isLastEventIdHeader(param, where),
		fields: REALTIME_FIELDS,
		sets: [
			"topts = TransportOpts{LastEventID: opts.LastEventID, ReconnectToken: opts.ReconnectToken, Protocols: opts.Protocols, MaxReconnectAttempts: opts.MaxReconnectAttempts, ReconnectDelayMs: opts.ReconnectDelayMs}",
		],
	},
	shape: {
		fail: FAIL,
		returns: "(*ResumableConnection, error)",
		tail: (client) => [`\treturn newRealtime(${sendArgs(client, "topts")})`],
	},
}

/** The method of a WebSocket or realtime operation. */
export const socketStream = (stream: "realtime" | "ws"): GoStream => (stream === "ws" ? WS_STREAM : REALTIME_STREAM)
