import { isNodeOutbound } from "./honey-response.ts"
import type { SSEOptions, SSEStream, TypedResponse } from "./response.ts"
import { HoneyRes } from "./response.ts"
import type { PendingTap } from "./types.ts"
import { EMPTY_OBJ } from "./types.ts"
import { parseCookies } from "./validation.ts"

/**
 * Per-request res with lazy lastEventId — only reads the header when SSE is actually called.
 * All non-SSE methods (json/text/html/etc) are inherited from HoneyRes with zero overhead.
 */
class ContextRes extends HoneyRes {
	private _req: Request
	private _lastEventId: string | undefined | false = false

	constructor(req: Request) {
		super(isNodeOutbound(req))
		this._req = req
	}

	override sse(
		callback: (stream: SSEStream) => Promise<void>,
		opts?: SSEOptions,
	): TypedResponse<"text/event-stream", "ok"> {
		if (this._lastEventId === false) {
			this._lastEventId = this._req.headers.get("last-event-id") ?? undefined
		}
		return super.sse(callback, {
			...opts,
			lastEventId: opts?.lastEventId ?? this._lastEventId,
		})
	}
}
function parseSearch(ctx: HoneyContext): void {
	const url = ctx._lzUrlFn ? ctx._lzUrlFn() : new URL(ctx.req.url)
	const first: Record<string, string> = {}
	const all: Record<string, string[]> = {}
	for (const [key, value] of url.searchParams) {
		if (first[key] === undefined) {
			first[key] = value
			all[key] = [value]
		} else {
			const values = all[key]
			if (values) {
				values.push(value)
			}
		}
	}
	ctx._lzSearch = first
	ctx._lzSearchAll = all
}

function bgSwallow(p: Promise<unknown>) {
	p.catch(noop)
}
function noop() {}

/**
 * HoneyContext uses `declare` for properties set after construction and
 * class-level getters for lazy-computed properties. No Object.defineProperty
 * on the hot path — V8 optimizes class shapes via hidden classes.
 *
 * `declare` fields have no private brand, so Omit<HoneyContext, "res">
 * works structurally for ApplyOutput type narrowing.
 */
export class HoneyContext<TEnv = Record<string, unknown>> {
	readonly background: (p: Promise<unknown>) => void
	readonly env: TEnv
	readonly params: Record<string, string>
	readonly req: Request
	readonly res: HoneyRes

	/* set after construction — declare keeps them off the private brand */
	declare readonly cookies: Record<string, string>
	declare readonly errors: Record<string, (...args: never[]) => unknown>
	declare readonly executionCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined
	declare readonly headers: Record<string, string>
	declare readonly meta: Record<string, unknown>
	declare readonly path: string
	declare readonly realtime: { publish(topic: string, data: unknown): void }
	declare readonly routePattern: string
	declare readonly search: Record<string, string>
	declare readonly searchAll: Record<string, string[]>

	/* backing state for lazy getters — stored directly on instance to avoid extra object allocation */
	/** @internal */ _lzCookies: Record<string, string> | null
	/** @internal */ _lzHeaders: Record<string, string> | null
	/** @internal */ _lzSearch: Record<string, string> | null
	/** @internal */ _lzSearchAll: Record<string, string[]> | null
	/** @internal */ _lzUrlFn: (() => URL) | null

	/* error propagation — lets handler errors flow back through middleware chain */
	/** @internal */ _errorToResponse: ((thrown: unknown) => Promise<Response>) | null
	/** @internal */ _isErrorResponse: boolean

	/* tap side-effects — queued by c.tap(), drained after handler */
	/** @internal */ _pendingTaps: PendingTap[] | null

	constructor(opts: {
		env: TEnv
		executionCtx?: { waitUntil?: (p: Promise<unknown>) => void }
		meta?: Record<string, unknown>
		params: Record<string, string>
		path?: string
		req: Request
		routePattern?: string
		urlFn?: () => URL
	}) {
		this.req = opts.req
		this.env = opts.env
		this.params = opts.params
		this.res = new ContextRes(opts.req)

		/* direct assignment — no defineProperty */
		;(this as Record<string, unknown>)["executionCtx"] = opts.executionCtx
		;(this as Record<string, unknown>)["path"] = opts.path ?? ""
		;(this as Record<string, unknown>)["routePattern"] = opts.routePattern ?? ""
		;(this as Record<string, unknown>)["meta"] = opts.meta ?? EMPTY_OBJ

		/* invoke through executionCtx so `this` binds to the owning object — workerd's native ExecutionContext.waitUntil throws "Illegal invocation" when called detached */
		const executionCtx = opts.executionCtx
		const waitUntil = executionCtx?.waitUntil
		this.background = waitUntil
			? (p: Promise<unknown>) => {
					waitUntil.call(executionCtx, p)
				}
			: bgSwallow

		/* lazy getter backing — flat on instance, no extra object */
		this._lzCookies = null
		this._lzHeaders = null
		this._lzSearch = null
		this._lzSearchAll = null
		this._lzUrlFn = opts.urlFn ?? null

		/* error propagation */
		this._errorToResponse = null
		this._isErrorResponse = false

		/* taps */
		this._pendingTaps = null
	}

	/** @internal */
	_setErrors(errors: Record<string, (...args: never[]) => unknown>): void {
		;(this as { errors: typeof errors }).errors = errors
	}

	/** Queue a side-effect to fire after handler returns successfully */
	tap(key: string, payload: unknown): void {
		if (this._pendingTaps === null) {
			this._pendingTaps = [{ key, payload }]
		} else {
			this._pendingTaps.push({ key, payload })
		}
	}

	/* lazy getters on prototype — V8 hidden class optimized, no per-instance defineProperty */

	static {
		Object.defineProperty(HoneyContext.prototype, "cookies", {
			configurable: true,
			enumerable: true,
			get(this: HoneyContext): Record<string, string> {
				if (this._lzCookies === null) {
					this._lzCookies = parseCookies(this.req.headers.get("cookie") ?? "")
				}
				return this._lzCookies
			},
		})
		Object.defineProperty(HoneyContext.prototype, "headers", {
			configurable: true,
			enumerable: true,
			get(this: HoneyContext): Record<string, string> {
				if (this._lzHeaders === null) {
					const h: Record<string, string> = {}
					this.req.headers.forEach((value, key) => {
						h[key] = value
					})
					this._lzHeaders = h
				}
				return this._lzHeaders
			},
		})
		Object.defineProperty(HoneyContext.prototype, "search", {
			configurable: true,
			enumerable: true,
			get(this: HoneyContext): Record<string, string> {
				if (this._lzSearch === null) {
					parseSearch(this)
				}
				return this._lzSearch as Record<string, string>
			},
		})
		Object.defineProperty(HoneyContext.prototype, "searchAll", {
			configurable: true,
			enumerable: true,
			get(this: HoneyContext): Record<string, string[]> {
				if (this._lzSearchAll === null) {
					parseSearch(this)
				}
				return this._lzSearchAll as Record<string, string[]>
			},
		})
	}
}
