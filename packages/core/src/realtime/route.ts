/**
 * A realtime route's options, and their validation into the config the session runs on. Options
 * the shipped transport does not implement are rejected, never silently ignored.
 */
import type { MiddlewareFn } from "../middleware/middleware.ts"
import { validateOriginPolicy, type WSOriginPolicy } from "../ws/origin.ts"
import { createBus, type RealtimeBus } from "./bus.ts"

/**
 * One realtime connection as the route handler sees it. Only the WebSocket transport ships.
 * Every frame, in both directions, is one JSON text.
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
	on(event: "message", handler: (payload: unknown) => Promise<void> | void): void
	on(event: "close", handler: (reason: string) => Promise<void> | void): void
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

/** `C` is the request context the route's middleware leaves for `identify` and `handler`. */
export type RealtimeOptions<C = unknown> = {
	/**
	 * The topic bus. Default: a fresh bus for this route. Routes share topics only when they are
	 * given the same bus and name the same namespace.
	 */
	bus?: RealtimeBus
	/** Route-level middleware, after the app's chain and scopes, before `identify` and the upgrade. */
	use?: readonly MiddlewareFn<any, any>[]
	/** Topic namespace within the bus. Default: the path given to `realtime()`. */
	namespace?: string
	/** Runs after the route's middleware, before the upgrade. Its result becomes `conn.userId`; a throw rejects the upgrade. */
	identify?: (ctx: C) => Promise<string | null | undefined> | string | null | undefined
	/** Receives every error thrown by `handler` and the `message`/`close` handlers. */
	onError?: (error: unknown, conn: ConnContext) => Promise<void> | void
	limits?: RealtimeLimits
	/**
	 * Browser origins allowed to connect: `"*"`, a list (`https://app.example.com`), or a
	 * predicate. Same-origin always passes. Unset, a cross-origin upgrade that carries `Cookie`
	 * or `Authorization` gets 403.
	 */
	allowedOrigins?: WSOriginPolicy
	handler: (ctx: C, conn: ConnContext) => Promise<void> | void
}

/** A realtime route after validation, with every default applied. */
export type RealtimeConfig = {
	readonly allowedOrigins: WSOriginPolicy | null
	readonly bus: RealtimeBus
	readonly handler: (ctx: unknown, conn: ConnContext) => Promise<void> | void
	readonly identify: ((ctx: unknown) => Promise<string | null | undefined> | string | null | undefined) | null
	readonly limits: Readonly<Required<RealtimeLimits>>
	readonly namespace: string
	readonly onError: ((error: unknown, conn: ConnContext) => Promise<void> | void) | null
	readonly path: string
	readonly use: readonly MiddlewareFn<any, any>[]
}

const DEFAULT_LIMITS: Readonly<Required<RealtimeLimits>> = {
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

function resolveLimits(limits: RealtimeLimits): Required<RealtimeLimits> {
	const { slowConsumer } = limits
	if (slowConsumer !== undefined && slowConsumer !== "close" && slowConsumer !== "drop") {
		throw new TypeError(`realtime limits.slowConsumer must be "close" or "drop", got ${String(slowConsumer)}`)
	}
	return {
		maxBufferedBytes: positiveInt("maxBufferedBytes", limits.maxBufferedBytes, DEFAULT_LIMITS.maxBufferedBytes),
		maxFrameBytes: positiveInt("maxFrameBytes", limits.maxFrameBytes, DEFAULT_LIMITS.maxFrameBytes),
		maxPendingFrames: positiveInt("maxPendingFrames", limits.maxPendingFrames, DEFAULT_LIMITS.maxPendingFrames),
		maxTopics: positiveInt("maxTopics", limits.maxTopics, DEFAULT_LIMITS.maxTopics),
		slowConsumer: slowConsumer ?? DEFAULT_LIMITS.slowConsumer,
	}
}

/** Validate `realtime()` options and apply every default. */
export function resolveRealtimeConfig<C>(path: string, options: RealtimeOptions<C>): RealtimeConfig {
	const opts = options as unknown as RealtimeOptions & { reconnectBuffer?: unknown; transports?: unknown }
	if (typeof opts?.handler !== "function") throw new TypeError(`realtime("${path}"): handler must be a function`)
	if (opts.reconnectBuffer !== undefined) {
		throw new TypeError(
			`realtime("${path}"): reconnectBuffer is not supported. Realtime ships the WebSocket transport without resume; remove the option.`,
		)
	}
	if (opts.transports !== undefined) {
		throw new TypeError(`realtime("${path}"): only the WebSocket transport ships; remove transports.`)
	}
	if (opts.namespace !== undefined && (typeof opts.namespace !== "string" || opts.namespace === "")) {
		throw new TypeError(`realtime("${path}"): namespace must be a non-empty string`)
	}
	return {
		allowedOrigins: opts.allowedOrigins === undefined ? null : validateOriginPolicy(opts.allowedOrigins),
		bus: opts.bus ?? createBus(),
		handler: opts.handler,
		identify: opts.identify ?? null,
		limits: Object.freeze(resolveLimits(opts.limits ?? {})),
		namespace: opts.namespace ?? path,
		onError: opts.onError ?? null,
		path,
		use: opts.use ?? [],
	}
}
