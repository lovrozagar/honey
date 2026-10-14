/**
 * The error boundary of every `next()` and the app's `onError`: what a handler or middleware threw
 * becomes the Response that replaces it. `onError` is awaited and response-shaping: it returns a
 * HoneyError to replace the error, a Response to answer, or nothing to fall through to the native
 * projection. The boundary never rejects.
 *
 * An unknown error the app did not handle gets a digest: the client's 500 carries only it, the
 * operator's log line carries it with the error's name, message and stack (H17).
 */
import { type HoneyContext, REQUEST, setCtxError } from "../context/context.ts"
import type { MaybePromise } from "../middleware/middleware.ts"
import type { FetchState } from "../routing/dispatch.ts"
import type { AppSettings, ErrorCtx } from "../routing/settings.ts"
import { requestBindings } from "../telemetry/fields.ts"
import { HoneyError, hasUnknownStatus } from "./error.ts"
import {
	asHoneyError,
	createErrorResponse,
	DIGEST,
	type FormatterReport,
	projectThrown,
	safeErrorResponse,
} from "./projector.ts"

function stateOf(ctx: object): FetchState {
	return (ctx as HoneyContext<unknown>)[REQUEST] as FetchState
}

/** A crashed error formatter, logged with the request it answered (when there is one). */
export function formatterReport(s: AppSettings<unknown>, state: FetchState | null): FormatterReport {
	return (failure) => {
		const where = state === null ? {} : requestBindings(state.req.method, state.path, state.plan.route.id, undefined)
		s.logger.error({ ...where, err: HoneyError.serialize(failure) }, "error formatter failed")
	}
}

/** What `onError`, `onNotFound` and `onMethodNotAllowed` receive. */
export function errorCtx(s: AppSettings<unknown>, state: FetchState): ErrorCtx<unknown> {
	return {
		env: state.env,
		jsonFromError: (err) =>
			createErrorResponse(err, s.errorFormatter, s.customErrorFormatter, formatterReport(s, state)),
		req: state.req,
	}
}

/** Answer with `error`, recording it on `ctx.error`. */
function answer(s: AppSettings<unknown>, ctx: object, error: HoneyError): Response {
	setCtxError(ctx as HoneyContext, error)
	return createErrorResponse(error, s.errorFormatter, s.customErrorFormatter, formatterReport(s, stateOf(ctx)))
}

/** One throw on its way to a response: the context, what was thrown, and the error it projects to. */
type Throw = { readonly ctx: object; readonly error: HoneyError; readonly thrown: unknown }

/** What an operator line says about the request: method, path without its query, route id. */
function bindings(ctx: object): Record<string, string> {
	const state = stateOf(ctx)
	return requestBindings(state.req.method, state.path, state.plan.route.id, (ctx as { requestId?: string }).requestId)
}

/** Sixteen hex characters, random per occurrence: it names the line, it says nothing about the error. */
function newDigest(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8))
	let hex = ""
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
	return hex
}

/**
 * Answer an error nothing handled. An unknown throw that became a 5xx gets a digest, and the
 * operator's line; a HoneyError the app threw itself answers as it is.
 */
function unhandled(s: AppSettings<unknown>, { ctx, error, thrown }: Throw): Response {
	if (error !== thrown && error.status >= 500) {
		const digest = newDigest()
		Object.defineProperty(error, DIGEST, { value: digest })
		s.logger.error({ ...bindings(ctx), digest, err: HoneyError.serialize(thrown) }, "unhandled error")
	}
	return answer(s, ctx, error)
}

/** A failing onError: logged once, then the native projection answers. */
function onErrorFailed(s: AppSettings<unknown>, t: Throw, failure: unknown): Response {
	s.logger.error({ ...bindings(t.ctx), err: HoneyError.serialize(failure) }, "onError failed")
	return unhandled(s, t)
}

/** Apply what `onError` returned: a HoneyError replaces the error, a Response answers, nothing falls through. */
function settleOnError(s: AppSettings<unknown>, t: Throw, result: unknown): Response {
	if (result instanceof HoneyError)
		return answer(s, t.ctx, hasUnknownStatus(result) ? projectThrown(result, stateOf(t.ctx).plan.policy) : result)
	if (result instanceof Response) {
		setCtxError(t.ctx as HoneyContext, t.error)
		return result
	}
	return unhandled(s, t)
}

function convertWith(s: AppSettings<unknown>, thrown: unknown, ctx: object): MaybePromise<Response> {
	const t: Throw = { ctx, error: projectThrown(thrown, stateOf(ctx).plan.policy), thrown }
	const onError = s.onError
	if (onError === null) return unhandled(s, t)
	let result: unknown
	try {
		result = onError(thrown, errorCtx(s, stateOf(ctx)))
	} catch (failure) {
		return onErrorFailed(s, t, failure)
	}
	if (!(result instanceof Promise)) return settleOnError(s, t, result)
	return result.then(
		(value: unknown) => settleOnError(s, t, value),
		(failure: unknown) => onErrorFailed(s, t, failure),
	)
}

/** The error boundary of every `next()`: what was thrown becomes the Response that replaces it. Never rejects. */
export function boundary(s: AppSettings<unknown>): (thrown: unknown, ctx: object) => MaybePromise<Response> {
	/* answering the error failed itself: what failed is logged, and the last-resort answer goes out */
	const reportAndAnswer = (thrown: unknown, ctx: object, failure: unknown): Response => {
		s.logger.error({ ...bindings(ctx), err: HoneyError.serialize(failure) }, "error response failed")
		setCtxError(ctx as HoneyContext, asHoneyError(thrown))
		return safeErrorResponse(thrown, s.errorFormatter, s.customErrorFormatter)
	}
	return (thrown, ctx) => {
		try {
			const res = convertWith(s, thrown, ctx)
			return res instanceof Promise ? res.catch((failure: unknown) => reportAndAnswer(thrown, ctx, failure)) : res
		} catch (failure) {
			return reportAndAnswer(thrown, ctx, failure)
		}
	}
}
