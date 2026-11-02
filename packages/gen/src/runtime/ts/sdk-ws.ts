import { interpolatePath } from "./path.ts"
import type { RequestOptions } from "./request.ts"
import { type OperationCall, templateOf } from "./sdk.ts"
import { createTypedWebSocket, type TypedWebSocket, wsUrl } from "./ws.ts"

/** A WebSocket call's input: the request's options, the subprotocols, and a resume token. */
type WsInput = RequestOptions & { protocols?: string | string[]; reconnectToken?: string }

/** A WebSocket op: one socket per call, its `x-invalidate` targets marked once it opens. */
export const wsOp: OperationCall =
	(core, entry) =>
	(input: WsInput = {}): TypedWebSocket => {
		const url = new URL(wsUrl(core.http, templateOf(entry), { params: input.params, search: input.search }))
		if (input.reconnectToken) url.searchParams.append("reconnect_token", input.reconnectToken)
		const socket = createTypedWebSocket(url.toString(), { protocols: input.protocols })
		if (entry.invalidate?.length) {
			const selector = `WS ${interpolatePath(templateOf(entry), input.params)}`
			socket.on("open", () => core.mark(entry, input.params, selector))
		}
		return socket
	}
