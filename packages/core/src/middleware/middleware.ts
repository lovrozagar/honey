/**
 * The middleware primitive: the typed factories, the meta a middleware contributes, and the chain
 * compiler. A chain compiles once per route; every `next()` boundary is an error boundary, and a
 * layer whose middleware answered synchronously stays synchronous (no Promise per layer).
 */
import { isReservedCtxKey } from "../context/context.ts"

export type MaybePromise<T> = Promise<T> | T

/** A Response carrying, at the type level only, the context a middleware added. */
export type MiddlewareResult<TAdds = {}> = Response & {
	readonly __adds?: TAdds
}

/**
 * Run the rest of the chain, optionally adding to the context. Answers synchronously when
 * everything downstream did: `await` it, never `.then` it.
 */
export type NextFn = {
	<T>(additions: T): MaybePromise<MiddlewareResult<T>>
	(): MaybePromise<MiddlewareResult<{}>>
}

export type MiddlewareFn<TCtx = {}, TAdds = {}, TErrors extends string = string> = ((
	ctx: TCtx,
	next: NextFn,
) => MaybePromise<MiddlewareResult<TAdds>>) & {
	errors?: readonly TErrors[]
	/** Meta this middleware contributes to every route that mounts it. */
	meta?: Readonly<Record<string, unknown>>
}

/** A stored middleware, generics erased. */
export type RuntimeMiddleware = (
	ctx: Record<string, unknown>,
	next: (additions?: Record<string, unknown>) => MaybePromise<Response>,
) => MaybePromise<Response>

/**
 * Stamp a stable name on a middleware closure. `Function.prototype.name` is inferred by whatever
 * transpiled the module, and transpilers disagree about a closure returned from a factory; a
 * shipped middleware names itself so generated artifacts are deterministic.
 */
export function namedMiddleware<T extends object>(name: string, fn: T): T {
	Object.defineProperty(fn, "name", { configurable: true, value: name })
	return fn
}

/**
 * `internal` decides whether a route appears in generated artifacts at all; a middleware that set
 * it would silently remove routes, so it is the one key middleware may not contribute.
 */
function attachMiddlewareMeta(fn: object, meta: Record<string, unknown>): void {
	if ("internal" in meta) {
		throw new Error(
			'middleware meta cannot set "internal": it controls whether routes appear in generated artifacts; set it on the route with .meta({ internal: true })',
		)
	}
	Object.defineProperty(fn, "meta", { value: Object.freeze({ ...meta }) })
}

/** A middleware whose error keys are constrained to a factory; `.use()` accumulates them. */
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
		Object.defineProperty(fn, "errors", { value: opts.errors.slice(1) })
		/* the factory the keys come from, off the type: a document reads their statuses off it */
		Object.defineProperty(fn, "errorFactory", { value: opts.errors[0] })
	}
	if (opts.meta) attachMiddlewareMeta(fn, opts.meta)
	return fn
}

/** The additions a middleware's return type carries; distributes over unions. */
type ExtractAdds<T> = Awaited<T> extends MiddlewareResult<infer A> ? A : never

/**
 * A middleware: annotate `ctx` for what it requires; what it adds is inferred from `next({...})`.
 *   createMiddleware((ctx: { env: { DB: D1Database } }, next) => next({ db }))
 */
export function createMiddleware<TReqs = {}, TRet extends MaybePromise<Response> = MaybePromise<MiddlewareResult<{}>>>(
	fn: (ctx: TReqs, next: NextFn) => TRet,
	opts?: { meta?: Record<string, unknown> },
): MiddlewareFn<TReqs, ExtractAdds<TRet>> {
	if (opts?.meta) attachMiddlewareMeta(fn, opts.meta)
	return fn as unknown as MiddlewareFn<TReqs, ExtractAdds<TRet>>
}

/** Merge the meta a chain contributes, in run order (later wins). Resolved once at finalize. */
export function collectMiddlewareMeta(
	groups: ReadonlyArray<ReadonlyArray<RuntimeMiddleware>>,
): Record<string, unknown> | null {
	let out: Record<string, unknown> | null = null
	for (const group of groups) {
		for (const mw of group) {
			const meta = (mw as { meta?: Readonly<Record<string, unknown>> }).meta
			if (meta) out = Object.assign(out ?? {}, meta)
		}
	}
	return out
}

/** Turns a value thrown inside a chain into the Response that stands in for it. Must not throw. */
export type ChainErrorConverter = (thrown: unknown, ctx: object) => MaybePromise<Response>

export type CompiledChain = (ctx: object) => MaybePromise<Response>

const NO_RESPONSE_HANDLER = "handler must return a Response — did you forget 'return ctx.res...()'?"
const NO_RESPONSE_MIDDLEWARE = "middleware must return a Response — did you forget 'return next(...)'?"

function mergeAdditions(ctx: object, additions: Record<string, unknown>): void {
	for (const key in additions) if (!isReservedCtxKey(key)) (ctx as Record<string, unknown>)[key] = additions[key]
}

/** Settle one layer's result: a missing response and a throw both go to the boundary. */
function settle(
	result: MaybePromise<Response>,
	ctx: object,
	convert: ChainErrorConverter,
	missing: string,
): MaybePromise<Response> {
	if (result instanceof Promise) {
		return result.then(
			(value) => value ?? convert(new Error(missing), ctx),
			(thrown: unknown) => convert(thrown, ctx),
		)
	}
	return result ?? convert(new Error(missing), ctx)
}

/**
 * Compile a middleware chain and a handler into one function, once. Whatever the handler or a
 * middleware throws or rejects with becomes a Response at that layer, so the middleware around it
 * always gets a Response from `next()` and its post-`next()` code runs on errors too.
 */
export function compileChain(
	middlewares: readonly RuntimeMiddleware[],
	handler: (ctx: object) => MaybePromise<Response>,
	convert: ChainErrorConverter,
): CompiledChain {
	const n = middlewares.length
	const runHandler = (ctx: object): MaybePromise<Response> => {
		try {
			return settle(handler(ctx), ctx, convert, NO_RESPONSE_HANDLER)
		} catch (thrown) {
			return convert(thrown, ctx)
		}
	}
	const step = (i: number, ctx: object): MaybePromise<Response> => {
		if (i === n) return runHandler(ctx)
		const mw = middlewares[i] as RuntimeMiddleware
		let called = false
		const next = (additions?: Record<string, unknown>): MaybePromise<Response> => {
			if (called) throw new Error("next() called multiple times")
			called = true
			if (additions) mergeAdditions(ctx, additions)
			return step(i + 1, ctx)
		}
		try {
			return settle(mw(ctx as Record<string, unknown>, next), ctx, convert, NO_RESPONSE_MIDDLEWARE)
		} catch (thrown) {
			return convert(thrown, ctx)
		}
	}
	return n === 0 ? runHandler : (ctx) => step(0, ctx)
}
