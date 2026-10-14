/**
 * What every WebSocket adapter shares: the options with one meaning and one default on Node, Bun
 * and Workers, subprotocol choice, payload and close-frame rules, and close-reason truncation.
 */

export type WSAdapterOptions = {
	/** Largest inbound message in bytes; a bigger one closes the connection with 1009. Default 1 MiB. */
	maxPayload?: number
	/** Outbound bytes a socket may hold unsent before `backpressurePolicy` applies to the next `send()`. Default 8 MiB. */
	backpressureLimit?: number
	/** Over `backpressureLimit`: `"close"` closes with 1013 (try again later), `"drop"` discards the message. Default `"close"`. */
	backpressurePolicy?: "close" | "drop"
	/**
	 * Close a connection that received nothing (no message, no pong) for this many ms. Idle peers
	 * are pinged first where the runtime allows it. `0` disables. Default 120 000; Bun takes whole seconds.
	 */
	idleTimeout?: number
	/** Choose the subprotocol from the ones the client offered; `null` or `undefined` for none. Default: the first offered. */
	protocol?: (offered: string[], req: Request) => string | null | undefined
}

export type ResolvedWSOptions = {
	readonly backpressureLimit: number
	readonly backpressurePolicy: "close" | "drop"
	readonly idleTimeout: number
	readonly maxPayload: number
	readonly protocol: (offered: string[], req: Request) => string | null | undefined
}

export const DEFAULT_MAX_PAYLOAD = 1024 * 1024
export const DEFAULT_BACKPRESSURE_LIMIT = 8 * 1024 * 1024
export const DEFAULT_IDLE_TIMEOUT = 120_000

export const CLOSE_NORMAL = 1000
export const CLOSE_GOING_AWAY = 1001
export const CLOSE_POLICY = 1008
export const CLOSE_TOO_BIG = 1009
export const CLOSE_INTERNAL = 1011
export const CLOSE_TRY_AGAIN = 1013

/** Longest close reason a frame carries: a 125-byte control payload minus the 2-byte code. */
export const MAX_CLOSE_REASON = 123

// per-process-constant: text-codec
const encoder = /* @__PURE__ */ new TextEncoder()

/* called only when something was offered */
function firstOffered(offered: string[]): string | undefined {
	return offered[0]
}

function nonNegative(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new TypeError(`WebSocket adapter: ${name} must be a non-negative number`)
	}
	return value
}

export function resolveWSOptions(options: WSAdapterOptions | undefined): ResolvedWSOptions {
	const policy = options?.backpressurePolicy ?? "close"
	if (policy !== "close" && policy !== "drop") {
		throw new TypeError('WebSocket adapter: backpressurePolicy must be "close" or "drop"')
	}
	const maxPayload = nonNegative("maxPayload", options?.maxPayload, DEFAULT_MAX_PAYLOAD)
	if (maxPayload === 0) throw new TypeError("WebSocket adapter: maxPayload must be positive")
	return {
		backpressureLimit: nonNegative("backpressureLimit", options?.backpressureLimit, DEFAULT_BACKPRESSURE_LIMIT),
		backpressurePolicy: policy,
		idleTimeout: nonNegative("idleTimeout", options?.idleTimeout, DEFAULT_IDLE_TIMEOUT),
		maxPayload,
		protocol: options?.protocol ?? firstOffered,
	}
}

/** The subprotocols the client offered, in order. */
export function offeredProtocols(req: Request): string[] {
	const header = req.headers.get("sec-websocket-protocol")
	if (header === null) return []
	return header
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "")
}

/** The subprotocol to answer with, or `null`; a choice the client did not offer is ignored. */
export function selectProtocol(req: Request, options: ResolvedWSOptions): string | null {
	const offered = offeredProtocols(req)
	if (offered.length === 0) return null
	const chosen = options.protocol(offered, req)
	return typeof chosen === "string" && offered.includes(chosen) ? chosen : null
}

/** Outbound bytes the runtime holds for this socket, when it reports them (Bun's method, the DOM property). */
export function bufferedAmountOf(raw: unknown): number {
	if (raw === null || typeof raw !== "object") return 0
	const socket = raw as { bufferedAmount?: unknown; getBufferedAmount?: () => unknown }
	const amount = typeof socket.getBufferedAmount === "function" ? socket.getBufferedAmount() : socket.bufferedAmount
	return typeof amount === "number" ? amount : 0
}

/** Whether an inbound message is larger than `limit` bytes. */
export function exceedsPayload(data: ArrayBuffer | ArrayBufferView | Blob | string, limit: number): boolean {
	if (typeof data === "string") {
		if (data.length > limit) return true
		/* a UTF-16 unit is at most 3 UTF-8 bytes, so most strings need no encoding */
		return data.length * 3 > limit && encoder.encode(data).byteLength > limit
	}
	if (data instanceof Blob) return data.size > limit
	return data.byteLength > limit
}

/** `data` as an ArrayBuffer holding exactly its bytes (a pooled Buffer's backing store is larger). */
export function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
	if (data instanceof ArrayBuffer) return data
	const { buffer, byteLength, byteOffset } = data
	if (byteOffset === 0 && byteLength === buffer.byteLength && buffer instanceof ArrayBuffer) return buffer
	return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer
}

/** A close code a server may send (RFC 6455 §7.4): 1000, 1001–1014 but the reserved ones, or 3000–4999; else 1000. */
export function sendableCloseCode(code: number | undefined): number {
	if (code === undefined) return CLOSE_NORMAL
	if (code === CLOSE_NORMAL || (code >= 3000 && code <= 4999)) return code
	if (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code
	return CLOSE_NORMAL
}

/** `reason` cut to at most `max` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(reason: string, max: number): string {
	if (reason.length * 3 <= max || encoder.encode(reason).byteLength <= max) return reason
	let bytes = 0
	let out = ""
	for (const ch of reason) {
		const size = encoder.encode(ch).byteLength
		if (bytes + size > max) break
		bytes += size
		out += ch
	}
	return out
}
