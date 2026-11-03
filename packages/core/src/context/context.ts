/**
 * `HoneyContext`: what a handler and its middleware see for one request. Dispatch hands it the
 * request state and the route's precomputed info positionally; cookies, headers, the query and
 * the abort signal are read from the request only when first asked for.
 */
import type { HoneyError } from "../errors/error.ts"
import { isNodeOutbound } from "../response/builder.ts"
import { HoneyRes } from "../response/response.ts"
import { searchOfUrl } from "../routing/request-path.ts"
import { dict } from "../routing/tree.ts"
import { requestBindings } from "../telemetry/fields.ts"
import type { Logger } from "../telemetry/logger.ts"
import type { RequestTrace } from "../telemetry/request-trace.ts"
import { parseCookieHeader } from "./cookie.ts"
import { ipOf } from "./peer.ts"

/** The runtime's execution context, as far as honey uses it. */
export type ExecutionCtx = {
	/** Keeps the runtime alive until `p` settles, after the response is sent. */
	waitUntil?: (p: Promise<unknown>) => void
}

/** The per-request state dispatch owns; the context reads its request fields from it. */
export type RequestState<TEnv> = {
	/** The environment passed to `app.fetch()`. */
	readonly env: TEnv
	/** The execution context passed to `app.fetch()`, if any; Workers provide one. */
	readonly executionCtx: ExecutionCtx | undefined
	/** the app's logger */
	readonly logger: Logger
	/** The normalized request path, as on `ctx.path`. */
	readonly path: string
	/** The incoming request. */
	readonly req: Request
	/** `ctx.ip` once something asked: the canonical peer, or `null` when no runtime reports one */
	ip?: string | null
	/** set when the route's handler answered, on a route with taps only: they fire on nothing else */
	answered?: true
	/** the id `requestId()` gave the request and the header it travels in, for `proxy()` and the request log */
	requestId?: {
		/** The header `requestId()` reads and answers the id in. */
		readonly header: string
		/** The request's id, as on `ctx.requestId`. */
		readonly id: string
	}
	/** this request's spans, when the app has telemetry */
	trace?: RequestTrace
	/** the key of the error that answered, for the request log */
	errorKey?: string
	/** a 5xx answer's digest: in its body, on its operator line and in its telemetry */
	digest?: string
}

/** What a context reads from its route, computed once at finalize. */
export type RouteInfo = {
	/** the route's id (`GET /users/:id`); empty for a request no route serves */
	readonly id: string
	/**
	 * The error factories handlers on this route get. With no key declared, every key of the app's factory. Once the route,
	 * its middleware or the app's defaults declare a key, only the declared keys that the factory named by `.errors()` or
	 * the app's defines; a key a middleware brings from its own factory stays out. `null` when neither the app nor the route
	 * has a factory.
	 */
	readonly errors: Readonly<Record<string, (...args: never[]) => unknown>> | null
	/** The route's metadata: what its middleware contributes, overlaid by its handle's `.meta()`, then the route's own. */
	readonly meta: Readonly<Record<string, unknown>>
	/** The route's path pattern, for example `/users/:id`; empty when no route serves the request. */
	readonly pattern: string
}

const EMPTY: Readonly<Record<string, never>> = /* @__PURE__ */ Object.freeze({})

/** The route info of a context built without a route, as a test builds one; a 404 or 405 has route info of its own. */
export const NO_ROUTE: RouteInfo = /* @__PURE__ */ Object.freeze({ errors: null, id: "", meta: EMPTY, pattern: "" })

/** The context's slot for its request state: an own symbol key the package does not export, so it is no part of the API. */
export const REQUEST: unique symbol = /* @__PURE__ */ Symbol("honey.request")

/** Abort `ctx.signal` from inside honey (a timeout): not exported from the package. */
export const ABORT_CONTEXT: unique symbol = /* @__PURE__ */ Symbol("honey.abortContext")

