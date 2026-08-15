import { createBus } from "../realtime/bus.ts"
import { ReconnectBuffer } from "../realtime/buffer.ts"
import { decodeClientFrame, encodeServerFrame } from "../realtime/protocol.ts"
import type { ServerFrame } from "../realtime/protocol.ts"
import { createConnContext } from "../realtime/route.ts"
import type { ConnContext } from "../realtime/route.ts"

export type DurableObjectContext = {
	id: { toString(): string }
	storage: {
		getAlarm(): Promise<number | null>
		setAlarm(time: number): Promise<void>
		deleteAlarm(): Promise<void>
	}
	acceptWebSocket(ws: WebSocket): void
	getWebSockets(): WebSocket[]
	getTags(ws: WebSocket): string[]
}

export type RealtimeHandlerConfig<TEnv = unknown> = {
	ctx: DurableObjectContext
	env: TEnv
	onAuth?: (req: Request) => string | null | Promise<string | null>
	reconnectBuffer?: number
	routes?: Record<string, (c: unknown, conn: ConnContext) => void | Promise<void>>
}

export type RealtimeHandlers = {
	fetch(req: Request): Promise<Response>
	message(ws: WebSocket, msg: ArrayBuffer | string): void | Promise<void>
	close(ws: WebSocket, code: number, reason: string, wasClean: boolean): void | Promise<void>
	error(ws: WebSocket, err: unknown): void | Promise<void>
	alarm(): void | Promise<void>
}

type Attachment = {
	connId: string
	reconnectToken: string
	userId: string | null
}

const DEFAULT_BUFFER_SIZE = 100
const BUFFER_TTL_MS = 30_000

