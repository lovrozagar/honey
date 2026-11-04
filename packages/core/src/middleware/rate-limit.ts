/**
 * `rateLimit({ limit, windowMs })`: a fixed-window limiter. Each key (default `ctx.ip`, the platform
 * peer, so a forwarded header cannot rotate it) gets `limit` requests per window; past that the
 * answer is 429 `too_many_requests` with `Retry-After`, and the handler never runs. Every answer
 * carries `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch seconds).
 *
 * The default store is in-process and per middleware: bounded to `maxKeys` windows, the least
 * recently used evicted first, so a key spray cannot grow it (H18.8). Behind several instances,
 * pass a shared `store`.
 */
import { HoneyError } from "../errors/error.ts"
import { withHeaders } from "../response/with-headers.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

/** A key's window after one more request: requests counted so far, and when it ends (epoch ms). */
export type RateLimitHit = {
	/** Requests counted in the window so far, this one included. */
	readonly count: number
	/** When the window ends, in epoch milliseconds. */
	readonly resetAt: number
}

/** Counts a request against `key`'s current window, starting a new one when it has ended. */
export type RateLimitStore = {
	/** Counts one request against `key` and returns its window. */
	hit(key: string): Promise<RateLimitHit> | RateLimitHit
}

/** An in-process `RateLimitStore` made by `memoryRateLimitStore`. */
export type MemoryRateLimitStore = {
	/** Counts one request against `key` and returns its window. */
	hit(key: string): RateLimitHit
	/** Windows kept, counting an ended one until its key is hit again or evicted. */
	readonly size: number
}

/** The window length and the size bound of a `memoryRateLimitStore`. */
export type MemoryRateLimitStoreOptions = {
	/** Windows kept at most; past it the least recently used is evicted. Default 10 000. */
	maxKeys?: number | undefined
	/** Length of each window in milliseconds; a positive finite number. */
	windowMs: number
}

/** What a `key` function can read from the request. */
type KeyContext = {
	/** The platform-reported peer address, or `null` when none is reported. */
	readonly ip: string | null
	/** The incoming request, for a key built from a header or the URL. */
	readonly req: Request
}

/** Options for `rateLimit`: give `windowMs` (and optionally `maxKeys`) for the built-in store, or your own `store`, not both. */
export type RateLimitOptions = {
	/** Names the window a request counts against. Default `ctx.ip`; requests with no reported peer all share one window. */
	key?: (ctx: KeyContext) => string
	/** Requests per window. */
	limit: number
} & (
	| {
			/** Most windows the built-in store keeps. Default 10 000. */
			maxKeys?: number
			/** Not allowed with `windowMs`: the built-in store is used. */
			store?: never
			/** Window length in milliseconds. */
			windowMs: number
	  }
	| {
			/** Not allowed with a custom `store`; the store sets its own cap. */
			maxKeys?: never
			/** A shared store to count in, for several instances; it owns the window length. */
			store: RateLimitStore
			/** Not allowed with a custom `store`; the store sets its own window. */
			windowMs?: never
	  }
)

class WindowStore implements MemoryRateLimitStore {
	readonly #maxKeys: number
	readonly #windowMs: number
	/* insertion order is recency: a hit re-inserts its key last, so the first key is the LRU */
	readonly #windows = new Map<string, RateLimitHit>()

	constructor(windowMs: number, maxKeys: number) {
		this.#windowMs = windowMs
		this.#maxKeys = maxKeys
	}

	get size(): number {
		return this.#windows.size
	}

	hit(key: string): RateLimitHit {
		const windows = this.#windows
		const now = Date.now()
		const current = windows.get(key)
		if (current !== undefined) windows.delete(key)
		else if (windows.size >= this.#maxKeys) windows.delete(windows.keys().next().value as string)
		const hit =
			current !== undefined && current.resetAt > now
				? { count: current.count + 1, resetAt: current.resetAt }
				: { count: 1, resetAt: now + this.#windowMs }
		windows.set(key, hit)
		return hit
	}
}

/**
 * An in-process store of fixed windows, bounded to `maxKeys` with the least recently used evicted
 * first. An evicted key starts over at its next request. Throws `TypeError` unless `windowMs` is a
 * positive finite number and `maxKeys` a positive integer.
 */
export function memoryRateLimitStore(options: MemoryRateLimitStoreOptions): MemoryRateLimitStore {
	const { maxKeys = 10_000, windowMs } = options
	if (!(Number.isFinite(windowMs) && windowMs > 0)) {
		throw new TypeError("rateLimit: windowMs must be a positive finite number")
	}
	if (!(Number.isInteger(maxKeys) && maxKeys > 0)) throw new TypeError("rateLimit: maxKeys must be a positive integer")
	return new WindowStore(windowMs, maxKeys)
}

function peerKey(ctx: KeyContext): string {
	return ctx.ip ?? ""
}

/**
 * Middleware that lets each key make `limit` requests per fixed window. Past that it answers 429
 * `too_many_requests` with `Retry-After`, and the handler does not run. Its answers carry
 * `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` (epoch seconds). The default
 * key is `ctx.ip`, so behind a self-hosted reverse proxy every client shares one window. The
 * built-in store counts per process and per middleware; behind several instances, pass a shared
 * `store`. Throws `TypeError` unless `limit` is a positive integer, and for a `windowMs` or `maxKeys`
 * that `memoryRateLimitStore` refuses.
 */
export function rateLimit(options: RateLimitOptions): MiddlewareFn<KeyContext, {}, "too_many_requests"> {
	const { limit } = options
	if (!(Number.isInteger(limit) && limit > 0)) throw new TypeError("rateLimit: limit must be a positive integer")
	const store = options.store ?? memoryRateLimitStore(options)
	const keyOf = options.key ?? peerKey
	const limitText = String(limit)
	/** The answer for a counted request: 429 past the limit, else the chain's with the headers. */
	const answer = async (hit: RateLimitHit, next: () => Promise<Response> | Response): Promise<Response> => {
		const remaining = String(Math.max(0, limit - hit.count))
		const reset = String(Math.ceil(hit.resetAt / 1000))
		if (hit.count > limit) {
			const retryAfter = String(Math.max(0, Math.ceil((hit.resetAt - Date.now()) / 1000)))
			throw new HoneyError({
				errorKey: "too_many_requests",
				headers: {
					"retry-after": retryAfter,
					"x-ratelimit-limit": limitText,
					"x-ratelimit-remaining": remaining,
					"x-ratelimit-reset": reset,
				},
				status: "too_many_requests",
			})
		}
		return withHeaders(await next(), (out) => {
			out.set("x-ratelimit-limit", limitText)
			out.set("x-ratelimit-remaining", remaining)
			out.set("x-ratelimit-reset", reset)
		})
	}
	/* a sync store (the memory default) is answered without an extra await */
	const mw: MiddlewareFn<KeyContext, {}, "too_many_requests"> = (ctx, next) => {
		const hit = store.hit(keyOf(ctx))
		return hit instanceof Promise ? hit.then((counted) => answer(counted, next)) : answer(hit, next)
	}
	mw.errors = ["too_many_requests"]
	return namedMiddleware("rateLimit", mw)
}
