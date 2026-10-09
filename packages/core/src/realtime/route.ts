import { validateOriginPolicy, type WSOriginPolicy } from "../ws-origin.ts"

/**
 * One realtime connection as the route handler sees it. Only the WebSocket transport ships.
 * Every frame, in both directions, is one JSON text (see the README's realtime wire format).
 */
export type ConnContext = {
	readonly id: string
	/** What the route's `identify(ctx)` returned, else `null`. */
	readonly userId: string | null
	readonly transport: "ws"
	/** `true` once the connection closed (or `close()` was called). `join` and `send` are then no-ops. */
	readonly closed: boolean
	readonly state: Record<string, unknown>
	/** Subscribe to `topic` in this route's namespace. Throws past `limits.maxTopics`. */
	join(topic: string): void
	leave(topic: string): void
	/** Send one JSON frame to this connection. Throws when `payload` is not JSON-serializable. */
	send(payload: unknown): void
	/** Send one JSON frame to every connection on `topic` in this route's namespace (this one included). */
	publish(topic: string, payload: unknown): void
	/** Close with code 1000. A reason longer than 123 UTF-8 bytes is truncated. */
	close(reason?: string): void
	on(event: "message", handler: (payload: unknown) => void | Promise<void>): void
	on(event: "close", handler: (reason: string) => void | Promise<void>): void
}

export type RealtimeLimits = {
	/** Topics one connection may join. Default 128. */
	maxTopics?: number
	/** Largest inbound text frame in UTF-8 bytes; larger frames close the connection with 1009. Default 1 MiB. */
	maxFrameBytes?: number
	/**
	 * Inbound frames waiting for a handler (a slow async `message` handler, or none attached yet).
	 * Past this the connection closes with 1008. Default 64.
	 */
	maxPendingFrames?: number
	/**
	 * Outbound bytes the runtime may hold for a client that is not reading, where the runtime reports
	 * it (`bufferedAmount`). Past this `slowConsumer` applies. Default 4 MiB.
	 */
	maxBufferedBytes?: number
	/** `"close"` (default) closes a slow consumer with 1013; `"drop"` drops frames until it catches up. */
	slowConsumer?: "close" | "drop"
}

/** `C` is the request context of the handle `realtime()` is called on. */
export type RealtimeRouteOpts<C = unknown> = {
	use?: Array<(ctx: unknown, next: () => Promise<Response>) => Promise<Response>>
	/**
	 * Topic namespace. Connections only see topics of their own namespace. Defaults to the route's
	 * full path pattern, so two realtime routes never share topics unless they name the same namespace.
	 */
	namespace?: string
	/** Runs after the route's middleware, before the upgrade. Its result becomes `conn.userId`; a throw rejects the upgrade. */
	identify?: (ctx: C) => string | null | undefined | Promise<string | null | undefined>
	/** Receives every error thrown by `handler` and the `message`/`close` handlers. Defaults to the app logger. */
	onError?: (error: unknown, conn: ConnContext) => void | Promise<void>
	limits?: RealtimeLimits
	/**
	 * Browser origins allowed to connect: `"*"`, a list (`https://app.example.com`), or a
	 * predicate. Same-origin always passes. Unset, a cross-origin upgrade that carries `Cookie`
	 * or `Authorization` gets 403.
	 */
	allowedOrigins?: WSOriginPolicy
	handler: (c: C, conn: ConnContext) => void | Promise<void>
}

/** A realtime route after validation, with every default applied. */
export type RealtimeConfig = {
	allowedOrigins: WSOriginPolicy | null
	handler: RealtimeRouteOpts["handler"]
	identify: NonNullable<RealtimeRouteOpts["identify"]> | null
	limits: Required<RealtimeLimits>
	namespace: string
	onError: NonNullable<RealtimeRouteOpts["onError"]> | null
	path: string
}

const DEFAULT_LIMITS: Required<RealtimeLimits> = {
	maxBufferedBytes: 4 * 1024 * 1024,
	maxFrameBytes: 1024 * 1024,
	maxPendingFrames: 64,
	maxTopics: 128,
	slowConsumer: "close",
}

function positiveInt(name: string, value: unknown, fallback: number): number {
	if (value === undefined) return fallback
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new TypeError(`realtime limits.${name} must be a positive integer, got ${String(value)}`)
	}
	return value
}

/** Validate `app.realtime()` options. Options the shipped bus does not implement are rejected, not ignored. */
export function resolveRealtimeConfig<C>(path: string, routeOpts: RealtimeRouteOpts<C>): RealtimeConfig {
	const opts = routeOpts as unknown as RealtimeRouteOpts
	if (typeof opts?.handler !== "function") {
		throw new TypeError(`app.realtime("${path}"): handler must be a function`)
	}
	const legacy = opts as { reconnectBuffer?: unknown; transports?: unknown }
	if (legacy.reconnectBuffer !== undefined) {
		throw new TypeError(
			`app.realtime("${path}"): reconnectBuffer is not supported. Realtime ships the WebSocket transport without resume; remove the option.`,
		)
	}
	if (legacy.transports !== undefined) {
		throw new TypeError(`app.realtime("${path}"): only the WebSocket transport ships; remove transports.`)
	}
	if (opts.namespace !== undefined && (typeof opts.namespace !== "string" || opts.namespace === "")) {
		throw new TypeError(`app.realtime("${path}"): namespace must be a non-empty string`)
	}
	const l = opts.limits ?? {}
	if (l.slowConsumer !== undefined && l.slowConsumer !== "close" && l.slowConsumer !== "drop") {
		throw new TypeError(`realtime limits.slowConsumer must be "close" or "drop"`)
	}
	return {
		allowedOrigins: opts.allowedOrigins === undefined ? null : validateOriginPolicy(opts.allowedOrigins),
		handler: opts.handler,
		identify: opts.identify ?? null,
		limits: {
			maxBufferedBytes: positiveInt("maxBufferedBytes", l.maxBufferedBytes, DEFAULT_LIMITS.maxBufferedBytes),
			maxFrameBytes: positiveInt("maxFrameBytes", l.maxFrameBytes, DEFAULT_LIMITS.maxFrameBytes),
			maxPendingFrames: positiveInt("maxPendingFrames", l.maxPendingFrames, DEFAULT_LIMITS.maxPendingFrames),
			maxTopics: positiveInt("maxTopics", l.maxTopics, DEFAULT_LIMITS.maxTopics),
			slowConsumer: l.slowConsumer ?? DEFAULT_LIMITS.slowConsumer,
		},
		namespace: opts.namespace ?? path,
		onError: opts.onError ?? null,
		path,
	}
}

const encoder = new TextEncoder()

/** Cut `reason` to at most `max` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(reason: string, max: number): string {
	if (reason.length * 3 <= max) return reason
	if (encoder.encode(reason).byteLength <= max) return reason
	let bytes = 0
	let out = ""
	for (const ch of reason) {
		const n = encoder.encode(ch).byteLength
		if (bytes + n > max) break
		bytes += n
		out += ch
	}
	return out
}

/** UTF-8 byte length of `text`, short-circuited once it is known to exceed `limit`. */
export function utf8Exceeds(text: string, limit: number): boolean {
	if (text.length > limit) return true
	if (text.length * 3 <= limit) return false
	return encoder.encode(text).byteLength > limit
}