export function createRealtimeHandlers<TEnv = unknown>(
	config: RealtimeHandlerConfig<TEnv>,
): RealtimeHandlers {
	const bufferSize = config.reconnectBuffer ?? DEFAULT_BUFFER_SIZE
	const buffer = new ReconnectBuffer({ size: bufferSize })
	const bus = createBus()

	/* Track registered tokens so we can lazily register on hibernation wake */
	const knownTokens = new Set<string>()

	function ensureToken(token: string): void {
		if (knownTokens.has(token)) return
		/* Token was created before hibernation — re-register with buffer */
		buffer.create(token)
		knownTokens.add(token)
	}

	function getAttachment(ws: WebSocket): Attachment | null {
		const raw = (ws as unknown as { deserializeAttachment(): string | null }).deserializeAttachment()
		if (!raw) return null
		try {
			return JSON.parse(raw) as Attachment
		} catch {
			return null
		}
	}

	function sendFrame(ws: WebSocket, frame: ServerFrame): void {
		(ws as unknown as { send(data: string): void }).send(encodeServerFrame(frame))
	}

	function getRouteHandler(): ((c: unknown, conn: ConnContext) => void | Promise<void>) | null {
		if (!config.routes) return null
		if (config.routes["/"]) return config.routes["/"]
		const keys = Object.keys(config.routes)
		if (keys.length > 0) return config.routes[keys[0]]
		return null
	}

	function buildConnContext(attachment: Attachment, ws: WebSocket): ConnContext {
		return createConnContext({
			bus,
			closeFn: (reason) => {
				(ws as unknown as { close(code?: number, reason?: string): void }).close(1000, reason ?? "")
			},
			id: attachment.connId,
			sendFn: (payload) => {
				ensureToken(attachment.reconnectToken)
				const id = buffer.push(attachment.reconnectToken, payload)
				sendFrame(ws, { data: payload, id, t: "msg" })
			},
			transport: "ws",
			userId: attachment.userId,
		})
	}

	async function handleFetch(req: Request): Promise<Response> {
		const upgradeHeader = req.headers.get("upgrade")
		if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
			return new Response("Upgrade Required", { status: 426 })
		}

		let userId: string | null = null
		if (config.onAuth) {
			userId = await config.onAuth(req)
		}

		const pair = new (globalThis as unknown as { WebSocketPair: new () => { 0: WebSocket; 1: WebSocket } }).WebSocketPair()
		const client = pair[0]
		const server = pair[1]

		config.ctx.acceptWebSocket(server)

		const connId = crypto.randomUUID()
		const reconnectToken = buffer.create()
		knownTokens.add(reconnectToken)

		const attachment: Attachment = { connId, reconnectToken, userId }
		;(server as unknown as { serializeAttachment(data: string): void }).serializeAttachment(
			JSON.stringify(attachment),
		)

		sendFrame(server, { reconnectToken, t: "ready" })

		/*
		 * CF Workers returns a special Response with status 101 and the webSocket property.
		 * Standard Response rejects 101, so we construct the object manually.
		 */
		const response = new Response(null, { status: 200 })
		Object.defineProperty(response, "status", { value: 101 })
		Object.defineProperty(response, "webSocket", { value: client })
		return response
	}

	async function handleMessage(ws: WebSocket, msg: ArrayBuffer | string): Promise<void> {
		if (typeof msg !== "string") return

		const attachment = getAttachment(ws)
		if (!attachment) return

		if (!msg) return

		const frame = decodeClientFrame(msg)
		if (!frame) return

		if (frame.t === "ping") {
			sendFrame(ws, { t: "pong" })
			return
		}

		if (frame.t === "msg") {
			/* Ensure token is registered (survives hibernation wake) */
			ensureToken(attachment.reconnectToken)
			buffer.push(attachment.reconnectToken, frame.data)

			const routeHandler = getRouteHandler()
			if (routeHandler) {
				const conn = buildConnContext(attachment, ws)
				await routeHandler(config.env, conn)
				if (conn._handlers.message) {
					conn._handlers.message(frame.data)
				}
			}
			return
		}

		if (frame.t === "resume") {
			/* Ensure the connection's own token is known */
			ensureToken(attachment.reconnectToken)

			const replayed = buffer.replay(frame.reconnectToken, frame.lastId)
			if (!replayed) {
				sendFrame(ws, { reason: "server_restart", t: "bye" })
				return
			}

			for (const entry of replayed) {
				sendFrame(ws, { data: entry.data, id: entry.id, t: "msg" })
			}
			sendFrame(ws, { reconnectToken: attachment.reconnectToken, t: "ready" })
			return
		}
	}

	async function handleClose(ws: WebSocket, _code: number, reason: string, _wasClean: boolean): Promise<void> {
		const attachment = getAttachment(ws)
		if (!attachment) return

		/* Run route handler to get close callback */
		const routeHandler = getRouteHandler()
		if (routeHandler) {
			const conn = buildConnContext(attachment, ws)
			await routeHandler(config.env, conn)
			if (conn._handlers.close) {
				conn._handlers.close(reason)
			}
		}

		bus.unsubscribeAll(attachment.connId)
		bus.removeHandler(attachment.connId)

		ensureToken(attachment.reconnectToken)
		buffer.disconnect(attachment.reconnectToken)

		/* Schedule alarm to clean up expired buffers */
		const existingAlarm = await config.ctx.storage.getAlarm()
		if (!existingAlarm) {
			await config.ctx.storage.setAlarm(Date.now() + BUFFER_TTL_MS)
		}
	}

	function handleError(ws: WebSocket, _err: unknown): Promise<void> {
		try {
			(ws as unknown as { close(code?: number, reason?: string): void }).close(1011, "internal error")
		} catch {
			/* swallow — ws may already be closed */
		}
		return Promise.resolve()
	}

	async function handleAlarm(): Promise<void> {
		await config.ctx.storage.deleteAlarm()
	}

	return {
		alarm: handleAlarm,
		close: handleClose,
		error: handleError,
		fetch: handleFetch,
		message: handleMessage,
	}
}
