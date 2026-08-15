export type TypedWebSocket = {
	close(code?: number, reason?: string): void
	off(event: "close" | "error" | "message" | "open", handler: (...args: never[]) => void): void
	on(event: "close", handler: (code: number, reason: string) => void): void
	on(event: "error", handler: (error: unknown) => void): void
	on(event: "message", handler: (data: string) => void): void
	on(event: "open", handler: () => void): void
	readonly readyState: number
	send(data: ArrayBuffer | ArrayBufferView | object | string): void
}

export type WSOptions = {
	protocols?: string | string[]
}

export function createTypedWebSocket(
	url: string,
	opts?: WSOptions,
	WebSocketImpl: typeof WebSocket = WebSocket,
): TypedWebSocket {
	const ws = opts?.protocols ? new WebSocketImpl(url, opts.protocols) : new WebSocketImpl(url)

	/* map user handlers → wrapped listeners for proper removal */
	const listenerMap = new WeakMap<(...args: never[]) => void, EventListener>()
	/* buffer sends until OPEN */
	const sendBuffer: Array<string | Uint8Array<ArrayBuffer>> = []
	let buffering = true

	ws.addEventListener("open", () => {
		buffering = false
		for (const msg of sendBuffer) {
			ws.send(msg)
		}
		sendBuffer.length = 0
	})

	function close(code?: number, reason?: string) {
		buffering = false
		sendBuffer.length = 0
		ws.close(code, reason)
	}

	function on(event: "close", handler: (code: number, reason: string) => void): void
	function on(event: "error", handler: (error: unknown) => void): void
	function on(event: "message", handler: (data: string) => void): void
	function on(event: "open", handler: () => void): void
	function on(event: string, handler: (...args: never[]) => void): void {
		let wrapped: EventListener
		switch (event) {
			case "message":
				wrapped = (e: Event) => (handler as (data: string) => void)((e as MessageEvent).data)
				break
			case "open":
				wrapped = () => (handler as () => void)()
				break
			case "close":
				wrapped = (e: Event) =>
					(handler as (code: number, reason: string) => void)((e as CloseEvent).code, (e as CloseEvent).reason)
				break
			case "error":
				wrapped = (e: Event) => (handler as (error: unknown) => void)(e)
				break
			default:
				return
		}
		listenerMap.set(handler, wrapped)
		ws.addEventListener(event, wrapped)
	}

	function off(event: string, handler: (...args: never[]) => void): void {
		const wrapped = listenerMap.get(handler)
		if (wrapped) {
			ws.removeEventListener(event, wrapped)
			listenerMap.delete(handler)
		}
	}

	function toWsData(data: ArrayBuffer | ArrayBufferView | string): string | Uint8Array<ArrayBuffer> {
		if (typeof data === "string") return data
		const view =
			data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		const copy = new Uint8Array(view.byteLength)
		copy.set(view)
		return copy
	}

	function send(data: ArrayBuffer | ArrayBufferView | object | string) {
		const payload =
			typeof data === "string" || data instanceof ArrayBuffer || ArrayBuffer.isView(data)
				? toWsData(data)
				: JSON.stringify(data)

		if (buffering) {
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
