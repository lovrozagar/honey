import { invokeUser } from "../invoke-user.ts"
import type { WSContext, WSHandler } from "../ws/cloudflare.ts"
import { encodeRealtimeFrame } from "./bus.ts"
import type { RealtimeBus } from "./bus.ts"
import {
	bufferedAmountOf,
	CLOSE_INTERNAL,
	CLOSE_NORMAL,
	CLOSE_POLICY,
	CLOSE_TOO_BIG,
	CLOSE_TRY_AGAIN,
	exceedsPayload,
	MAX_CLOSE_REASON,
} from "../ws/shared.ts"
import { truncateUtf8 } from "./route.ts"
import type { ConnContext, RealtimeConfig } from "./route.ts"

type Logger = {
	error?: (obj: Record<string, unknown>, msg?: string) => void
	warn?: (obj: Record<string, unknown>, msg?: string) => void
}

/** `ctx.realtime` — publish into a realtime namespace from any request. */
export type RealtimePublisher = {
	/**
	 * Publish to `topic` in the app's only realtime namespace. Throws when the app has several
	 * namespaces; use `namespace(name).publish()` then.
	 */
	publish(topic: string, data: unknown): void
	/** The publisher for one namespace (a route's `namespace` option, or its full path pattern). */
	namespace(name: string): { publish(topic: string, data: unknown): void }
}

const SEP = "\u0000"

/** The bus key of `topic` in namespace `ns`. Namespaces never see each other's topics. */
export function topicKey(ns: string, topic: string): string {
	return ns + SEP + topic
}

export function createRealtimePublisher(bus: RealtimeBus, namespaces: () => Iterable<string>): RealtimePublisher {
	const forNs = (ns: string) => ({
		publish(topic: string, data: unknown) {
			bus.publish(topicKey(ns, String(topic)), data)
		},
	})
	return {
		namespace(name: string) {
			return forNs(String(name))
		},
		publish(topic: string, data: unknown) {
			const all = new Set(namespaces())
			if (all.size !== 1) {
				throw new Error(
					all.size === 0
						? "ctx.realtime.publish: the app has no realtime routes"
						: `ctx.realtime.publish: the app has ${all.size} realtime namespaces (${[...all].join(", ")}); use ctx.realtime.namespace(name).publish(topic, data)`,
				)
			}
			forNs(all.values().next().value as string).publish(topic, data)
		},
	}
}

export type RealtimeSession = {
	/** The handler to pass to the runtime's WebSocket adapter. */
	handler: WSHandler<unknown>
	/** Attach the socket and start the connection (idempotent). Adapters that return an open socket from `upgrade()` call this right away; others get it from `onOpen`. */
	attach(ws: WSContext<unknown>): void
}

/**
 * One realtime connection: binds the socket to the bus and runs the route's callbacks on one ordered
 * queue — `handler`, then each inbound frame, then `close` — each awaited. Every callback is
 * contained: a throw or rejection goes to the route's `onError` (or the app logger) and never escapes
 * into the runtime, so it can neither crash the process nor poison the queue.
 */
