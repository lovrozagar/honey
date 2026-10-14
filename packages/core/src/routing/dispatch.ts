/**
 * The fetch pipeline: normalize the request path, redirect a non-canonical trailing slash, strip
 * the app prefix, find the route (statics first), and run its compiled chain. Every exit — 400,
 * redirect, 404, 405, preflight, a handler, a throw — yields one Response. A throw becomes a
 * response at the `next()` boundary through the projector and `onError`; the boundary never rejects.
 */
import { HoneyContext, REQUEST, type RequestState, setCtxError } from "../context/context.ts"
import { HoneyError, hasUnknownStatus } from "../errors/error.ts"
import { asHoneyError, createErrorResponse, projectThrown, safeErrorResponse } from "../errors/projector.ts"
import { compileChain, type MaybePromise } from "../middleware/middleware.ts"
import { replaceResponse, withRawBody } from "../response/builder.ts"
import type { StatusKey } from "../response/status.ts"
import { finalize, type FinalizeHooks, type FinalTable, type Plan } from "./finalize.ts"
import { matchRoute } from "./match.ts"
import type { HoneyGraph } from "./register.ts"
import { normalizePath, pathOfUrl, searchOfUrl } from "./request-path.ts"
import { type AppSettings, defaultErrorFormatter, type ErrorCtx } from "./settings.ts"

/** The request state of one fetch: the context's request fields, the plan it runs, the 405 answer. */
export type FetchState<TEnv = unknown> = RequestState<TEnv> & { allowed: string[] | null; plan: Plan }

const EMPTY_PARAMS: Record<string, string> = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.create(null))

function stateOf(ctx: object): FetchState {
	return (ctx as HoneyContext<unknown>)[REQUEST] as FetchState
}

function errorCtx(s: AppSettings<unknown>, state: FetchState): ErrorCtx<unknown> {
	return {
		env: state.env,
		jsonFromError: (err) => createErrorResponse(err, s.errorFormatter, s.customErrorFormatter),
		req: state.req,
	}
}

