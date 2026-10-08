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
	 * Strings, `ArrayBuffer`, typed arrays and `Blob` are sent as-is; any other value is
	 * JSON-encoded. Sends before the socket opens are queued; after it closes they are dropped.
	 */
	send(data: ArrayBuffer | ArrayBufferView | Blob | object | string): void
}

export type WSOptions = {
	protocols?: string | string[]
}

type Payload = Blob | string | Uint8Array<ArrayBuffer>

const EVENTS = new Set(["binary", "close", "error", "message", "open"])

export function createTypedWebSocket(
	url: string,
	opts?: WSOptions,
	WebSocketImpl: typeof WebSocket = WebSocket,
): TypedWebSocket {
	const ws = opts?.protocols ? new WebSocketImpl(url, opts.protocols) : new WebSocketImpl(url)
	ws.binaryType = "arraybuffer"

	/* user handler → wrapped listener, per event, so one handler can be registered for several events */
	const listeners = new Map<string, WeakMap<(...args: never[]) => void, EventListener>>()
	/* queue sends until OPEN; stop queueing for good once the socket closes or fails */
	const sendBuffer: Payload[] = []
	let state: "closed" | "connecting" | "open" = "connecting"

	ws.addEventListener("open", () => {
		state = "open"
		for (const msg of sendBuffer) {
			ws.send(msg)
		}
		sendBuffer.length = 0
	})
	ws.addEventListener("close", () => {
		state = "closed"
		sendBuffer.length = 0
	})

	function close(code?: number, reason?: string) {
		state = "closed"
		sendBuffer.length = 0
		ws.close(code, reason)
	}

	function on(event: "binary", handler: (data: ArrayBuffer) => void): void
	function on(event: "close", handler: (code: number, reason: string) => void): void
	function on(event: "error", handler: (error: unknown) => void): void
	function on(event: "message", handler: (data: string) => void): void
	function on(event: "open", handler: () => void): void
	function on(event: string, handler: (...args: never[]) => void): void {
		if (!EVENTS.has(event)) return
		let wrapped: EventListener
		switch (event) {
			case "message":
				wrapped = (e: Event) => {
					const data = (e as MessageEvent).data
					if (typeof data === "string") (handler as (data: string) => void)(data)
				}
				break
			case "binary":
				wrapped = (e: Event) => {
					const data = (e as MessageEvent).data
					if (data instanceof ArrayBuffer) (handler as (data: ArrayBuffer) => void)(data)
				}
				break
			case "open":
				wrapped = () => (handler as () => void)()
				break
			case "close":
				wrapped = (e: Event) =>
					(handler as (code: number, reason: string) => void)((e as CloseEvent).code, (e as CloseEvent).reason)
				break
			default:
				wrapped = (e: Event) => (handler as (error: unknown) => void)(e)
				break
		}
		let byHandler = listeners.get(event)
		if (byHandler === undefined) {
			byHandler = new WeakMap()
			listeners.set(event, byHandler)
		}
		const previous = byHandler.get(handler)
		if (previous) ws.removeEventListener(event === "binary" ? "message" : event, previous)
		byHandler.set(handler, wrapped)
		ws.addEventListener(event === "binary" ? "message" : event, wrapped)
	}

	function off(event: string, handler: (...args: never[]) => void): void {
		const byHandler = listeners.get(event)
		const wrapped = byHandler?.get(handler)
		if (wrapped) {
			ws.removeEventListener(event === "binary" ? "message" : event, wrapped)
			byHandler?.delete(handler)
		}
	}

	function toPayload(data: ArrayBuffer | ArrayBufferView | Blob | object | string): Payload {
		if (typeof data === "string") return data
		if (typeof Blob !== "undefined" && data instanceof Blob) return data
		if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
			const view =
				data instanceof ArrayBuffer
					? new Uint8Array(data)
					: new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
			const copy = new Uint8Array(view.byteLength)
			copy.set(view)
			return copy
		}
		return JSON.stringify(data)
	}

	function send(data: ArrayBuffer | ArrayBufferView | Blob | object | string) {
		if (state === "closed") return
		const payload = toPayload(data)
		if (state === "connecting") {
			sendBuffer.push(payload)
		} else {
			ws.send(payload)
		}
	}

	const typed: TypedWebSocket = {
		close,
		off,
		on,
		get readyState() {
			return ws.readyState
		},
		send,
	}

	Object.defineProperty(typed, "_ws", { enumerable: false, value: ws })

	return typed
}
