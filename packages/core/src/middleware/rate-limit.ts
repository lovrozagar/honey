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
export type RateLimitHit = { readonly count: number; readonly resetAt: number }

/** Counts a request against `key`'s current window, starting a new one when it has ended. */
export type RateLimitStore = { hit(key: string): Promise<RateLimitHit> | RateLimitHit }

export type MemoryStore = { hit(key: string): RateLimitHit; readonly size: number }

export type MemoryStoreOptions = {
	/** Windows kept at most; past it the least recently used is evicted. Default 10 000. */
	maxKeys?: number | undefined
	windowMs: number
}

type KeyContext = { readonly ip: string | null; readonly req: Request }

export type RateLimitOptions = {
	/** The window a request counts against. Default `ctx.ip`; no reported peer shares one window. */
	key?: (ctx: KeyContext) => string
	/** Requests per window. */
	limit: number
} & (
	| { maxKeys?: number; store?: never; windowMs: number }
	| { maxKeys?: never; store: RateLimitStore; windowMs?: never }
)

class WindowStore implements MemoryStore {
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

export function memoryStore(options: MemoryStoreOptions): MemoryStore {
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

export function rateLimit(options: RateLimitOptions): MiddlewareFn<KeyContext, {}, "too_many_requests"> {
	const { limit } = options
	if (!(Number.isInteger(limit) && limit > 0)) throw new TypeError("rateLimit: limit must be a positive integer")
	const store = options.store ?? memoryStore(options)
	const keyOf = options.key ?? peerKey
	const mw: MiddlewareFn<KeyContext, {}, "too_many_requests"> = async (ctx, next) => {
		const { count, resetAt } = await store.hit(keyOf(ctx))
		const headers: Record<string, string> = {
			"x-ratelimit-limit": String(limit),
			"x-ratelimit-remaining": String(Math.max(0, limit - count)),
			"x-ratelimit-reset": String(Math.ceil(resetAt / 1000)),
		}
		if (count > limit) {
			headers["retry-after"] = String(Math.max(0, Math.ceil((resetAt - Date.now()) / 1000)))
			throw new HoneyError({ errorKey: "too_many_requests", headers, status: "too_many_requests" })
		}
		return withHeaders(await next(), (out) => {
			for (const name in headers) out.set(name, headers[name] as string)
		})
	}
	mw.errors = ["too_many_requests"]
	return namedMiddleware("rateLimit", mw)
}