/** The app's error for a framework condition: its factory's, else a plain one. */
function frameworkError(s: AppSettings<unknown>, errorKey: string, status: StatusKey): HoneyError {
	const make = s.errorFactory?.[errorKey]
	return typeof make === "function" ? (make as () => HoneyError)() : new HoneyError({ errorKey, status })
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
function boundary(s: AppSettings<unknown>): (thrown: unknown, ctx: object) => MaybePromise<Response> {
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

/** Add `Allow` to a 405, rebuilding a response whose headers are immutable. */
function withAllow(res: Response, allowed: string[]): Response {
	const value = allowed.join(", ")
	try {
		res.headers.set("allow", value)
		return res
	} catch {
		const headers = new Headers(res.headers)
		headers.set("allow", value)
		return replaceResponse(res, { headers })
	}
}

function make404(s: AppSettings<unknown>, state: FetchState): MaybePromise<Response> {
	if (s.onNotFound !== null) return s.onNotFound(errorCtx(s, state))
	return errorCtx(s, state).jsonFromError(frameworkError(s, "not_found", "not_found"))
}

function make405(s: AppSettings<unknown>, state: FetchState, allowed: string[]): MaybePromise<Response> {
	const res =
		s.onMethodNotAllowed === null
			? errorCtx(s, state).jsonFromError(frameworkError(s, "method_not_allowed", "method_not_allowed"))
			: s.onMethodNotAllowed({ ...errorCtx(s, state), allowed })
	return res instanceof Promise ? res.then((r) => withAllow(r, allowed)) : withAllow(res, allowed)
}

/**
 * The fixed 404, built per request from one payload, for a miss nothing observes: the miss chain runs
 * nothing (finalize decides) and, checked per request since a setter may come later, no
 * `onNotFound`, the default formatter (a custom one may stamp each body) and no factory override.
 */
function fixedNotFound(): () => Response {
	const error = new HoneyError({ errorKey: "not_found", status: "not_found" })
	const payload = JSON.stringify({
		error_key: error.errorKey,
		fields: error.fields,
		message: error.message,
		status: error.status,
		status_key: error.statusKey,
		success: false,
	})
	return () =>
		withRawBody(new Response(payload, { headers: { "content-type": "application/json" }, status: 404 }), payload)
}

function plainNotFound(s: AppSettings<unknown>): boolean {
	return (
		s.onNotFound === null &&
		s.errorFormatter === defaultErrorFormatter &&
		s.customErrorFormatter === null &&
		s.errorFactory === null
	)
}

/** The hooks a graph's chains are compiled with, created once per graph. */
function hooksOf(g: HoneyGraph): FinalizeHooks {
	const s = g.settings
	g.hooks ??= {
		convert: boundary(s),
		miss: (ctx) => {
			const state = stateOf(ctx)
			return state.allowed === null ? make404(s, state) : make405(s, state, state.allowed)
		},
		notFound: fixedNotFound(),
	}
	return g.hooks
}

/** The graph's final table, compiled with its hooks. */
export function finalTable(g: HoneyGraph): FinalTable {
	return finalize(g, hooksOf(g))
}

/** 400 for a request path the normalization policy rejects. No boundary, no onError. */
export function badRequestTarget(s: AppSettings<unknown>): Response {
	return createErrorResponse(frameworkError(s, "bad_request", "bad_request"), s.errorFormatter, s.customErrorFormatter)
}

/** The canonical path a non-canonical trailing slash redirects to, or `null`. */
function trailingSlashTarget(s: AppSettings<unknown>, path: string): string | null {
	if (path.length <= 1) return null
	if (s.trailingSlash === "strip" && path.endsWith("/")) return path.slice(0, -1)
	if (s.trailingSlash === "enforce" && !path.endsWith("/")) return `${path}/`
	return null
}

/** The path under the app prefix: whole segments only; a path without the prefix passes through. */
function afterPrefix(prefix: string | null, path: string): string {
	if (prefix === null) return path
	if (path === prefix) return "/"
	return path.startsWith(prefix) && path.charCodeAt(prefix.length) === 47 ? path.slice(prefix.length) : path
}

function run(state: FetchState, plan: Plan, params: Record<string, string>): MaybePromise<Response> {
	state.plan = plan
	const ctx = new HoneyContext(state, plan.route, params)
	if (plan.cv !== null) Object.assign(ctx, plan.cv)
	return plan.run(ctx)
}

function miss(
	s: AppSettings<unknown>,
	final: FinalTable,
	state: FetchState,
	allowed: string[] | null,
): MaybePromise<Response> {
	if (allowed === null && final.notFound !== null && plainNotFound(s)) return final.notFound()
	state.allowed = allowed
	return run(state, final.miss, EMPTY_PARAMS)
}

/**
 * A CORS preflight for a path with no OPTIONS route runs the chain of the route it asks about
 * (`Access-Control-Request-Method`) without the handler: middleware that answers it (cors)
 * short-circuits, else the answer is the 405 with `Allow`.
 */
function preflight(
	g: HoneyGraph,
	final: FinalTable,
	state: FetchState,
	allowed: string[],
): MaybePromise<Response> | null {
	const requested = state.req.headers.get("access-control-request-method")
	if (requested === null) return null
	const hit = matchRoute(g.root, requested.trim().toUpperCase(), state.path)
	if (hit === null || !hit.matched) return null
	const plan = final.plans.get(hit.id) as Plan
	const hooks = hooksOf(g)
	plan.pf ??= compileChain(plan.pfChain, hooks.miss, hooks.convert)
	state.allowed = allowed
	state.plan = plan
	return plan.pf(new HoneyContext(state, plan.route, hit.params))
}

/** Serve one request from the graph. */
export function dispatch(
	g: HoneyGraph,
	request: Request,
	env: unknown,
	executionCtx: RequestState<unknown>["executionCtx"],
) {
	const s = g.settings
	const fullPath = normalizePath(pathOfUrl(request.url), s.encodedSlashes)
	if (fullPath === null) return badRequestTarget(s)
	const final = finalTable(g)
	const target = trailingSlashTarget(s, fullPath)
	if (target !== null) {
		/* a relative Location: the client keeps the scheme, host and port it used */
		return new Response(null, { headers: { location: target + searchOfUrl(request.url) }, status: 308 })
	}
	const path = afterPrefix(s.stripPrefix, fullPath)
	const method = request.method.toUpperCase()
	const state: FetchState = { allowed: null, env, executionCtx, path, plan: final.miss, req: request }
	const hit = final.statics[method]?.[path] ?? (method === "HEAD" ? final.statics.GET?.[path] : undefined)
	if (hit !== undefined) return run(state, hit, EMPTY_PARAMS)
	const match = matchRoute(g.root, method, path)
	if (match === null) return miss(s, final, state, null)
	if (!match.matched) {
		const answered = method === "OPTIONS" ? preflight(g, final, state, match.allowed) : null
		return answered ?? miss(s, final, state, match.allowed)
	}
	return run(state, final.plans.get(match.id) as Plan, match.params)
}
