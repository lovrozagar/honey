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
import { parseCookieHeader } from "./cookie.ts"
import { ipOf } from "./peer.ts"

export type ExecutionCtx = { waitUntil?: (p: Promise<unknown>) => void }

/** The per-request state dispatch owns; the context reads its request fields from it. */
export type RequestState<TEnv> = {
	readonly env: TEnv
	readonly executionCtx: ExecutionCtx | undefined
	/** the app's logger */
	readonly logger: Logger
	readonly path: string
	readonly req: Request
	/** `ctx.ip` once something asked: the canonical peer, or `null` when no runtime reports one */
	ip?: string | null
}

/** What a context reads from its route, computed once at finalize. */
export type RouteInfo = {
	/** the route's id (`GET /users/:id`); empty for a request no route serves */
	readonly id: string
	readonly errors: Readonly<Record<string, (...args: never[]) => unknown>> | null
	readonly meta: Readonly<Record<string, unknown>>
	readonly pattern: string
}

const EMPTY: Readonly<Record<string, never>> = /* @__PURE__ */ Object.freeze({})

/** The route info of a context that serves no route (a miss, a bare context). */
export const NO_ROUTE: RouteInfo = /* @__PURE__ */ Object.freeze({ errors: null, id: "", meta: EMPTY, pattern: "" })

/** The context's slot for its request state: not exported from the package, so user code cannot reach it. */
export const REQUEST: unique symbol = /* @__PURE__ */ Symbol("honey.request")

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
})

export function isReservedCtxKey(key: string): boolean {
	return Object.hasOwn(RESERVED, key)
}

/** Record the error behind the response on `ctx.error`, read-only for user code. */
export function setCtxError(ctx: HoneyContext<never> | HoneyContext, error: HoneyError): void {
	;(ctx as { error: HoneyError | undefined }).error = error
}

export class HoneyContext<TEnv = Record<string, unknown>> {
	/**
	 * Keep a promise running past the response: `waitUntil` on Workers, which reports a rejection
	 * itself; elsewhere a rejection goes to the request's logger.
	 */
	readonly background: (p: Promise<unknown>) => void
	readonly env: TEnv
	/**
	 * The error behind the response, once a handler or a deeper middleware threw and the `next()`
	 * boundary turned it into an error response; `undefined` while nothing failed.
	 */
	readonly error: HoneyError | undefined = undefined
	readonly errors: Readonly<Record<string, (...args: never[]) => unknown>>
	readonly executionCtx: ExecutionCtx | undefined
	readonly meta: Readonly<Record<string, unknown>>
	readonly params: Record<string, string>
	readonly path: string
	readonly req: Request
	readonly res: HoneyRes
	readonly routePattern: string
	readonly [REQUEST]: RequestState<TEnv>

	#ac: AbortController | null = null
	#cookies: Record<string, string> | null = null
	#headers: Record<string, string> | null = null
	#log: Logger | null = null
	readonly #routeId: string
	#search: Record<string, string> | null = null
	#searchAll: Record<string, string[]> | null = null

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
		/* called on its owner: workerd's waitUntil throws "Illegal invocation" when detached */
		const executionCtx = state.executionCtx
		const waitUntil = executionCtx?.waitUntil
		this.background = waitUntil
			? (p) => waitUntil.call(executionCtx, p)
			: (p) => void p.catch((error: unknown) => this.log.error({ err: error }, "background task failed"))
	}

	/** The peer the platform reports, canonical (H23): CF-Connecting-IP on Workers, the socket on Bun and Node. */
	get ip(): string | null {
		return ipOf(this[REQUEST])
	}

	/**
	 * This request's logger: a child of the app's that binds method, path (without its query), route
	 * id, and the request id when one is set. Built on first use.
	 */
	get log(): Logger {
		this.#log ??= this[REQUEST].logger.child(
			requestBindings(this.req.method, this.path, this.#routeId, (this as { requestId?: string }).requestId),
		)
		return this.#log
	}

	get cookies(): Record<string, string> {
		this.#cookies ??= parseCookieHeader(this.req.headers.get("cookie") ?? "")
		return this.#cookies
	}

	/** The request headers as a record: keys are lower-case and request data, so no prototype. */
	get headers(): Record<string, string> {
		if (this.#headers === null) {
			const out = dict<string>()
			for (const [key, value] of this.req.headers) out[key] = value
			this.#headers = out
		}
		return this.#headers
	}

	/** The query: the first value of each key. Keys are request data, so no prototype. */
	get search(): Record<string, string> {
		if (this.#search === null) this.#parseSearch()
		return this.#search as Record<string, string>
	}

	/** The query: every value of each key, in order. */
	get searchAll(): Record<string, string[]> {
		if (this.#searchAll === null) this.#parseSearch()
		return this.#searchAll as Record<string, string[]>
	}

	/**
	 * Aborts when the client disconnects or the server shuts down. Pass it to `fetch()`, database
	 * drivers and timers so abandoned work stops.
	 */
	get signal(): AbortSignal {
		this.#ac ??= this.#linkSignal()
		return this.#ac.signal
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
			return ac
		}
		if (request?.aborted) ac.abort(request.reason)
		else request?.addEventListener("abort", () => ac.abort(request.reason), { once: true })
		return ac
	}
}
