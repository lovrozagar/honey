/**
 * Taps: `app.tap(key, handler)` registers an observation hook a route fires after its handler
 * answered: for each tap key in the route's meta (with the meta value), then for each
 * `ctx.tap(key, payload)` the handler called. Nothing fires on an error answer, a 404 or 405, a
 * middleware that answered without the handler, or an upgrade. A tap runs after the response, in
 * the background (`waitUntil` where there is one), so it never delays or shapes it; a failing tap is
 * contained (invokeUser) and logged as a warn, "tap failed", never reaching onError.
 */
import { HoneyError } from "../errors/error.ts"
import { type HoneyContext, REQUEST, type RequestState, TAPS } from "../context/context.ts"
import type { CompiledChain, MaybePromise } from "../middleware/middleware.ts"
import { invokeUser } from "../realtime/invoke-user.ts"
import type { AppSettings } from "./settings.ts"

/** What a tap handler sees: the request, never `res` or `tap`, so it can neither answer nor recurse. */
export type TapContext<TEnv = unknown> = {
	readonly background: (promise: Promise<unknown>) => void
	readonly env: TEnv
	readonly headers: Record<string, string>
	readonly meta: Record<string, unknown>
	readonly params: Record<string, string>
	readonly path: string
	readonly req: Request
	readonly routePattern: string
	readonly search: Record<string, string>
}

export type TapFn<TEnv = unknown> = (ctx: TapContext<TEnv>, payload: never) => unknown

/** `app.tap(key, handler)`'s handler: the payload is the declared one for `key` (`.taps<T>()`), else unknown. */
export type TapHandler<TEnv, TTaps, TKey extends string> = (
	ctx: TapContext<TEnv>,
	payload: TKey extends keyof TTaps ? TTaps[TKey] : unknown,
) => unknown

/** `ctx.tap()` as a handler sees it: the declared keys and their payloads, or any key without `.taps<T>()`. */
export type TapMethod<TTaps> = [keyof TTaps] extends [never]
	? { tap(key: string, payload: unknown): void }
	: { tap<const TKey extends keyof TTaps & string>(key: TKey, payload: TTaps[TKey]): void }

type Taps = ReadonlyMap<string, TapFn>

/** The taps a route fires: the serving app's over those of the app it was registered on; `null` for none. */
export function tapsFor(serving: AppSettings<unknown>, own: AppSettings<unknown>): Taps | null {
	/* a taps map exists only once a tap is set: never empty */
	const outer = serving.taps
	const inner = own === serving ? null : own.taps
	if (inner === null) return outer
	if (outer === null) return inner
	return new Map([...inner, ...outer])
}

function stateOf(ctx: object): RequestState<unknown> {
	return (ctx as HoneyContext)[REQUEST]
}

/** The route handler, marking the request when it answered (a throw or a rejection marks nothing). */
export function answering(handler: (ctx: object) => MaybePromise<Response>): (ctx: object) => MaybePromise<Response> {
	return (ctx) => {
		const answer = handler(ctx)
		if (answer instanceof Promise) {
			return answer.then((response) => {
				stateOf(ctx).answered = true
				return response
			})
		}
		stateOf(ctx).answered = true
		return answer
	}
}

/** Run `fn` for `key` after this turn, contained, in the request's background. */
function schedule(ctx: HoneyContext, key: string, fn: TapFn, payload: unknown): void {
	const warn = (error: unknown) => ctx.log.warn({ err: HoneyError.serialize(error), tap: key }, "tap failed")
	ctx.background(
		Promise.resolve().then(() =>
			invokeUser(() => (fn as (ctx: TapContext, payload: unknown) => unknown)(ctx, payload), {
				onError: warn,
				phase: "tap",
			}),
		),
	)
}

/** The route's meta taps, then its `ctx.tap()` calls, when the handler's answer is what goes out. */
function fire(ctx: HoneyContext, response: Response, taps: Taps): void {
	if (stateOf(ctx).answered !== true || ctx.error !== undefined || response.status === 101) return
	const meta = ctx.meta
	for (const [key, fn] of taps) {
		const value = Object.hasOwn(meta, key) ? meta[key] : undefined
		if (value !== undefined) schedule(ctx, key, fn, value)
	}
	for (const call of ctx[TAPS] ?? []) {
		const fn = taps.get(call.key)
		if (fn !== undefined) schedule(ctx, call.key, fn, call.payload)
	}
}

/** `run`, firing `taps` once the whole chain settled on the handler's answer. */
export function firing(run: CompiledChain, taps: Taps): CompiledChain {
	return (ctx) => {
		const response = run(ctx)
		if (response instanceof Promise) {
			return response.then((settled) => {
				fire(ctx as HoneyContext, settled, taps)
				return settled
			})
		}
		fire(ctx as HoneyContext, response, taps)
		return response
	}
}
