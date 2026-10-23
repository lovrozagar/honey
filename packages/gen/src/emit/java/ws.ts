/**
 * A WebSocket operation's method (bit 16 phase d2a, K1/K2/K3; C#'s `ws.ts`): `TypedWebSocket`, dialed by the call
 * through `WsDial.open` (no hook and no log), so a refused handshake throws before the method returns. The entry
 * sits in the gated WebSocket files, as C#'s `SocketAsync` in WsDial.cs: an SDK without a socket references none. Its
 * fields, `protocols` (offered in order) and `reconnectToken` (sent as `reconnect_token` after the declared query, only
 * when set and non-empty); a declared `reconnect_token` query folds into the token, and a param spelled like either
 * field claims `…2`. A socket method is the same text in either mode: it answers no Result.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { docOf, layout } from "./sdk-decl.ts"

/** The query param the token travels in. */
export const RECONNECT_TOKEN = "reconnect_token"

/** The socket's Params fields: the subprotocols offered, then the resume token. */
export const PROTOCOLS = "protocols"
export const TOKEN = "reconnectToken"

/** Whether a declared query param is reconnect_token, the resume channel the token field carries. */
export const isReconnectTokenQuery = (name: string) => name === RECONNECT_TOKEN

/** The WebSocket runtime's files: the socket and its parts; only an SDK with a WebSocket operation ships them. */
export const WS_FILES = ["Keepalive", "Socket", "TypedWebSocket", "WsClose", "WsDial", "WsMessage"]

/** What a socket method's lines need: its name and constant, its Params, and its Call's lines. */
export type WsSite = {
	readonly name: string
	readonly constant: string
	readonly params: string
	readonly call: readonly string[]
}

/** A socket method's lines: `op(params)`, delegating to `op(params, options)`, which dials. */
export function wsMethodLines(op: SdkOp, site: WsSite): string[] {
	const { call, constant, name, params } = site
	const doc = docOf(
		`${op.id}: the open socket. A refused handshake throws; once open, no timeout bounds it. Close it, or open it in try-with-resources.`,
	)
	const signature = (args: readonly string[]) => layout(`public TypedWebSocket ${name}(`, args, ") {", "  ")
	return [
		doc,
		...signature([`${params} params`]),
		`    return ${name}(params, null);`,
		"  }",
		"",
		doc,
		...signature([`${params} params`, "RequestOptions options"]),
		...call,
		...layout("return WsDial.open(", ["exchange", constant, "call", "options", "params.protocols()"], ");", "    "),
		"  }",
		"",
	]
}
