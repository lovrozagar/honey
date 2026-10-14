/**
 * The server side of one realtime connection, and the publisher `realtime()` returns. The session
 * binds the socket to the route's bus and runs the route's callbacks on its own ordered lane:
 * `handler`, then each inbound frame, then `close`, each awaited and contained. The ws route's
 * lane only hands it events, so a slow handler holds this lane, never the socket's.
 */
import type { WSContext } from "../ws/contract.ts"
import {
	CLOSE_INTERNAL,
	CLOSE_NORMAL,
	CLOSE_POLICY,
	CLOSE_TOO_BIG,
	CLOSE_TRY_AGAIN,
	exceedsPayload,
} from "../ws/shared.ts"
import { encodeRealtimeFrame, type RealtimeBus } from "./bus.ts"
import { createEventQueue, invokeUser, type InvokeLogger, reportUserError } from "./invoke-user.ts"
import type { ConnContext, RealtimeConfig } from "./route.ts"

/** What `realtime()` returns: publish into its route's namespace, or another namespace on its bus. */
export type RealtimePublisher = {
	/** Send `data` as one JSON frame to every connection on `topic`. Throws when `data` is not JSON. */
	publish(topic: string, data: unknown): void
	/** The publisher for another namespace on the same bus. */
	namespace(name: string): { publish(topic: string, data: unknown): void }
}

const SEP = "\u0000"

/** The bus key of `topic` in namespace `ns`. Namespaces never see each other's topics. */
export function topicKey(ns: string, topic: string): string {
	return ns + SEP + topic
}

export function createRealtimePublisher(bus: RealtimeBus, namespace: string): RealtimePublisher {
	const forNs = (ns: string) => ({
		publish: (topic: string, data: unknown) => bus.publish(topicKey(ns, String(topic)), data),
	})
	return { namespace: (name) => forNs(String(name)), publish: forNs(namespace).publish }
}

/** One connection's events, as the realtime route's ws callbacks hand them over. */
export type RealtimeSession = {
	/** Attach the open socket and run the route's handler (once). */
	attach(ws: WSContext): void
	close(reason: string): void
	error(error: unknown): void
	message(data: ArrayBuffer | string): void
}

type SessionOptions = {
	config: RealtimeConfig
	ctx: unknown
	log: InvokeLogger | null
	userId: string | null
}

type MessageFn = (payload: unknown) => Promise<void> | void
type CloseFn = (reason: string) => Promise<void> | void

class Session implements RealtimeSession {
	readonly #config: RealtimeConfig
	readonly #ctx: unknown
	readonly #log: InvokeLogger | null
	readonly #id = crypto.randomUUID()
	readonly #fields: Record<string, unknown>
	readonly #lane = createEventQueue()
	readonly #conn: ConnContext
	/* inbound frames in arrival order, including those that beat the open or the message handler */
	readonly #inbox: unknown[] = []
	#onMessage: MessageFn | null = null
	#onClose: CloseFn | null = null
	#socket: WSContext | null = null
	#closed = false
	#closeQueued = false

	constructor(options: SessionOptions) {
		this.#config = options.config
		this.#ctx = options.ctx
		this.#log = options.log
		this.#fields = { connId: this.#id, namespace: options.config.namespace, route: options.config.path }
		this.#conn = this.#connContext(options.userId)
	}

	attach(ws: WSContext): void {
		if (this.#socket !== null || this.#closed) return
		this.#socket = ws
		this.#config.bus.onMessage(this.#id, this.#sendFrame)
		void this.#lane.push(async () => {
			const ok = await this.#invoke("handler", () => this.#config.handler(this.#ctx, this.#conn))
			if (!ok) this.#closeSocket(ws, CLOSE_INTERNAL, "internal error")
		})
		/* frames that beat the open run after the handler, ahead of later ones */
		if (this.#inbox.length > 0) void this.#lane.push(this.#drain)
	}

