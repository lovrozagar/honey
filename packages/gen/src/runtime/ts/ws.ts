/**
 * An operation's WebSocket. Its dial runs no onRequest or onResponse hook, and a refused handshake's 401 is its error,
 * with no onAuthExpired refresh. The platform WebSocket exposes no ping and no message cap, so this socket has neither.
 */
export type TypedWebSocket = {
	close(code?: number, reason?: string): void
	off(event: "binary" | "close" | "error" | "message" | "open", handler: (...args: never[]) => void): void
	/** Binary frames, as `ArrayBuffer`. Text frames go to `"message"`. */
	on(event: "binary", handler: (data: ArrayBuffer) => void): void
	on(event: "close", handler: (code: number, reason: string) => void): void
	on(event: "error", handler: (error: unknown) => void): void
	/** Text frames. */
	on(event: "message", handler: (data: string) => void): void
	on(event: "open", handler: () => void): void
	readonly readyState: number
	/**
	 * Strings, `ArrayBuffer`, typed arrays and `Blob` are sent as-is; any other value is JSON-encoded.
	 * Sends before the socket opens are queued; after it closes they are dropped.
	 */
	send(data: ArrayBuffer | ArrayBufferView | Blob | object | string): void
}

export type WSOptions = {
	protocols?: string | string[]
}

type Payload = Blob | string | Uint8Array<ArrayBuffer>
type Handler = (...args: never[]) => void

const WS_EVENTS: readonly string[] = ["binary", "close", "error", "message", "open"]

/** The DOM listener that hands `event` to `handler` in its typed shape. */
function wrapListener(event: string, handler: Handler): EventListener {
	const call = handler as (...args: unknown[]) => void
	if (event === "message") {
		return (e) => {
			const data = (e as MessageEvent).data
			if (typeof data === "string") call(data)
		}
	}
	if (event === "binary") {
		return (e) => {
			const data = (e as MessageEvent).data
			if (data instanceof ArrayBuffer) call(data)
		}
	}
	if (event === "open") return () => call()
	if (event === "close") return (e) => call((e as CloseEvent).code, (e as CloseEvent).reason)
	return (e) => call(e)
}

/** `data` as a frame: text and Blobs as they are, bytes copied, anything else as JSON. */
function toPayload(data: ArrayBuffer | ArrayBufferView | Blob | object | string): Payload {
	if (typeof data === "string") return data
	if (typeof Blob !== "undefined" && data instanceof Blob) return data
	if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
		const view =
			data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		const copy = new Uint8Array(view.byteLength)
		copy.set(view)
		return copy
	}
	return JSON.stringify(data)
}

/** A WebSocket with typed events, a send queue until it opens, and nothing sent once it closes. */
class TypedSocket {
	readonly #ws: WebSocket
	/* user handler → wrapped listener, per event, so one handler can be registered for several events */
	readonly #listeners = new Map<string, WeakMap<Handler, EventListener>>()
	readonly #queue: Payload[] = []
	#state: "closed" | "connecting" | "open" = "connecting"

	constructor(ws: WebSocket) {
		this.#ws = ws
		ws.binaryType = "arraybuffer"
		ws.addEventListener("open", () => {
			this.#state = "open"
			for (const msg of this.#queue) ws.send(msg)
			this.#queue.length = 0
		})
		ws.addEventListener("close", () => {
			this.#state = "closed"
			this.#queue.length = 0
		})
	}

	get readyState(): number {
		return this.#ws.readyState
	}

	close(code?: number, reason?: string): void {
		this.#state = "closed"
		this.#queue.length = 0
		this.#ws.close(code, reason)
	}

	on(event: string, handler: Handler): void {
		if (!WS_EVENTS.includes(event)) return
		const byHandler = this.#listeners.get(event) ?? new WeakMap<Handler, EventListener>()
		this.#listeners.set(event, byHandler)
		const target = event === "binary" ? "message" : event
		const previous = byHandler.get(handler)
		if (previous) this.#ws.removeEventListener(target, previous)
		const wrapped = wrapListener(event, handler)
		byHandler.set(handler, wrapped)
		this.#ws.addEventListener(target, wrapped)
	}

	off(event: string, handler: Handler): void {
		const byHandler = this.#listeners.get(event)
		const wrapped = byHandler?.get(handler)
		if (!wrapped) return
		this.#ws.removeEventListener(event === "binary" ? "message" : event, wrapped)
		byHandler?.delete(handler)
	}

	send(data: ArrayBuffer | ArrayBufferView | Blob | object | string): void {
		if (this.#state === "closed") return
		const payload = toPayload(data)
		if (this.#state === "connecting") this.#queue.push(payload)
		else this.#ws.send(payload)
	}
}

export function createTypedWebSocket(
	url: string,
	opts?: WSOptions,
	WebSocketImpl: typeof WebSocket = WebSocket,
): TypedWebSocket {
	const ws = opts?.protocols ? new WebSocketImpl(url, opts.protocols) : new WebSocketImpl(url)
	const socket = new TypedSocket(ws)
	const typed: TypedWebSocket = {
		close: (code, reason) => socket.close(code, reason),
		off: (event, handler) => socket.off(event, handler),
		on: ((event: string, handler: Handler) => socket.on(event, handler)) as TypedWebSocket["on"],
		get readyState() {
			return socket.readyState
		},
		send: (data) => socket.send(data),
	}
	Object.defineProperty(typed, "_ws", { enumerable: false, value: ws })
	return typed
}
