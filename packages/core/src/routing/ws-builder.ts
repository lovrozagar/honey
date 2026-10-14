/**
 * The WebSocket route builder: what `app.ws(path)` returns. A ws route is an ordinary route record
 * with method `WS`, so the chain, the scopes, meta and error declarations work as on any route; its
 * handler is the upgrade itself. The origin check and the chain run first, so a refused upgrade is
 * answered before any 101 (H18.12). `.input()` arrives with the input layer at bit 08.
 */
import { type HoneyContext, REQUEST } from "../context/context.ts"
import { HoneyError } from "../errors/error.ts"
import type { MiddlewareFn, RuntimeMiddleware } from "../middleware/middleware.ts"
import type { WSAdapter, WSHandler } from "../ws/contract.ts"
import { originAllowed, validateOriginPolicy, type WSOriginPolicy } from "../ws/origin.ts"
import { createWsSession } from "../ws/session.ts"
import { joinPatterns, parsePattern } from "./pattern.ts"
import { addRoute, type HandleView, type HoneyGraph, type PendingRoute, settle } from "./register.ts"
import type { ErrorFactories } from "./settings.ts"
import type { ParamsFromPath } from "./types.ts"

/** The ctx a ws route's callbacks receive: the chain's ctx with the route's params. */
export type WSRouteCtx<TCtx, TPath extends string> = TCtx & { readonly params: ParamsFromPath<TPath> }

type WSBuilderState = {
	readonly errorKeys: ReadonlySet<string>
	readonly errorSource: ErrorFactories | null
	readonly graph: HoneyGraph
	readonly meta: Readonly<Record<string, unknown>> | null
	readonly middlewares: readonly RuntimeMiddleware[]
	readonly origins: WSOriginPolicy | null
	readonly parent: unknown
	readonly path: string
	readonly pending: PendingRoute
	readonly view: HandleView
}

const NO_ADAPTER =
	"honey: a WebSocket route was requested but no adapter is set: call app.wsAdapter(adapter), or serve(app) on Node or Bun"

/** The route's terminal: check the origin, then hand the request to the serving app's adapter. */
function upgrader(callbacks: WSHandler<unknown>, policy: WSOriginPolicy | null, route: string) {
	return async (ctx: object): Promise<Response> => {
		const context = ctx as HoneyContext<unknown>
		const req = context.req
		const url = new URL(req.url)
		const credentialed = req.headers.has("cookie") || req.headers.has("authorization")
		/* the full origin, scheme + host + port, as the adapter's canonical URL spells it */
		if (!originAllowed(policy, req.headers.get("origin"), url.origin, credentialed)) {
			throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
		}
		/* the serving app's adapter: dispatch puts it on the request state of a ws request */
		const adapter = (context[REQUEST] as { ws?: WSAdapter | null }).ws
		if (adapter == null) throw new Error(NO_ADAPTER)
		const reconnectToken = url.searchParams.get("reconnect_token")
		const handler = createWsSession({ callbacks, ctx, log: null, reconnectToken, route })
		return (await adapter.upgrade(req, context.env, handler)).response
	}
}

export class WSRouteBuilder<TCtx, TPath extends string, TParent> {
	readonly #s: WSBuilderState

	constructor(state: WSBuilderState) {
		this.#s = state
	}

	#next<C = TCtx>(changes: Partial<WSBuilderState>): WSRouteBuilder<C, TPath, TParent> {
		return new WSRouteBuilder<C, TPath, TParent>({ ...this.#s, ...changes })
	}

	/** Declare the error keys this route may throw, from a factory or the app's. */
	errors(
		factory: Record<string, (...args: never[]) => unknown>,
		...keys: string[]
	): WSRouteBuilder<TCtx, TPath, TParent>
	errors(...keys: string[]): WSRouteBuilder<TCtx, TPath, TParent>
	errors(...args: unknown[]): WSRouteBuilder<TCtx, TPath, TParent> {
		const named = typeof args[0] === "object" && args[0] !== null ? (args[0] as ErrorFactories) : null
		const keys = (named === null ? args : args.slice(1)) as string[]
		return this.#next({ errorKeys: new Set([...this.#s.errorKeys, ...keys]), errorSource: named })
	}

	meta(meta: Record<string, unknown>): WSRouteBuilder<TCtx, TPath, TParent> {
		return this.#next({ meta: { ...this.#s.meta, ...meta } })
	}

	/**
	 * Browser origins allowed to open this socket: `"*"`, a list of origins, or a predicate.
	 * Same-origin (scheme, host and port) always passes. Without it, a cross-origin upgrade that
	 * carries `Cookie` or `Authorization` gets 403.
	 */
	origins(policy: WSOriginPolicy): WSRouteBuilder<TCtx, TPath, TParent> {
		return this.#next({ origins: validateOriginPolicy(policy) })
	}

	/** Route-level middleware, after the chain and the scopes, before the upgrade. */
	use<TAdds>(mw: MiddlewareFn<TCtx, TAdds>): WSRouteBuilder<TCtx & TAdds, TPath, TParent> {
		return this.#next<TCtx & TAdds>({ middlewares: [...this.#s.middlewares, mw as unknown as RuntimeMiddleware] })
	}

	/** Register the route with its connection callbacks and return the app. */
	handler(callbacks: WSHandler<WSRouteCtx<TCtx, TPath>>): TParent {
		const s = this.#s
		settle(s.graph, s.pending, s.view.node)
		addRoute(s.graph, "WS", parsePattern(s.path), {
			cm: s.view.chain,
			cv: s.view.contextValues,
			dk: s.errorKeys,
			ef: s.errorSource,
			fn: upgrader(callbacks as WSHandler<unknown>, s.origins, s.path),
			own: s.graph.settings,
			rb: null,
			rm: s.middlewares,
			xm: s.meta,
		})
		return s.parent as TParent
	}
}

/** The builder `app.ws(path)` starts on `view`'s handle, pending until `.handler()`. */
export function startWsRoute<TCtx, TPath extends string, TParent>(
	graph: HoneyGraph,
	view: HandleView,
	parent: TParent,
	path: string,
): WSRouteBuilder<TCtx, TPath, TParent> {
	const fullPath = joinPatterns(view.basePath, path)
	const pending: PendingRoute = { id: `WS ${fullPath}` }
	graph.pending.add(pending)
	return new WSRouteBuilder({
		errorKeys: new Set(),
		errorSource: null,
		graph,
		meta: view.chainMeta,
		middlewares: [],
		origins: null,
		parent,
		path: fullPath,
		pending,
		view,
	})
}