	close(reason: string): void {
		this.#teardown()
		if (this.#closeQueued) return
		this.#closeQueued = true
		/* after every frame queued before it */
		void this.#lane.push(async () => {
			const fn = this.#onClose
			if (fn !== null) await this.#invoke("close", () => fn(reason || "normal"))
		})
	}

	error(error: unknown): void {
		reportUserError(error, { fields: this.#fields, log: this.#log, phase: "realtime socket error" })
	}

	message(data: ArrayBuffer | string): void {
		/* the wire format is JSON text; binary frames are not part of it */
		if (this.#closed || typeof data !== "string") return
		const { limits } = this.#config
		/* before the open there is no socket to close yet: a frame over a limit is dropped */
		const ws = this.#socket
		if (exceedsPayload(data, limits.maxFrameBytes)) {
			if (ws !== null) this.#closeSocket(ws, CLOSE_TOO_BIG, "frame too large")
			return
		}
		let payload: unknown
		try {
			payload = JSON.parse(data)
		} catch {
			/* not JSON: not a frame of this protocol */
			return
		}
		if (this.#inbox.length >= limits.maxPendingFrames) {
			if (ws !== null) this.#closeSocket(ws, CLOSE_POLICY, "too many pending frames")
			return
		}
		this.#inbox.push(payload)
		if (ws !== null) void this.#lane.push(this.#drain)
	}

	#invoke(phase: string, fn: () => unknown): Promise<boolean> {
		const { onError } = this.#config
		return invokeUser(fn, {
			fields: this.#fields,
			log: this.#log,
			onError: onError ? (error) => onError(error, this.#conn) : null,
			phase: `realtime ${phase}`,
		})
	}

	/** A transport failure is not the route's error: it is logged, never handed to onError. */
	#transport(phase: string, fn: () => void): void {
		try {
			fn()
		} catch (error) {
			reportUserError(error, { fields: this.#fields, log: this.#log, phase: `realtime ${phase}` })
		}
	}

	/** Drop the connection from the bus; runs once, before any close handler. */
	#teardown(): void {
		if (this.#closed) return
		this.#closed = true
		this.#config.bus.unsubscribeAll(this.#id)
		this.#config.bus.removeHandler(this.#id)
	}

	#closeSocket(ws: WSContext, code: number, reason: string): void {
		this.#teardown()
		this.#transport("close", () => ws.close(code, reason))
	}

	/* the bus's sink for this connection */
	readonly #sendFrame = (frame: string): void => {
		const ws = this.#socket
		if (this.#closed || ws === null) return
		const { limits } = this.#config
		if ((ws.bufferedAmount ?? 0) > limits.maxBufferedBytes) {
			if (limits.slowConsumer === "close") this.#closeSocket(ws, CLOSE_TRY_AGAIN, "slow consumer")
			return
		}
		this.#transport("send", () => ws.send(frame))
	}

	/* frames wait until a message handler exists; at the close, waiting frames with none are dropped */
	readonly #drain = async (): Promise<void> => {
		while (this.#inbox.length > 0) {
			const fn = this.#onMessage
			if (fn === null) {
				if (this.#closed) this.#inbox.length = 0
				return
			}
			const payload = this.#inbox.shift()
			await this.#invoke("message", () => fn(payload))
		}
	}

	#on(event: string, fn: unknown): void {
		if (typeof fn !== "function") throw new TypeError("conn.on: handler must be a function")
		if (event === "message") {
			this.#onMessage = fn as MessageFn
			if (this.#inbox.length > 0) void this.#lane.push(this.#drain)
		} else if (event === "close") {
			this.#onClose = fn as CloseFn
		} else {
			throw new TypeError(`conn.on: unknown event "${event}"`)
		}
	}

	#topic(topic: string): string {
		return topicKey(this.#config.namespace, String(topic))
	}

	#join(topic: string): void {
		if (this.#closed) return
		const { bus, limits } = this.#config
		const key = this.#topic(topic)
		if (bus.topicCount(this.#id) >= limits.maxTopics && !bus.isSubscribed(this.#id, key)) {
			throw new RangeError(`realtime: a connection may join at most ${limits.maxTopics} topics`)
		}
		bus.subscribe(this.#id, key)
	}

	#connContext(userId: string | null): ConnContext {
		const { bus } = this.#config
		const conn = {
			close: (reason?: string) => {
				/* a conn exists only once its handler ran, after the socket attached */
				const text = reason === undefined ? "" : String(reason)
				if (!this.#closed) this.#closeSocket(this.#socket as WSContext, CLOSE_NORMAL, text)
			},
			closed: false,
			id: this.#id,
			join: (topic: string) => this.#join(topic),
			leave: (topic: string) => {
				if (!this.#closed) bus.unsubscribe(this.#id, this.#topic(topic))
			},
			on: ((event: string, fn: unknown) => this.#on(event, fn)) as ConnContext["on"],
			/* publishing after close is allowed: a close handler announcing a departure is the common case */
			publish: (topic: string, payload: unknown) => bus.publish(this.#topic(topic), payload),
			send: (payload: unknown) => this.#sendFrame(encodeRealtimeFrame(payload)),
			state: {},
			transport: "ws" as const,
			userId,
		}
		Object.defineProperty(conn, "closed", { enumerable: true, get: () => this.#closed })
		return Object.freeze(conn)
	}
}

/** One realtime connection over the route's bus; the realtime route's ws callbacks feed it. */
export function createRealtimeSession(options: SessionOptions): RealtimeSession {
	return new Session(options)
}
