/**
 * The resumable reference server (H8): the conformance target the SDK reconnect tests run against.
 * Conformance infrastructure, never shipped core: an in-memory event log on honey's two public
 * resume hooks alone, SSE `Last-Event-ID` and the WebSocket `reconnect_token` → `onReconnect`.
 *
 * - `POST /events` appends its JSON body; the answer is the stored event `{ id, data }`.
 * - `GET /events` streams the log as SSE: every event after the client's `Last-Event-ID`, then
 *   live ones; each event's `id` is its log id and its `data` the JSON of the payload.
 * - `WS /events/ws` sends the log as JSON text frames `{ id, data }`: every event, or with
 *   `?reconnect_token=<id>` every event after that id, then live ones.
 *
 * A cursor is client data, never identity: one that is not a log id the server could have issued
 * replays the whole log (not a whole number) or nothing (past the head).
 */
import { honey } from "../../../src/routing/app.ts"
import type { WSContext } from "../../../src/ws/contract.ts"

export type ReferenceEvent = { readonly data: unknown; readonly id: number }

type Listener = (event: ReferenceEvent) => void

const WHOLE = /^(0|[1-9]\d*)$/

/** The log position a client cursor names: `0` (the whole log) unless it is a whole number. */
function positionOf(cursor: string | null | undefined): number {
	return cursor != null && WHOLE.test(cursor) ? Number(cursor) : 0
}

export function createReferenceServer() {
	const events: ReferenceEvent[] = []
	const listeners = new Set<Listener>()
	const sockets = new Map<WSContext, Listener>()

	const append = (data: unknown): ReferenceEvent => {
		const event = Object.freeze({ data, id: events.length + 1 })
		events.push(event)
		for (const listener of listeners) listener(event)
		return event
	}

	/* the backlog and the live subscription start in one turn, so no event falls between them */
	const follow = (position: number, deliver: Listener): (() => void) => {
		for (const event of events.slice(position)) deliver(event)
		listeners.add(deliver)
		return () => listeners.delete(deliver)
	}

	const open = (ws: WSContext, cursor: string | null): void => {
		const deliver: Listener = (event) => ws.send({ data: event.data, id: event.id })
		sockets.set(ws, deliver)
		follow(positionOf(cursor), deliver)
	}

	const app = honey<{}>()
	app.post("/events").handler(async (ctx) => ctx.res.json("ok", append(await ctx.req.json())))
	app.get("/events").handler((ctx) =>
		ctx.res.sse(async (stream) => {
			const stop = follow(positionOf(stream.lastEventId), (event) => {
				void stream.send({ data: JSON.stringify(event.data), event: "message", id: String(event.id) })
			})
			try {
				if (!stream.signal.aborted) {
					await new Promise((resolve) => stream.signal.addEventListener("abort", resolve, { once: true }))
				}
			} finally {
				stop()
			}
		}),
	)
	app.ws("/events/ws").handler({
		onClose: (_ctx, ws) => {
			const deliver = sockets.get(ws)
			sockets.delete(ws)
			if (deliver !== undefined) listeners.delete(deliver)
		},
		onOpen: (_ctx, ws) => open(ws, null),
		onReconnect: (_ctx, ws, token) => open(ws, token),
	})

	return {
		app,
		append,
		events: events as readonly ReferenceEvent[],
		/** Clients following the live log right now. */
		following: () => listeners.size,
	}
}
