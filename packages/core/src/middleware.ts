/** phantom wrapper — at runtime it's just Response, carries TAdds for inference */
export type MiddlewareResult<TAdds = {}> = Response & {
	readonly __adds?: TAdds
}

export type MiddlewareFn<TCtx = {}, TAdds = {}, TErrors extends string = string> = ((
	ctx: TCtx,
	next: {
		<T>(additions: T): Promise<MiddlewareResult<T>>
		(): Promise<MiddlewareResult<{}>>
	},
) => Promise<MiddlewareResult<TAdds>>) & {
	errors?: readonly TErrors[]
	/** Meta this middleware contributes to every route that mounts it. Codegen + `ctx.meta` */
	meta?: Readonly<Record<string, unknown>>
}

/**
 * Stamp a stable name on a middleware closure.
 *
 * `Function.prototype.name` is inferred by whatever transpiled the module — jiti (used by
 * `honey generate`) and rollup (used by `vite build`) disagree about a closure returned from
 * a factory, which made the generated manifest differ between the two. Naming shipped
 * middleware explicitly makes the manifest deterministic, and "cors" reads better than
 * "anonymous" besides.
 */
export function namedMiddleware<T extends object>(name: string, fn: T): T {
	Object.defineProperty(fn, "name", { configurable: true, value: name })
	return fn
}

/** runtime type for stored middleware — erased generics, used internally */
export type RuntimeMiddleware = (
	ctx: Record<string, unknown>,
	next: (additions?: Record<string, unknown>) => Promise<Response>,
) => Promise<Response>

/**
 * Create middleware with error keys constrained to a factory.
 * Error keys are stored on the function and auto-accumulated by .use().
 */
export function defineMiddleware<
	TReqs,
	TAdds,
	TFactory extends Record<string, (...args: never[]) => unknown>,
	TKeys extends keyof TFactory & string,
>(opts: {
	errors?: [TFactory, ...TKeys[]]
	fn: MiddlewareFn<TReqs, TAdds>
	meta?: Record<string, unknown>
}): MiddlewareFn<TReqs, TAdds, TKeys> {
	const fn = opts.fn as MiddlewareFn<TReqs, TAdds, TKeys>
	if (opts.errors) {
		const [, ...keys] = opts.errors
		Object.defineProperty(fn, "errors", { value: keys })
	}
	if (opts.meta) attachMiddlewareMeta(fn, opts.meta)
	return fn
}

/**
 * `internal` decides whether a route appears in generated artifacts at all. A middleware that
 * set it would silently remove routes from the document, which is not noticeable by reading
 * either the route or the middleware — so it is the one key middleware may not contribute.
 */
function attachMiddlewareMeta(fn: object, meta: Record<string, unknown>): void {
	if ("internal" in meta) {
		throw new Error(
			'middleware meta cannot set "internal" — it controls whether routes appear in generated ' +
				"artifacts; set it on the route with .meta({ internal: true })",
		)
	}
	Object.defineProperty(fn, "meta", { value: Object.freeze({ ...meta }) })
}

type NextFn = {
	<T>(additions: T): Promise<MiddlewareResult<T>>
	(): Promise<MiddlewareResult<{}>>
}

/** Extract TAdds from callback return type — distributes over unions */
type ExtractAdds<T> = T extends Promise<MiddlewareResult<infer A>> ? A : never

/**
 * Middleware factory — annotate ctx for TReqs, TAdds inferred from return type:
 *   createMiddleware((ctx: { env: { DB: D1Database } }, next) => next({ db }))
 */
export function createMiddleware<TReqs = {}, TRet extends Promise<Response> = Promise<MiddlewareResult<{}>>>(
	fn: (ctx: TReqs, next: NextFn) => TRet,
	opts?: { meta?: Record<string, unknown> },
): MiddlewareFn<TReqs, ExtractAdds<TRet>> {
	if (opts?.meta) attachMiddlewareMeta(fn, opts.meta)
	return fn as MiddlewareFn<TReqs, ExtractAdds<TRet>>
}