/** The request's trace when the app has telemetry: read by requestId and proxy, never part of the package API. */
export const TRACE: unique symbol = /* @__PURE__ */ Symbol("honey.trace")

/** The taps `ctx.tap()` queued, and whether the route's handler answered: read by routing/tap.ts only. */
export const TAPS: unique symbol = /* @__PURE__ */ Symbol("honey.taps")

/**
 * The instance the constructor built, on that instance: a context derived with `Object.create(ctx)`
 * reaches it through its prototype, so its getters read and write the base's private state rather
 * than throwing for the private fields it lacks. Not exported from the package.
 */
const SELF: unique symbol = /* @__PURE__ */ Symbol("honey.self")

/** One `ctx.tap(key, payload)` call, waiting for the handler's answer. */
export type TapCall = {
	/** The key given to `ctx.tap()`: it picks the handler `app.tap()` registered. */
	readonly key: string
	/** The value given to `ctx.tap()`, handed to that handler. */
	readonly payload: unknown
}

/**
 * Every name the framework owns on a context. `next({ ... })` additions and `.context()` values may
 * not use them: an addition would silently replace framework state, and one assigned over a
 * getter-only field throws on every request.
 */
const RESERVED: Readonly<Record<string, true>> = /* @__PURE__ */ Object.freeze({
	background: true,
	cookies: true,
	env: true,
	error: true,
	errors: true,
	executionCtx: true,
	headers: true,
	input: true,
	ip: true,
	log: true,
	meta: true,
	params: true,
	path: true,
	req: true,
	res: true,
	routePattern: true,
	search: true,
	searchAll: true,
	signal: true,
	tap: true,
})

export function isReservedCtxKey(key: string): boolean {
	return Object.hasOwn(RESERVED, key)
}

/**
 * Put `req` in place of `ctx.req`: bodyLimit's counted body. The headers, method and URL stay what
 * they were, so ctx's parsed views (headers, cookies, the query) still describe it.
 */
export function replaceRequest(ctx: object, req: Request): void {
	;(ctx as { req: Request }).req = req
}

/** Record the error behind the response on `ctx.error`, read-only for user code. */
export function setCtxError(ctx: HoneyContext<never> | HoneyContext, error: HoneyError): void {
	;(ctx as { error: HoneyError | undefined }).error = error
	ctx[REQUEST].errorKey = error.errorKey
}

/**
 * What a handler and its middleware see for one request: the request and response helpers, the route's params and
 * metadata, the environment, the logger and the abort signal.
 */
