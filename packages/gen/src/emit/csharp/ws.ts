/**
 * A WebSocket operation's answer (contract 50 §2, Fd5): `Task<TypedWebSocket>` through `SocketAsync`, opened by
 * awaiting the method and dialed offering `protocols`, its `reconnectToken` sent as one query param only when set and
 * non-empty; a declared `reconnect_token` query param is folded into that field.
 */
import type { CsStream } from "./sdk-answer.ts"

/** The subprotocols a WebSocket or realtime dial offers. */
export const PROTOCOLS = { ident: "protocols", type: "IReadOnlyList<string>?" }

/** The resume cursor's token, which the WebSocket and realtime methods take. */
export const RECONNECT_TOKEN = { ident: "reconnectToken", type: "string?" }

/** Whether a declared param is the `reconnect_token` query param, the resume channel a socket dial sends. */
export const isReconnectToken = (name: string, where: string) => where === "query" && name === "reconnect_token"

/** The WebSocket operation's answer, its two fields and its `<returns>` text. */
export const wsStream: CsStream = {
	answer: () => ({ render: () => ["Task<TypedWebSocket>", "SocketAsync"], type: null }),
	args: ["protocols", "reconnectToken"],
	carries: isReconnectToken,
	fields: [PROTOCOLS, RECONNECT_TOKEN],
	returns:
		"The open socket: a refused handshake throws its status's exception; the token, CloseAsync or DisposeAsync ends it.",
}
