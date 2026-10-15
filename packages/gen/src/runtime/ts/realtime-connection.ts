import {
	type ConnectionState,
	type ResumableConnection,
	type ResumableConnectionOpts,
	createKeepaliveLoop,
	type KeepaliveLoop,
	RealtimeAbortError,
	RealtimeConnectError,
	type ServerFrame,
	type Transport,
	type TransportAdapter,
	type TransportConnection,
	transportAt,
} from "./realtime.ts"

type QueueEntry = { type: "done" } | { error: unknown; type: "error" } | { type: "value"; value: unknown }

/** A swallowed callback: a consumer's hook must never break the reconnect loop. */
function safely(fn: (() => void) | undefined): void {
	try {
		fn?.()
	} catch {
		/* the consumer's callback threw; the connection carries on */
	}
}

/**
 * One logical stream over reconnecting transports: messages arrive in order through the async
 * iterator, a drop reconnects (proven transport first, then the chain) and resumes from the last
 * message id with the server's reconnect token.
 */
class Resumable implements ResumableConnection {
	readonly #opts: ResumableConnectionOpts
	readonly #queue: QueueEntry[] = []
	#pending: { reject: (err: unknown) => void; resolve: (result: IteratorResult<unknown>) => void } | null = null
	#state: ConnectionState = "idle"
	#conn: TransportConnection | null = null
	#keepalive: KeepaliveLoop | null = null
	#attempts = 0
	#proven: number | null = null
	#lastId: number | undefined
	#reconnectToken: string | undefined
	#started = false
	#closed = false
	/** the dial and reconnect timers still pending: `close()` clears them, so nothing outlives the connection */
	readonly #timers = new Set<ReturnType<typeof setTimeout>>()
	/** the transport being dialed, closed with the connection */
	#dialing: TransportConnection | null = null

	constructor(opts: ResumableConnectionOpts) {
		this.#opts = opts
		this.#lastId = opts.lastId
		this.#reconnectToken = opts.reconnectToken
		if (opts.signal?.aborted) this.#end()
		else opts.signal?.addEventListener("abort", () => this.#abort(), { once: true })
	}

	get state(): ConnectionState {
		return this.#state
	}

	get provenTransport(): Transport | null {
		return this.#proven === null ? null : transportAt(this.#proven)
	}

	#end(): void {
		this.#state = "closed"
		this.#closed = true
		for (const timer of this.#timers) clearTimeout(timer)
		this.#timers.clear()
		const dialing = this.#dialing
		this.#dialing = null
		dialing?.close()
	}

	/** Run `fn` after `ms`, unless the connection closes first; the timer never holds the process open. */
	#later(fn: () => void, ms: number): () => void {
		const timer = setTimeout(() => {
			this.#timers.delete(timer)
			fn()
		}, ms)
		;(timer as unknown as { unref?: () => void }).unref?.()
		this.#timers.add(timer)
		return () => {
			clearTimeout(timer)
			this.#timers.delete(timer)
		}
	}

