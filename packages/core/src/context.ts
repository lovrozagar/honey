import { isNodeOutbound } from "./honey-response.ts"
import type { ProducerOptions } from "./producer-stream.ts"
import type { SSEOptions, SSEStream, TypedResponse } from "./response.ts"
import { HoneyRes } from "./response.ts"
import { dict } from "./dict.ts"
import { peerAddressOf } from "./peer.ts"
import { resolveClientInfo, TRUST_OFF, type ClientInfo, type TrustSetting } from "./trust.ts"
import type { PendingTap } from "./types.ts"
import { EMPTY_OBJ } from "./types.ts"
import { parseCookies } from "./validation.ts"

/**
 * Per-request res with lazy lastEventId — only reads the header when SSE is actually called.
 * All non-SSE methods (json/text/html/etc) are inherited from HoneyRes with zero overhead.
 */
class ContextRes extends HoneyRes {
	private _req: Request
	private _ctx: HoneyContext<unknown>
	private _lastEventId: string | undefined | false = false

	constructor(req: Request, ctx: HoneyContext<unknown>) {
		super(isNodeOutbound(req))
		this._req = req
		this._ctx = ctx
	}

	/** Streams end with the request: `ctx.signal`. Producer failures go to the app logger. */
	protected override _producer(): ProducerOptions {
		const ctx = this._ctx
		return {
			report: (err) => reportStreamError(ctx, err),
			signal: () => ctx.signal,
		}
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
	/* keys are request data: no prototype, so `?__proto__=` or `?toString=` is just a key */
	const first = dict<string>()
	const all = dict<string[]>()
	for (const [key, value] of url.searchParams) {
		const values = all[key]
		if (values === undefined) {
			first[key] = value
			all[key] = [value]
		} else {
			values.push(value)
		}
	}
	ctx._lzSearch = first
	ctx._lzSearchAll = all
}

/** What `ctx._rq` carries for client-info resolution; the dispatcher's FetchCtx has these fields. */
type ClientSource = { env?: unknown; request?: Request; trust?: TrustSetting }

/**
 * The client address, scheme and host of the request `ctx` serves, decided by the app's
 * `trustProxy()` setting. `ctx.ip` is its `ip`.
 */
export function clientInfo(ctx: HoneyContext<never> | HoneyContext): ClientInfo {
	const c = ctx as HoneyContext
	if (c._lzClient === null) {
		const src = (c._rq ?? {}) as ClientSource
		/* the peer is registered on the request the adapter handed over; headers are read from
		 * ctx.req, which survives Deno's upgrade (a header snapshot) */
		const peer = peerAddressOf(src.request ?? c.req, src.env ?? c.env)
		c._lzClient = resolveClientInfo(src.trust ?? TRUST_OFF, c.req, peer)
	}
	return c._lzClient
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
type Logger = { error?: (obj: unknown, msg?: string) => void }

function reportStreamError(ctx: HoneyContext<unknown>, err: unknown): void {
	const log = (ctx._rq as { log?: Logger } | null)?.log
	if (typeof log?.error === "function") {
		log.error({ err, path: ctx.path }, "stream producer failed")
		return
	}
	console.error("honey: stream producer failed", err)
}

/**
 * Abort `ctx.signal` (with `reason`) for the request `ctx` serves: `timeout()` uses it. Streams
 * still running for the request end, and handlers that pass the signal on stop their work.
 */
export function abortRequest(ctx: HoneyContext<never> | HoneyContext, reason?: unknown): void {
	const c = ctx as HoneyContext
	if (c._ac === null) linkSignal(c)
	c._ac?.abort(reason)
}

/** Create `ctx.signal`, following the request's own signal (client disconnect, shutdown). */
function linkSignal(ctx: HoneyContext): AbortSignal {
	const ac = new AbortController()
	ctx._ac = ac
	let request: AbortSignal | undefined
	try {
		request = ctx.req.signal
	} catch {
		/* a request shim without a signal: only timeout() can abort */
	}
	if (request !== undefined && request !== null) {
		if (request.aborted) ac.abort(request.reason)
		else request.addEventListener("abort", () => ac.abort(request.reason), { once: true })
	}
	return ac.signal
}

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
	/**
	 * The client's IP address in canonical form (`::ffff:1.2.3.4` is `1.2.3.4`), or `null` when
	 * the runtime does not report one. Behind reverse proxies, set `app.trustProxy()`; until then
	 * this is the proxy's address and forwarding headers are ignored.
	 */
	declare readonly ip: string | null
	declare readonly meta: Record<string, unknown>
	declare readonly path: string
	declare readonly realtime: { publish(topic: string, data: unknown): void }
	declare readonly routePattern: string
	declare readonly search: Record<string, string>
	declare readonly searchAll: Record<string, string[]>
	/**
	 * Aborts when the client disconnects, when `timeout()` fires, or when the server shuts down.
	 * Pass it to `fetch()`, database drivers and timers so abandoned work stops; streams from
	 * `ctx.res.sse()`, `stream()` and `generate()` already end with it.
	 */
	declare readonly signal: AbortSignal

	/* backing state for lazy getters — stored directly on instance to avoid extra object allocation */
	/** @internal */ _ac: AbortController | null
	/** @internal */ _lzClient: ClientInfo | null
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

	/* the request this context serves — read by the error boundary and terminal handlers */
	/** @internal */ _rq: unknown

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
		this.res = new ContextRes(opts.req, this as HoneyContext<unknown>)

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
		this._ac = null
		this._lzClient = null
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

		this._rq = null
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
					const h = dict<string>()
					this.req.headers.forEach((value, key) => {
						h[key] = value
					})
					this._lzHeaders = h
				}
				return this._lzHeaders
			},
		})
		Object.defineProperty(HoneyContext.prototype, "ip", {
			configurable: true,
			enumerable: true,
			get(this: HoneyContext): string | null {
				return clientInfo(this).ip
			},
		})
		Object.defineProperty(HoneyContext.prototype, "signal", {
			configurable: true,
			enumerable: true,
			get(this: HoneyContext): AbortSignal {
				return this._ac === null ? linkSignal(this) : this._ac.signal
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
