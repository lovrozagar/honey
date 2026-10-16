/**
 * A WebSocket operation's answer (contract 20 §2.0, §2.2): `TypedWebSocket`, dialed offering the Opts'
 * `protocols`, its Opts' `reconnect_token` sent as one query param only when set and non-empty; a declared
 * `reconnect_token` query param is folded into that field (Fd3).
 */
import type { OptsField, StreamAnswer, StreamOpts } from "./sdk-opts.ts"

/** The resume cursor's token, which the WebSocket and realtime Opts carry. */
export const RECONNECT_TOKEN = { ident: "reconnect_token", type: "Option<String>" }

/** The subprotocols a WebSocket or realtime dial offers. */
export const PROTOCOLS = { doc: "The subprotocols the dial offers.", ident: "protocols", type: "Vec<String>" }

/** Whether a declared param is the `reconnect_token` query param, the resume channel a socket dial sends. */
export const isReconnectToken = (param: string, where: OptsField["in"]) =>
	where === "query" && param === "reconnect_token"

/* reconnect_token, sent only when set: an empty cursor names no position */
const WS: StreamOpts = {
	carries: isReconnectToken,
	fields: [RECONNECT_TOKEN, PROTOCOLS],
	sends: ['spec.query("reconnect_token", &crate::request::cursor(&opts.reconnect_token));'],
}

const DOC =
	"Resolves once the socket is open: a refused handshake with an error status is `Err(Error::Api)`. `cancel_on` ends its reads quietly; dropping it closes it."

/** A WebSocket operation's answer. */
export const wsAnswer = (): StreamAnswer => ({
	doc: DOC,
	run: "crate::ws::dial(opts.protocols.clone())",
	stream: WS,
	type: "TypedWebSocket",
})
