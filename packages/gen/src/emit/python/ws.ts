/**
 * A WebSocket operation's answer (contract 34 §2.0, §2.2): `TypedWebSocket`, opened by awaiting the method and
 * dialed offering `protocols`, its `reconnect_token` sent as one query param only when set and non-empty; a
 * declared `reconnect_token` query param is folded into that field (Fd3).
 */
import type { PyStream } from "./sdk-answer.ts"

/** The resume cursor's token, which the WebSocket and realtime methods take. */
export const RECONNECT_TOKEN = "reconnect_token: str | None = None"

/** The subprotocols a WebSocket or realtime dial offers. */
export const PROTOCOLS = "protocols: Sequence[str] | None = None"

/** Whether a declared param is the `reconnect_token` query param, the resume channel a socket dial sends. */
export const isReconnectToken = (name: string, where: string) => where === "query" && name === "reconnect_token"

/** The WebSocket operation's answer, its two fields and its docstring's lines. */
export const wsStream: PyStream = {
	answer: () => ({ returns: "TypedWebSocket", run: "websocket", type: "None" }),
	carries: isReconnectToken,
	doc: [
		'Opens the socket: a refused handshake raises its status\'s error; options["cancel"], close() or',
		"dropping it ends it.",
	],
	fields: [PROTOCOLS, RECONNECT_TOKEN],
}
