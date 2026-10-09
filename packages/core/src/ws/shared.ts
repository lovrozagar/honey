/**
 * Options every WebSocket adapter takes, with the same meaning and defaults on Node, Bun, Deno
 * and Workers. Each adapter enforces what its runtime does not.
 */
export type WSAdapterOptions = {
	/**
	 * Largest inbound message in bytes. A bigger one closes the connection with 1009.
	 * Default 1 MiB.
	 */
	maxPayload?: number
	/**
	 * Outbound bytes a socket may hold unsent before `backpressurePolicy` applies to the next
	 * `send()`. Default 8 MiB.
	 */
	backpressureLimit?: number
	/**
	 * Over `backpressureLimit`: `"close"` closes the connection with 1013 (try again later),
	 * `"drop"` discards the message. Default `"close"`.
	 */
	backpressurePolicy?: "close" | "drop"
	/**
	 * Close a connection that has received nothing (no message, no pong) for this many
	 * milliseconds. Idle peers are pinged first where the runtime allows it. `0` disables.
	 * Default 120 000 (Bun's default). Deno and Bun take whole seconds.
	 */
	idleTimeout?: number
	/**
	 * Choose the subprotocol from the ones the client offered (`Sec-WebSocket-Protocol`).
	 * Return `null` or `undefined` for none. Default: the first one offered.
	 */
	protocol?: (offered: string[], req: Request) => string | null | undefined
}

export type ResolvedWSOptions = {
	backpressureLimit: number
	backpressurePolicy: "close" | "drop"
	idleTimeout: number
	maxPayload: number
	protocol: (offered: string[], req: Request) => string | null | undefined
}

export const DEFAULT_MAX_PAYLOAD = 1024 * 1024
export const DEFAULT_BACKPRESSURE_LIMIT = 8 * 1024 * 1024
export const DEFAULT_IDLE_TIMEOUT = 120_000

/** Close codes the adapters use. */
export const CLOSE_GOING_AWAY = 1001
export const CLOSE_POLICY = 1008
export const CLOSE_TOO_BIG = 1009
export const CLOSE_INTERNAL = 1011
export const CLOSE_TRY_AGAIN = 1013

/** Longest close reason a frame can carry (125-byte control payload minus the 2-byte code). */
export const MAX_CLOSE_REASON = 123

const firstOffered = (offered: string[]): string | null => offered[0] ?? null

function nonNegative(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new TypeError(`WebSocket adapter: ${name} must be a non-negative number`)
	}
	return value
}

export function resolveWSOptions(opts: WSAdapterOptions | undefined): ResolvedWSOptions {
	const policy = opts?.backpressurePolicy ?? "close"
	if (policy !== "close" && policy !== "drop") {
		throw new TypeError('WebSocket adapter: backpressurePolicy must be "close" or "drop"')
	}
	const maxPayload = nonNegative("maxPayload", opts?.maxPayload, DEFAULT_MAX_PAYLOAD)
	if (maxPayload === 0) throw new TypeError("WebSocket adapter: maxPayload must be positive")
	return {
		backpressureLimit: nonNegative("backpressureLimit", opts?.backpressureLimit, DEFAULT_BACKPRESSURE_LIMIT),
		backpressurePolicy: policy,
		idleTimeout: nonNegative("idleTimeout", opts?.idleTimeout, DEFAULT_IDLE_TIMEOUT),
		maxPayload,
		protocol: opts?.protocol ?? firstOffered,
	}
}

/** The subprotocols the client offered, in order. */
export function offeredProtocols(req: Request): string[] {
	const raw = req.headers.get("sec-websocket-protocol")
	if (raw === null) return []
	const out: string[] = []
	for (const part of raw.split(",")) {
		const p = part.trim()
		if (p !== "") out.push(p)
	}
	return out
}

/** The subprotocol to answer with, or `null`. A choice the client did not offer is ignored. */
export function selectProtocol(req: Request, opts: ResolvedWSOptions): string | null {
	const offered = offeredProtocols(req)
	if (offered.length === 0) return null
	const chosen = opts.protocol(offered, req)
	return typeof chosen === "string" && offered.includes(chosen) ? chosen : null
}

/** Outbound bytes the runtime holds for this socket, when it reports them. */
export function bufferedAmountOf(raw: unknown): number {
	if (raw === null || typeof raw !== "object") return 0
	const r = raw as { bufferedAmount?: unknown; getBufferedAmount?: () => unknown }
	if (typeof r.getBufferedAmount === "function") {
		const n = r.getBufferedAmount()
		return typeof n === "number" ? n : 0
	}
	return typeof r.bufferedAmount === "number" ? r.bufferedAmount : 0
}

/** Whether an inbound message is larger than `limit` bytes. */
export function exceedsPayload(data: ArrayBuffer | ArrayBufferView | Blob | string, limit: number): boolean {
	if (typeof data === "string") {
		if (data.length > limit) return true
		/* a UTF-16 unit is at most 3 UTF-8 bytes, so most strings need no encode */
		if (data.length * 3 <= limit) return false
		return new TextEncoder().encode(data).byteLength > limit
	}
	if (typeof Blob !== "undefined" && data instanceof Blob) return data.size > limit
	return (data as ArrayBuffer | ArrayBufferView).byteLength > limit
}

/** `data` as an `ArrayBuffer` holding exactly its bytes (a pooled Buffer's backing store is larger). */
export function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
	if (data instanceof ArrayBuffer) return data
	const { buffer, byteLength, byteOffset } = data
	if (byteOffset === 0 && byteLength === buffer.byteLength && buffer instanceof ArrayBuffer) return buffer
	return buffer.slice(byteOffset, byteOffset + byteLength) as ArrayBuffer
}

/** A close code a server may send: 1000, 1001-1014 except the reserved ones, or 3000-4999. */
export function sendableCloseCode(code: number | undefined): number {
	if (code === undefined) return 1000
	if (code === 1000 || (code >= 3000 && code <= 4999)) return code
	if (code >= 1001 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code
	return 1000
}