export class HoneyContext<TEnv = Record<string, unknown>> {
	/**
	 * Keep a promise running past the response. With a `waitUntil` on the execution context (Workers) the runtime holds it
	 * open and reports a rejection itself. On Bun and Node nothing waits for it, so `close()` or the process exiting can cut
	 * it off; a rejection goes to the request's logger as an error.
	 */
	readonly background: (p: Promise<unknown>) => void
	/**
	 * The environment passed to `app.fetch()`: the bindings on Workers, the `env` serve option on Node, and on Bun a copy
	 * of that option that also carries the server.
	 */
	readonly env: TEnv
	/**
	 * The error behind the response, once a handler or a deeper middleware threw, or returned no `Response`, and the
	 * `next()` boundary turned that into an error response: the thrown `HoneyError`, what `onError` replaced it with, or the
	 * boundary error or 500 it became. `undefined` while nothing failed, and on a 404, a 405 or an error status a handler
	 * returned without throwing.
	 */
	readonly error: HoneyError | undefined = undefined
	/**
	 * The error factories this route may use. With no key declared, every key of the app's factory. Once the route, its
	 * middleware or the app's defaults declare a key, only the declared keys that the factory named by `.errors()` or the
	 * app's defines; a key a middleware brings from its own factory stays out. A middleware's key counts, so `timeout()`
	 * alone can leave this empty. Empty when neither the app nor the route has a factory.
	 */
	readonly errors: Readonly<Record<string, (...args: never[]) => unknown>>
	/** The execution context passed to `app.fetch()`: Workers provide one, the Bun and Node adapters do not. */
	readonly executionCtx: ExecutionCtx | undefined
	/**
	 * The route's metadata: what its middleware contributes, overlaid by its handle's `.meta()`, then the route's own. Empty
	 * when none of them sets any.
	 */
	readonly meta: Readonly<Record<string, unknown>>
	/**
	 * The route's path parameters by name, percent-decoded; a malformed escape stays as sent. An optional parameter left out
	 * has no key, and an unnamed wildcard is under `*`. Empty on a route without parameters or when no route serves the
	 * request; an empty one may be frozen, so do not write to it.
	 */
	readonly params: Record<string, string>
	/**
	 * The request path without the query or the app's `stripPrefix`, normalized the same way on every runtime: repeated
	 * slashes collapse, dot segments resolve, and percent escapes stay encoded.
	 */
	readonly path: string
	/**
	 * The incoming request. On Node it is a view shaped like one: `instanceof Request` is false there, and
	 * `toFetchRequest()` gives the real `Request`.
	 */
	readonly req: Request
	/** Builders for the response: `json`, `text`, `redirect` and the rest. */
	readonly res: HoneyRes
	/** The route's path pattern, for example `/users/:id`; empty when no route serves the request. */
	readonly routePattern: string
	readonly [REQUEST]: RequestState<TEnv>
	readonly [SELF]: HoneyContext<TEnv>

	#ac: AbortController | null = null
	#cookies: Record<string, string> | null = null
	#headers: Record<string, string> | null = null
	#log: Logger | null = null
	readonly #routeId: string
	#search: Record<string, string> | null = null
	#searchAll: Record<string, string[]> | null = null
	#taps: TapCall[] | null = null

	/** Honey builds one for each request; application code receives the context instead of making one. */
	constructor(state: RequestState<TEnv>, route: RouteInfo, params: Record<string, string>) {
		this.env = state.env
		this.errors = route.errors ?? EMPTY
		this.executionCtx = state.executionCtx
		this.meta = route.meta
		this.params = params
		this.path = state.path
		this.req = state.req
		/* the context is the res's link to its request: signal and headers read only when a stream needs them */
		this.res = new HoneyRes(isNodeOutbound(state.req), this)
		this.routePattern = route.pattern
		this.#routeId = route.id
		this[REQUEST] = state
		this[SELF] = this
		/* called on its owner: workerd's waitUntil throws "Illegal invocation" when detached */
		const executionCtx = state.executionCtx
		const waitUntil = executionCtx?.waitUntil
		this.background = waitUntil
			? (p) => waitUntil.call(executionCtx, p)
			: (p) => void p.catch((error: unknown) => this.log.error({ err: error }, "background task failed"))
	}

	get [TRACE](): RequestTrace | null {
		return this[REQUEST].trace ?? null
	}

	/**
	 * The client address the platform reports, in one canonical spelling: `CF-Connecting-IP` on Workers, the socket on
	 * Bun and Node. Bun reports it through the server in `env`, which `serve()` puts there. `null` when nothing reports one
	 * or what it reports is not one address. Forwarding headers are not trusted, so behind your own reverse proxy this is
	 * the proxy's address.
	 */
	get ip(): string | null {
		return ipOf(this[REQUEST])
	}