export function createRealtimeSession(opts: {
	bus: RealtimeBus
	config: RealtimeConfig
	ctx: unknown
	log: Logger | undefined
	userId: string | null
}): RealtimeSession {
	const { bus, config, ctx, log, userId } = opts
	const { limits, namespace } = config
	const connId = crypto.randomUUID()
	const state: Record<string, unknown> = {}

	let socket: WSContext<unknown> | null = null
	let closed = false
	let tornDown = false
	let closeRan = false
	let onMessageFn: ((payload: unknown) => void | Promise<void>) | null = null
	let onCloseFn: ((reason: string) => void | Promise<void>) | null = null

	/* ordered queue: open → messages → close. Every inbound frame waits in `inbox` in arrival
	 * order, including frames that beat the open or the `message` handler; a drain task delivers
	 * them, so a frame never overtakes one that arrived before it. */
	let queue: Promise<void> = Promise.resolve()
	const inbox: unknown[] = []

	/* the same containment as WebSocket callbacks: onError gets the error, an onError that
	 * throws is logged and never invoked again for its own error, nothing reaches the runtime */
	const invoke = (phase: string, fn: () => void | Promise<void>): Promise<boolean> =>
		invokeUser(fn, {
			fields: { connId, namespace, route: config.path },
			log,
			onError: config.onError ? (err) => config.onError?.(err, conn) : null,
			phase,
		})

	const enqueue = (task: () => Promise<unknown>) => {
		queue = queue.then(task).then(
			() => undefined,
			() => undefined,
		)
	}

	/** Drop the connection from the bus. Runs exactly once, before any user close handler. */
	const teardown = () => {
		if (tornDown) return
		tornDown = true
		closed = true
		bus.unsubscribeAll(connId)
		bus.removeHandler(connId)
	}

	const closeSocket = (code: number, reason: string) => {
		const ws = socket
		teardown()
		if (ws === null) return
		try {
			ws.close(code, truncateUtf8(reason, MAX_CLOSE_REASON))
		} catch (e) {
			log?.warn?.({ connId, err: e }, "realtime close failed")
		}
	}

	const sendFrame = (frame: string) => {
		const ws = socket
		if (closed || ws === null) return
		if (bufferedAmountOf(ws.raw) > limits.maxBufferedBytes) {
			if (limits.slowConsumer === "drop") return
			closeSocket(CLOSE_TRY_AGAIN, "slow consumer")
			return
		}
		try {
			ws.send(frame)
		} catch (e) {
			/* the socket went away between the readyState check and the write */
			log?.warn?.({ connId, err: e }, "realtime send failed")
		}
	}

	/* frames that arrived before the close still run; the close handler is queued after them.
	 * Without a handler the frames stay in the inbox until one is attached, or are dropped on close. */
	const drain = async (): Promise<void> => {
		while (inbox.length > 0) {
			const fn = onMessageFn
			if (fn === null) {
				if (closed) inbox.length = 0
				return
			}
			const payload = inbox.shift()
			await invoke("message", () => fn(payload))
		}
	}

	const accept = (payload: unknown) => {
		if (inbox.length >= limits.maxPendingFrames) {
			closeSocket(CLOSE_POLICY, "too many pending frames")
			return
		}
		inbox.push(payload)
		enqueue(drain)
	}

	const conn = Object.create(null) as ConnContext
	Object.defineProperties(conn, {
		close: {
			enumerable: true,
			value(reason?: string) {
				if (closed) return
				closeSocket(CLOSE_NORMAL, reason === undefined ? "" : String(reason))
			},
		},
		closed: { enumerable: true, get: () => closed },
		id: { enumerable: true, value: connId },
		join: {
			enumerable: true,
			value(topic: string) {
				if (closed) return
				const key = topicKey(namespace, String(topic))
				if (bus.topicCount(connId) >= limits.maxTopics && !bus.isSubscribed(connId, key)) {
					throw new RangeError(`realtime: a connection may join at most ${limits.maxTopics} topics`)
				}
				bus.subscribe(connId, key)
			},
		},
		leave: {
			enumerable: true,
			value(topic: string) {
				if (closed) return
				bus.unsubscribe(connId, topicKey(namespace, String(topic)))
			},
		},
		on: {
			enumerable: true,
			value(event: "message" | "close", fn: (arg: never) => void | Promise<void>) {
				if (typeof fn !== "function") throw new TypeError("conn.on: handler must be a function")
				if (event === "message") {
					onMessageFn = fn as (payload: unknown) => void | Promise<void>
					/* frames that waited for a handler run next, in arrival order */
					if (inbox.length > 0) enqueue(drain)
				} else if (event === "close") {
					onCloseFn = fn as (reason: string) => void | Promise<void>
				} else {
					throw new TypeError(`conn.on: unknown event "${String(event)}"`)
				}
			},
		},
		/* publishing after close is allowed: a close handler announcing a departure is the common case */
		publish: {
			enumerable: true,
			value(topic: string, payload: unknown) {
				bus.publish(topicKey(namespace, String(topic)), payload)
			},
		},
		send: {
			enumerable: true,
			value(payload: unknown) {
				const frame = encodeRealtimeFrame(payload)
				sendFrame(frame)
			},
		},
		state: { enumerable: true, get: () => state },
		transport: { enumerable: true, value: "ws" },
		userId: { enumerable: true, value: userId },
	})

	const attach = (ws: WSContext<unknown>) => {
		if (socket !== null || tornDown) return
		socket = ws
		bus.onMessage(connId, sendFrame)
		enqueue(async () => {
			const ok = await invoke("handler", () => config.handler(ctx, conn))
			if (!ok) closeSocket(CLOSE_INTERNAL, "internal error")
		})
	}

	const onSocketClose = (reason: string) => {
		teardown()
		if (closeRan) return
		closeRan = true
		enqueue(() => {
			const fn = onCloseFn
			return fn === null ? Promise.resolve() : invoke("close", () => fn(reason))
		})
	}

	const handler: WSHandler<unknown> = {
		onClose: (_ctx, _ws, _code, reason) => {
			onSocketClose(reason || "normal")
		},
		onError: (_ctx, _ws, error) => {
			log?.warn?.({ connId, err: error }, "realtime socket error")
		},
		onMessage: (_ctx, _ws, data) => {
			if (closed) return
			/* the wire format is JSON text; binary frames are not part of it */
			if (typeof data !== "string") return
			if (exceedsPayload(data, limits.maxFrameBytes)) {
				closeSocket(CLOSE_TOO_BIG, "frame too large")
				return
			}
			let payload: unknown
			try {
				payload = JSON.parse(data)
			} catch {
				/* not JSON: not a frame of this protocol */
				return
			}
			if (socket === null) {
				/* a frame before open (runtime quirk): it waits in the inbox, ahead of later frames */
				if (inbox.length >= limits.maxPendingFrames) return
				inbox.push(payload)
				return
			}
			accept(payload)
		},
		onOpen: (_ctx, ws) => {
			attach(ws)
		},
	}

	return { attach, handler }
}