/**
 * Merge meta contributed by a middleware chain, in run order (later wins). Resolved once when
 * the app finalizes, from the chain the route runs — never per request.
 */
export function collectMiddlewareMeta(
	groups: ReadonlyArray<ReadonlyArray<RuntimeMiddleware>>,
): Record<string, unknown> | null {
	let out: Record<string, unknown> | undefined
	for (const group of groups) {
		for (const mw of group) {
			const meta = (mw as { meta?: Readonly<Record<string, unknown>> }).meta
			if (!meta) continue
			if (out === undefined) out = {}
			Object.assign(out, meta)
		}
	}
	return out ?? null
}

/**
 * Every name the framework owns on a request context — fields, lazy getters, methods and
 * internal backing state. `next({ ... })` additions and `.context()` values may not use them:
 * an addition would silently replace framework state, and a value assigned over a getter-only
 * field throws on every request. TypeScript prevents most of this at compile time; this set
 * is the runtime guard.
 */
export const RESERVED_CTX_KEYS: ReadonlySet<string> = new Set([
	"background",
	"cookies",
	"env",
	"errors",
	"executionCtx",
	"headers",
	"input",
	"ip",
	"meta",
	"params",
	"path",
	"realtime",
	"req",
	"res",
	"routePattern",
	"search",
	"searchAll",
	"signal",
	"tap",
	"_ac",
	"_errorToResponse",
	"_isErrorResponse",
	"_lzClient",
	"_lzCookies",
	"_lzHeaders",
	"_lzSearch",
	"_lzSearchAll",
	"_lzUrlFn",
	"_pendingTaps",
	"_rq",
	"_setErrors",
])

/**
 * Turns a value thrown inside a chain into the Response that stands in for it. Supplied by
 * the app; must not throw.
 */
export type ChainErrorConverter = (thrown: unknown, ctx: object) => Response | Promise<Response>

const NO_RESPONSE_HANDLER = "handler must return a Response — did you forget 'return ctx.res...()'?"
const NO_RESPONSE_MIDDLEWARE = "middleware must return a Response — did you forget 'return next(...)'?"

/**
 * Compile a middleware chain + handler into a single function, once.
 *
 * With `convert`, every `next()` boundary is an error boundary: whatever the handler or a
 * middleware throws (or rejects with) becomes a Response at that layer, so the middleware
 * around it always gets a Response back from `next()` and its post-`next()` code — headers,
 * logging, timing — runs on error responses too. The compiled function never rejects as long
 * as `convert` does not. Without `convert`, throws propagate (the bare executor).
 */
export function compileChain(
	middlewares: RuntimeMiddleware[],
	handler: (ctx: object) => Response | Promise<Response>,
	convert?: ChainErrorConverter,
): (ctx: object) => Response | Promise<Response> {
	if (convert !== undefined) return compileConverting(middlewares, handler, convert)
	if (middlewares.length === 0) {
		/* sync fast path — avoids microtask overhead for sync handlers */
		return (ctx) => {
			const result = handler(ctx)
			if (result instanceof Promise) {
				return result.then(validateResponse)
			}
			if (result === undefined || result === null) {
				throw new Error(NO_RESPONSE_HANDLER)
			}
			return result
		}
	}

	if (middlewares.length === 1) {
		const mw = middlewares[0]
		if (!mw) {
			throw new Error("middleware chain invariant violated")
		}
		return (ctx) => {
			const mwCtx = ctx as Record<string, unknown>
			let called = false
			return Promise.resolve(
				mw(mwCtx, (additions?: Record<string, unknown>) => {
					if (called) throw new Error("next() called multiple times")
					called = true
					if (additions) mergeAdditions(ctx, additions)
					return Promise.resolve(handler(ctx)).then(validateResponse)
				}),
			).then(validateMiddlewareResponse)
		}
	}

	/* general case — pre-bind middleware array, no per-request index tracking */
	return (ctx) => executeChain(middlewares, ctx, handler)
}

