/**
 * The error boundary of every `next()` and the app's `onError`: what a handler or middleware threw
 * becomes the Response that replaces it. `onError` is awaited and response-shaping: it returns a
 * HoneyError to replace the error, a Response to answer, or nothing to fall through to the native
 * projection. The boundary never rejects.
 */
import { type HoneyContext, REQUEST, setCtxError } from "../context/context.ts"
import type { MaybePromise } from "../middleware/middleware.ts"
import type { FetchState } from "../routing/dispatch.ts"
import type { AppSettings, ErrorCtx } from "../routing/settings.ts"
import { HoneyError, hasUnknownStatus } from "./error.ts"
import { asHoneyError, createErrorResponse, projectThrown, safeErrorResponse } from "./projector.ts"

function stateOf(ctx: object): FetchState {
	return (ctx as HoneyContext<unknown>)[REQUEST] as FetchState
}

/** What `onError`, `onNotFound` and `onMethodNotAllowed` receive. */
export function errorCtx(s: AppSettings<unknown>, state: FetchState): ErrorCtx<unknown> {
	return {
		env: state.env,
		jsonFromError: (err) => createErrorResponse(err, s.errorFormatter, s.customErrorFormatter),
		req: state.req,
	}
}

/** Answer with `error`, recording it on `ctx.error`. */
function answer(s: AppSettings<unknown>, ctx: object, error: HoneyError): Response {
	setCtxError(ctx as HoneyContext, error)
	return createErrorResponse(error, s.errorFormatter, s.customErrorFormatter)
}

/** Apply what `onError` returned: a HoneyError replaces the error, a Response answers, nothing falls through. */
function settleOnError(s: AppSettings<unknown>, ctx: object, error: HoneyError, result: unknown): Response {
	if (result instanceof HoneyError)
		return answer(s, ctx, hasUnknownStatus(result) ? projectThrown(result, stateOf(ctx).plan.policy) : result)
	if (result instanceof Response) {
		setCtxError(ctx as HoneyContext, error)
		return result
	}
	return answer(s, ctx, error)
}

function convertWith(s: AppSettings<unknown>, thrown: unknown, ctx: object): MaybePromise<Response> {
	const error = projectThrown(thrown, stateOf(ctx).plan.policy)
	const onError = s.onError
	if (onError === null) return answer(s, ctx, error)
	let result: unknown
	try {
		result = onError(thrown, errorCtx(s, stateOf(ctx)))
	} catch {
		/* a throwing onError falls back to the native projection */
		return answer(s, ctx, error)
	}
	if (!(result instanceof Promise)) return settleOnError(s, ctx, error, result)
	return result.then(
		(value: unknown) => settleOnError(s, ctx, error, value),
		() => answer(s, ctx, error),
	)
}

/** The error boundary of every `next()`: what was thrown becomes the Response that replaces it. Never rejects. */
export function boundary(s: AppSettings<unknown>): (thrown: unknown, ctx: object) => MaybePromise<Response> {
	const fallback = (thrown: unknown, ctx: object): Response => {
		setCtxError(ctx as HoneyContext, asHoneyError(thrown))
		return safeErrorResponse(thrown, s.errorFormatter, s.customErrorFormatter)
	}
	return (thrown, ctx) => {
		try {
			const res = convertWith(s, thrown, ctx)
			return res instanceof Promise ? res.catch(() => fallback(thrown, ctx)) : res
		} catch {
			return fallback(thrown, ctx)
		}
	}
}
