/**
 * The server side of one ws route connection: the route's callbacks run on one ordered lane (open,
 * then messages, then close), each contained, with a cap on messages waiting for the handler.
 * A plain module: importing it registers nothing (H23).
 */
import { createEventQueue, invokeUser, type InvokeLogger } from "../realtime/invoke-user.ts"
import type { WSContext, WSHandler } from "./contract.ts"
import { CLOSE_POLICY } from "./shared.ts"

/** Messages one connection may have waiting for its handler; more close it with 1008. */
export const WS_PENDING_MAX = 1024

export type WsSessionOptions = {
	/** The route's own callbacks; each receives the route's request context first. */
	callbacks: WSHandler<unknown>
	ctx: unknown
	log: InvokeLogger | null
	/** The client's `reconnect_token`: `onReconnect` runs in place of `onOpen` when both exist. */
	reconnectToken: string | null
	route: string
}

/** The adapter-facing handler for one connection. */
export function createWsSession(options: WsSessionOptions): WSHandler<unknown> {
	const { callbacks, ctx, log, reconnectToken, route } = options
	const { onClose, onError, onMessage, onOpen, onReconnect } = callbacks
	const queue = createEventQueue()
	let pending = 0

	const run = (phase: string, ws: WSContext, fn: () => unknown): Promise<boolean> =>
		invokeUser(fn, {
			fields: { route },
			log,
			onError: onError ? (error) => onError(ctx, ws, error) : null,
			phase: `websocket ${phase}`,
		})

	return {
		onClose: (_ctx, ws, code, reason) => {
			if (onClose) void queue.push(() => run("close", ws, () => onClose(ctx, ws, code, reason)))
		},
		/* a transport error: onError hears it once; without one, it is logged */
		onError: (_ctx, ws, error) => {
			void queue.push(() =>
				invokeUser(() => (onError ? onError(ctx, ws, error) : Promise.reject(error)), {
					fields: { route },
					log,
					phase: "websocket error",
				}),
			)
		},
		onMessage: (_ctx, ws, data) => {
			if (!onMessage) return
			if (pending >= WS_PENDING_MAX) return ws.close(CLOSE_POLICY, "too many pending messages")
			pending++
			void queue.push(() =>
				run("message", ws, () => onMessage(ctx, ws, data)).finally(() => {
					pending--
				}),
			)
		},
		onOpen: (_ctx, ws) => {
			/* an empty token is no token */
			if (reconnectToken && onReconnect) {
				void queue.push(() => run("open", ws, () => onReconnect(ctx, ws, reconnectToken)))
			} else if (onOpen) {
				void queue.push(() => run("open", ws, () => onOpen(ctx, ws)))
			}
		},
	}
}