	/**
	 * This request's logger: a child of the app's that binds method, path (without its query), route id, the request id
	 * when one is set, and the trace's ids when traced. Built once, on first use, so a request id set after that is not on
	 * it: read `log` after `requestId()` has run.
	 */
	get log(): Logger {
		const self = this[SELF]
		self.#log ??= self[REQUEST].logger.child(
			requestBindings(self.req.method, self.path, self.#routeId, {
				requestId: (self as { requestId?: string }).requestId,
				trace: self[REQUEST].trace?.ids(),
			}),
		)
		return self.#log
	}

	/**
	 * The request's cookies by name, percent-decoded, parsed from the `Cookie` header on first use. Surrounding double
	 * quotes are dropped and a malformed escape stays as sent. When a name repeats, the first value wins. Names are request
	 * data, so no prototype.
	 */
	get cookies(): Record<string, string> {
		const self = this[SELF]
		self.#cookies ??= parseCookieHeader(self.req.headers.get("cookie") ?? "")
		return self.#cookies
	}

	/** The request headers as a record: keys are lower-case and request data, so no prototype. */
	get headers(): Record<string, string> {
		const self = this[SELF]
		if (self.#headers === null) {
			const out = dict<string>()
			for (const [key, value] of self.req.headers) out[key] = value
			self.#headers = out
		}
		return self.#headers
	}

	/**
	 * The query, decoded with `+` as a space: the first value of each key, empty for a key with no value. Keys are request
	 * data, so no prototype.
	 */
	get search(): Record<string, string> {
		const self = this[SELF]
		if (self.#search === null) self.#parseSearch()
		return self.#search as Record<string, string>
	}

	/** The query, decoded as `search` is: every value of each key, in order. Keys are request data, so no prototype. */
	get searchAll(): Record<string, string[]> {
		const self = this[SELF]
		if (self.#searchAll === null) self.#parseSearch()
		return self.#searchAll as Record<string, string[]>
	}

	/**
	 * Aborts when `timeout()` answers for the request, with a `TimeoutError` as its reason. On Bun and Node it also aborts
	 * when the client disconnects, and when shutdown gives up on the request: once `close()`'s timeout runs out, or as soon
	 * as shutdown starts for a response already streaming on Node. On Workers do not rely on a disconnect: the request's own
	 * signal does not fire on one in workerd. A normal answer does not abort it. Pass it to `fetch()`, database drivers and
	 * timers so abandoned work stops.
	 */
	get signal(): AbortSignal {
		const self = this[SELF]
		self.#ac ??= self.#linkSignal()
		return self.#ac.signal
	}

	/**
	 * Fire the app's tap for `key` with `payload` once the chain settled on this request's handler's answer. Nothing fires
	 * when a throw or a middleware answered instead, but an error status the handler returned still fires, as does an answer
	 * a middleware replaced afterwards. The tap cannot change the response, but it can start before the response is written,
	 * so its synchronous work can delay it. A key no tap is registered for is ignored.
	 */
	tap(key: string, payload: unknown): void {
		const self = this[SELF]
		;(self.#taps ??= []).push({ key, payload })
	}

	/** What `tap()` queued, or null when nothing was. */
	get [TAPS](): readonly TapCall[] | null {
		return this[SELF].#taps
	}

	/** Abort `signal` with `reason`, so work that takes it stops (a timeout answered for it). */
	[ABORT_CONTEXT](reason: unknown): void {
		const self = this[SELF]
		self.#ac ??= self.#linkSignal()
		self.#ac.abort(reason)
	}

	#parseSearch(): void {
		const first = dict<string>()
		const all = dict<string[]>()
		for (const [key, value] of new URLSearchParams(searchOfUrl(this.req.url))) {
			const values = all[key]
			if (values === undefined) {
				first[key] = value
				all[key] = [value]
			} else {
				values.push(value)
			}
		}
		this.#search = first
		this.#searchAll = all
	}

	/** A controller that follows the request's own signal; a request shim without one stands alone. */
	#linkSignal(): AbortController {
		const ac = new AbortController()
		let request: AbortSignal | undefined
		try {
			request = this.req.signal
		} catch {
			/* a request shim with no usable signal: the controller stands alone, nothing failed */
			return ac
		}
		if (request?.aborted) ac.abort(request.reason)
		else request?.addEventListener("abort", () => ac.abort(request.reason), { once: true })
		return ac
	}
}
