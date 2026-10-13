/**
 * The server side of one websocket route connection: the user's callbacks run on one ordered
 * queue (open, then messages, then close), each contained, with a cap on waiting messages.
 * Every honey adapter imports this module, which registers it, so the core never bundles it
 * for an app without websockets.
 */
import { registerFeature } from "../feature-slots.ts"
import { createEventQueue, invokeUser, type InvokeLogger } from "../invoke-user.ts"
import { originAllowed } from "../ws-origin.ts"
import type { WSContext, WSHandler } from "./cloudflare.ts"

/** Messages one websocket connection may have waiting for its handler; more close it with 1008. */
const WS_PENDING_MAX = 1024

/** `callbacks` are the route's own; each receives the route's request context `ctx` first. */
export function createWsSession(opts: {
	callbacks: WSHandler<unknown>
	ctx: unknown
	log: InvokeLogger | null
	reconnectToken: string | null
	route: string
}): WSHandler<unknown> {
	const { callbacks, ctx, log, reconnectToken, route } = opts
	const { onClose, onError, onMessage, onOpen, onReconnect } = callbacks
	const queue = createEventQueue()
	let pending = 0

	const run = (phase: string, ws: WSContext, fn: () => unknown): Promise<unknown> =>
		invokeUser(fn, {
			fields: { route },
			log,
			onError: onError ? (err) => onError(ctx, ws, err) : null,
			phase: `websocket ${phase}`,
		})

	return {
		onClose: (_ctx, ws, code, reason) => {
			if (onClose) void queue.push(() => run("close", ws, () => onClose(ctx, ws, code, reason)))
		},
		/* a transport error: tell onError once; if onError throws, that is logged */
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
			if (pending >= WS_PENDING_MAX) {
				ws.close(1008, "too many pending messages")
				return
			}
			pending++
			void queue.push(() =>
				run("message", ws, () => onMessage(ctx, ws, data)).finally(() => {
					pending--
				}),
			)
		},
		onOpen: (_ctx, ws) => {
			if (reconnectToken && onReconnect) {
				void queue.push(() => run("open", ws, () => onReconnect(ctx, ws, reconnectToken)))
			} else if (onOpen) {
				void queue.push(() => run("open", ws, () => onOpen(ctx, ws)))
			}
		},
	}
}

registerFeature("ws", { createWsSession, originAllowed })