function compileConverting(
	middlewares: readonly RuntimeMiddleware[],
	handler: (ctx: object) => Response | Promise<Response>,
	convert: ChainErrorConverter,
): (ctx: object) => Response | Promise<Response> {
	const n = middlewares.length

	const runHandler = (ctx: object): Response | Promise<Response> => {
		let result: Response | Promise<Response>
		try {
			result = handler(ctx)
		} catch (thrown) {
			return convert(thrown, ctx)
		}
		if (result instanceof Promise) {
			return result.then(
				(value) => (value === undefined || value === null ? convert(new Error(NO_RESPONSE_HANDLER), ctx) : value),
				(thrown: unknown) => convert(thrown, ctx),
			)
		}
		if (result === undefined || result === null) return convert(new Error(NO_RESPONSE_HANDLER), ctx)
		return result
	}

	const step = (i: number, ctx: object): Response | Promise<Response> => {
		if (i === n) return runHandler(ctx)
		const mw = middlewares[i] as RuntimeMiddleware
		let called = false
		const next = (additions?: Record<string, unknown>): Promise<Response> => {
			if (called) throw new Error("next() called multiple times")
			called = true
			if (additions) mergeAdditions(ctx, additions)
			const downstream = step(i + 1, ctx)
			return downstream instanceof Promise ? downstream : Promise.resolve(downstream)
		}
		let out: Promise<Response>
		try {
			out = mw(ctx as Record<string, unknown>, next)
		} catch (thrown) {
			return convert(thrown, ctx)
		}
		return Promise.resolve(out).then(
			(value) => (value === undefined || value === null ? convert(new Error(NO_RESPONSE_MIDDLEWARE), ctx) : value),
			(thrown: unknown) => convert(thrown, ctx),
		)
	}

	return (ctx) => step(0, ctx)
}

function mergeAdditions(ctx: object, additions: Record<string, unknown>): void {
	for (const key in additions) {
		if (!RESERVED_CTX_KEYS.has(key)) {
			;(ctx as Record<string, unknown>)[key] = additions[key]
		}
	}
}

function validateResponse(result: Response): Response {
	if (result === undefined || result === null) {
		throw new Error(NO_RESPONSE_HANDLER)
	}
	return result
}

function validateMiddlewareResponse(result: Response): Response {
	if (result === undefined || result === null) {
		throw new Error(NO_RESPONSE_MIDDLEWARE)
	}
	return result
}

export function executeChain(
	middlewares: RuntimeMiddleware[],
	ctx: object,
	handler: (ctx: object) => Response | Promise<Response>,
): Promise<Response> {
	let index = 0
	/* middleware runtime type uses Record<string, unknown> — object satisfies at runtime */
	const mwCtx = ctx as Record<string, unknown>

	function dispatch(): Promise<Response> {
		if (index >= middlewares.length) {
			return Promise.resolve(handler(ctx)).then((result) => {
				if (result === undefined || result === null) {
					throw new Error("handler must return a Response — did you forget 'return ctx.res...()'?")
				}
				return result
			})
		}
		const mw = middlewares[index++]
		if (!mw) {
			throw new Error("middleware chain invariant violated")
		}
		let called = false
		return Promise.resolve(
			mw(mwCtx, (additions?: Record<string, unknown>) => {
				if (called) {
					throw new Error("next() called multiple times")
				}
				called = true
				if (additions) mergeAdditions(ctx, additions)
				return dispatch()
			}),
		).then((result) => {
			if (result === undefined || result === null) {
				throw new Error("middleware must return a Response — did you forget 'return next(...)'?")
			}
			return result
		})
	}

	return dispatch()
}