	#enqueue(entry: QueueEntry): void {
		const pending = this.#pending
		if (!pending) {
			this.#queue.push(entry)
			return
		}
		this.#pending = null
		if (entry.type === "value") pending.resolve({ done: false, value: entry.value })
		else if (entry.type === "done") pending.resolve({ done: true, value: undefined })
		else pending.reject(entry.error)
	}

	#detach(): void {
		this.#keepalive?.stop()
		this.#keepalive = null
		const conn = this.#conn
		if (!conn) return
		this.#conn = null
		conn.onFrame = () => {}
		conn.onError = () => {}
		conn.onClose = () => {}
		try {
			conn.close()
		} catch {
			/* an adapter's close is best-effort */
		}
	}

	#abort(): void {
		if (this.#state === "closed") return
		this.#end()
		this.#detach()
		this.#enqueue({ error: new RealtimeAbortError("Connection aborted", "aborted"), type: "error" })
	}

	/** A frame on a ready connection: a message, a new reconnect token, a pong or the server's goodbye. */
	#onFrame(frame: ServerFrame): void {
		this.#keepalive?.onFrame()
		if (frame.t === "msg") {
			this.#lastId = frame.id
			this.#enqueue({ type: "value", value: frame.data })
		} else if (frame.t === "ready") this.#reconnectToken = frame.reconnectToken
		else if (frame.t === "pong") this.#keepalive?.onPong()
		else {
			this.#detach()
			this.#reconnect()
		}
	}

	/** Dial the adapter at `index`; resolve once it is ready, its frames wired before the caller resumes. */
	#dial(index: number): Promise<TransportConnection> {
		return new Promise((resolve, reject) => {
			if (this.#closed) return reject(new RealtimeConnectError("the connection is closed", "closed"))
			const adapter = this.#opts.transports[index] as TransportAdapter
			const opts = { headers: this.#opts.headers, lastId: this.#lastId, reconnectToken: this.#reconnectToken }
			const conn = adapter.connect(this.#opts.url, { ...opts, signal: this.#opts.signal })
			this.#dialing = conn
			let ready = false
			const cancel = this.#later(() => {
				this.#dialing = null
				conn.close()
				reject(new RealtimeConnectError("transport open timeout", "timeout"))
			}, this.#opts.fallbackTimeout ?? 3000)
			const fail = (error: unknown) => {
				cancel()
				if (this.#dialing === conn) this.#dialing = null
				if (ready) {
					this.#detach()
					this.#reconnect()
				} else reject(error)
			}
			conn.onFrame = (frame) => {
				/* a message before ready is kept; a goodbye before ready is the server refusing the open */
				if (ready || frame.t === "msg" || frame.t === "pong") return this.#onFrame(frame)
				if (frame.t === "bye") {
					conn.close()
					return fail(new RealtimeConnectError(`transport refused: ${frame.reason}`, "bye"))
				}
				ready = true
				cancel()
				this.#dialing = null
				/* the connection from its ready frame on, so a drop before the caller resumes is seen */
				this.#conn = conn
				this.#reconnectToken = frame.reconnectToken
				resolve(conn)
			}
			conn.onError = (err) => {
				if (!ready) conn.close()
				fail(err)
			}
			conn.onClose = (reason) =>
				fail(new RealtimeConnectError(`transport closed before ready: ${reason}`, "closed_early"))
		})
	}

	/** The proven transport first, then each in order; the first ready one becomes the connection. */
	async #open(): Promise<TransportConnection> {
		const { transports } = this.#opts
		if (transports.length === 0) throw new RealtimeConnectError("No transports configured", "no_transports")
		if (this.#proven !== null) {
			try {
				return await this.#dial(this.#proven)
			} catch {
				/* the proven transport failed: fall through to the whole chain */
			}
		}
		let lastError: unknown = new RealtimeConnectError("All transports failed", "all_failed")
		for (let i = 0; i < transports.length; i++) {
			try {
				const conn = await this.#dial(i)
				this.#proven = i
				return conn
			} catch (err) {
				lastError = err
			}
		}
		throw lastError
	}

	#watch(conn: TransportConnection): void {
		const interval = this.#opts.keepaliveInterval
		if (interval === undefined || this.#proven === null) return
		const onDead = () => {
			this.#detach()
			this.#reconnect()
		}
		const sendPing = () => conn.send(JSON.stringify({ t: "ping" }))
		this.#keepalive = createKeepaliveLoop({ interval, onDead, sendPing, transport: transportAt(this.#proven) })
		this.#keepalive.start()
	}

	async #connect(): Promise<void> {
		if (this.#closed) return
		if (this.#state === "idle") this.#state = "connecting"
		try {
			const conn = await this.#open()
			/* closed, or dropped between its ready frame and here (a reconnect is already scheduled) */
			if (this.#closed || this.#conn !== conn) return
			this.#state = "connected"
			this.#attempts = 0
			this.#watch(conn)
			safely(this.#opts.onReconnected)
		} catch {
			this.#reconnect()
		}
	}

	/** After a drop or a failed open: wait, then dial again; past the attempt cap the stream ends. */
	#reconnect(): void {
		if (this.#closed) return
		this.#attempts += 1
		const max = this.#opts.maxReconnectAttempts ?? 5
		if (max > 0 && this.#attempts > max) {
			this.#end()
			this.#enqueue({ type: "done" })
			return
		}
		this.#state = "reconnecting"
		/* a drop means that transport is not healthy: the next attempt walks the whole chain */
		this.#proven = null
		const attempt = this.#attempts
		safely(() => this.#opts.onReconnecting?.(attempt, transportAt(0)))
		this.#later(() => void this.#connect(), this.#opts.reconnectDelayMs ?? 1000)
	}

	send(data: unknown): void {
		if (!this.#closed) this.#conn?.send(JSON.stringify(data))
	}

	close(_reason?: string): void {
		if (this.#state === "closed") return
		this.#end()
		this.#detach()
		this.#enqueue({ type: "done" })
	}

	#next(): Promise<IteratorResult<unknown>> {
		if (!this.#started && !this.#closed) {
			this.#started = true
			this.#state = "connecting"
			void this.#connect()
		}
		const entry = this.#queue.shift()
		if (entry?.type === "value") return Promise.resolve({ done: false, value: entry.value })
		if (entry?.type === "error") return Promise.reject(entry.error)
		if (entry || this.#closed) return Promise.resolve({ done: true, value: undefined })
		const next = new Promise<IteratorResult<unknown>>((resolve, reject) => {
			this.#pending = { reject, resolve }
		})
		next.catch(() => {})
		return next
	}

	[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
		const iterator: AsyncIterableIterator<unknown> = {
			next: () => this.#next(),
			[Symbol.asyncIterator]: () => iterator,
		}
		return iterator
	}
}

export function createResumableConnection(opts: ResumableConnectionOpts): ResumableConnection {
	return new Resumable(opts)
}
