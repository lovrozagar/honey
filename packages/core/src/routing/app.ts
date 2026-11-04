/**
 * The app: `honey()` and the `Honey` handle. A handle is a view (basePath, chain, context values,
 * chain meta) over one shared graph; `use()`, `basePath()`, `context()` and `meta()` return a new
 * handle on the same graph, and the settings setters apply to the whole app.
 */
import { type ExecutionCtx, type HoneyContext, isReservedCtxKey } from "../context/context.ts"
import type { MaybePromise, MiddlewareFn, RuntimeMiddleware } from "../middleware/middleware.ts"
import type { DeclaredMeta, HoneyMeta, ScopedMwEntry, WithChainMeta, WithMiddlewareMeta } from "./app-types.ts"
import { dispatch } from "./dispatch.ts"
import { joinPatterns } from "./pattern.ts"
import {
	addChain,
	addScope,
	createGraph,
	GRAPH,
	type HandleView,
	type HoneyGraph,
	markUsed,
	mount,
	ROOT_VIEW,
	SEED,
	VIEW,
} from "./register.ts"
import { type StartOf, startRoute } from "./route-builder.ts"
import type { Preset } from "./preset.ts"
import type { AppSettings } from "./settings.ts"
import { RouteTreeChain } from "./route-tree.ts"
import type { HttpMethod, MergePath, PrefixRoutes } from "./types.ts"

export { GRAPH } from "./register.ts"

/**
 * An app handle. Start a route with `get`, `post` or another method call and register it with `.handler()`, mount
 * sub-apps with `route`, and serve through `fetch`. `use()`, `basePath()`, `context()` and `meta(values)` return a new
 * handle on the same app and leave this one's chain, base path and values as they were; a scope from `use(path, mw)`
 * still covers the whole app, this handle's routes included. Create an app with `honey()`.
 */
export class Honey<
	TEnv,
	TCtx = HoneyContext<TEnv>,
	TRoutes = {},
	TMeta = never,
	TErrorFactory = never,
	TDefaultErrors extends string = never,
	TBasePath extends string = "/",
	TTaps extends Record<string, unknown> = {},
	TScopedMw extends readonly ScopedMwEntry[] = [],
> extends RouteTreeChain<TEnv> {
	/** The handle's base path; `/` until `basePath()` sets one. Type only. */
	declare readonly $basePath: TBasePath
	/** The ctx type routes of this app start from. Type only. */
	declare readonly $ctx: TCtx
	/** The env type given to `honey<TEnv>()`. Type only. */
	declare readonly $env: TEnv
	/** The type of the factory set with `errorFactory()`; `never` until then. Type only. */
	declare readonly $errorFactory: TErrorFactory
	/** The route meta type declared with `metaType<T>()`; `never` until then. Type only. */
	declare readonly $meta: TMeta
	/** The routes registered so far, by path and method, without `internal` ones. Type only; the generated client reads it. */
	declare readonly $routes: TRoutes
	/** The declared tap payloads. Type only. */
	declare readonly $taps: TTaps
	readonly #graph: HoneyGraph
	/** this handle's view: read-only, reached through a symbol the package does not export */
	readonly [VIEW]: HandleView

	/** Without arguments, starts a new app, as `honey()` does; the arguments are for the handles honey derives itself. */
	constructor(graph: HoneyGraph = createGraph(), view: HandleView = ROOT_VIEW) {
		super(graph.settings as AppSettings<TEnv>)
		this.#graph = graph
		this[VIEW] = view
	}

	get [GRAPH](): HoneyGraph {
		return this.#graph
	}

	/** A new handle on the same graph with part of this handle's view replaced. */
	#derive(changes: Partial<HandleView>): never {
		return new Honey<TEnv>(this.#graph, { ...this[VIEW], ...changes }) as never
	}

	/**
	 * A new handle whose routes register under `prefix`, joined to the current base path. Throws on an invalid pattern,
	 * which includes joining onto a base path that ends in a wildcard or an optional parameter.
	 */
	basePath<P extends string>(
		prefix: P,
	): Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors, MergePath<TBasePath, P>, TTaps, TScopedMw> {
		return this.#derive({ basePath: joinPatterns(this[VIEW].basePath, prefix) })
	}

	/**
	 * Static values every route registered or mounted through the new handle finds on `ctx`. They are not set on a 404, a
	 * 405 or a CORS preflight, even for middleware those run. Throws on a name honey keeps for itself, such as `env`.
	 */
	context<TAdds extends Record<string, unknown>>(
		values: TAdds,
	): Honey<TEnv, TCtx & Readonly<TAdds>, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw> {
		for (const key in values) if (isReservedCtxKey(key)) throw new Error(`context() cannot set reserved key "${key}"`)
		return this.#derive({ contextValues: { ...this[VIEW].contextValues, ...values } })
	}

	protected override invalidate(): void {
		this.#graph.epoch++
	}

	protected override onGraph(graph: HoneyGraph): this {
		return new Honey<TEnv>(graph, this[VIEW]) as never
	}

	/**
	 * Chain meta, merged into every route registered or mounted through the new handle; a route's own `.meta()` wins. Its
	 * values reach the routes' types with their literal types (`internal: true`, `worker: "extract"`).
	 */
	meta<
		const TValues extends HoneyMeta<
			[DeclaredMeta<TMeta>] extends [never] ? Record<string, unknown> : Partial<DeclaredMeta<TMeta>>
		>,
	>(
		values: TValues,
	): Honey<
		TEnv,
		TCtx,
		TRoutes,
		WithChainMeta<TMeta, TValues>,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		return this.#derive({ chainMeta: { ...this[VIEW].chainMeta, ...values } }) as never
	}

	/**
	 * Chain middleware: a new handle whose routes run `mw`; this handle is unchanged. It also runs on a 404 or 405 when
	 * every route starts with it. If nothing registers, mounts or serves through the new handle, the first request throws.
	 */
	use<TAdds, TMwMeta = {}>(
		mw: MiddlewareFn<TCtx, TAdds, string, TMwMeta>,
	): Honey<
		TEnv,
		TCtx & TAdds,
		TRoutes,
		WithMiddlewareMeta<TMeta, TMwMeta>,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	>
	/**
	 * Scoped middleware: runs for every request path under `path`, rebased on this handle's base path and matched by whole
	 * segments, whichever handle registered the route and whether before or after this call. A 404 or 405 under it runs it
	 * too. On a route it runs after the chain and before route middleware. Throws on an invalid pattern.
	 */
	use<const TPath extends string, TAdds>(
		path: TPath,
		mw: MiddlewareFn<TCtx, TAdds>,
	): Honey<
		TEnv,
		TCtx,
		TRoutes,
		TMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		readonly [
			...TScopedMw,
			{
				/** The properties the middleware adds to the ctx. */ readonly adds: TAdds
				/** The path the middleware is scoped to, under the base path. */ readonly path: MergePath<TBasePath, TPath>
			},
		]
	>
	use(pathOrMw: string | MiddlewareFn<never, unknown>, scopedMw?: MiddlewareFn<never, unknown>): unknown {
		if (typeof pathOrMw === "string") {
			addScope(this.#graph, this[VIEW].basePath, pathOrMw, scopedMw as unknown as RuntimeMiddleware)
			return this.#derive({})
		}
		const mw = pathOrMw as unknown as RuntimeMiddleware
		return this.#derive({ chain: [...this[VIEW].chain, mw], node: addChain(this.#graph, this[VIEW].node, mw) })
	}

	/**
	 * Mount a sub-app under this handle's basePath: this handle's chain runs before the sub's; the sub's own basePath stays
	 * part of each path. The routes are copied now, so ones the sub registers later are not served here. They keep the
	 * sub's error factory and taps; its other settings, such as `onError`, do not apply. Returns this handle. Throws a
	 * `TypeError` when `sub` is not an app, and an `Error` on a route this app already has, or when the sub left a `use()`
	 * handle unused or a route without `.handler()`. Mounting a handle of this same app does nothing.
	 */
	route<TSubRoutes, TSubMeta, TSubFactory, TSubDefaults extends string, TSubBase extends string>(
		sub: Honey<TEnv, TCtx, TSubRoutes, TSubMeta, TSubFactory, TSubDefaults, TSubBase>,
	): Honey<
		TEnv,
		TCtx,
		TRoutes & PrefixRoutes<TBasePath, TSubRoutes>,
		TMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	>
	/**
	 * Mount a sub-app under this handle's basePath joined with `prefix`: this handle's chain runs before the sub's; the
	 * sub's own basePath stays part of each path. The routes are copied now, so ones the sub registers later are not served
	 * here. They keep the sub's error factory and taps; its other settings, such as `onError`, do not apply. Returns this
	 * handle. Throws a `TypeError` when `sub` is not an app, and an `Error` on an invalid `prefix`, on a route this app
	 * already has, or when the sub left a `use()` handle unused or a route without `.handler()`. Mounting a handle of this
	 * same app does nothing.
	 */
	route<
		const TPrefix extends string,
		TSubRoutes,
		TSubMeta,
		TSubFactory,
		TSubDefaults extends string,
		TSubBase extends string,
	>(
		prefix: TPrefix,
		sub: Honey<TEnv, TCtx, TSubRoutes, TSubMeta, TSubFactory, TSubDefaults, TSubBase>,
	): Honey<
		TEnv,
		TCtx,
		TRoutes & PrefixRoutes<MergePath<TBasePath, TPrefix>, TSubRoutes>,
		TMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	>
	route(prefixOrSub: unknown, maybeSub?: unknown): unknown {
		if (typeof prefixOrSub === "string") {
			if (!(maybeSub instanceof Honey)) throw new TypeError("honey: route(prefix, sub) needs the sub-app")
			markUsed(this[VIEW].node)
			;(this.basePath(prefixOrSub) as unknown as Honey<TEnv>).#mount(maybeSub as Honey<TEnv>)
			return this
		}
		return this.#mount(prefixOrSub as Honey<TEnv>)
	}

	#mount(sub: Honey<TEnv>): this {
		markUsed(this[VIEW].node)
		markUsed(sub[VIEW].node)
		mount(this.#graph, this[VIEW], sub.#graph)
		return this
	}

	#builder(method: string, path: string, extraMethods: readonly string[] = []): unknown {
		return startRoute(this.#graph, this[VIEW], this, { extraMethods, method, path })
	}

	/**
	 * Start one route at `path`, under this handle's base path, for each of `methods`. Throws on an invalid pattern.
	 * `.handler()` registers them all and throws on a duplicate; routes left without it make the first request throw.
	 */
	on<const TPath extends string, const TMethods extends readonly [HttpMethod | "ALL", ...(HttpMethod | "ALL")[]]>(
		methods: TMethods,
		path: TPath,
	): StartOf<this, TPath, TMethods[number]> {
		const [first, ...rest] = methods
		return this.#builder(first, path, rest) as never
	}

	/**
	 * Start a route at `path`, under this handle's base path, for every method with no route of its own there. `OPTIONS`
	 * counts, so it also answers CORS preflights for the path; `HEAD` goes to a `GET` route on the path first. Throws on an
	 * invalid pattern. `.handler()` registers it and throws on a duplicate; a route left without it makes the first request
	 * throw.
	 */
	all<const TPath extends string>(path: TPath): StartOf<this, TPath, "ALL"> {
		return this.#builder("ALL", path) as never
	}
	/**
	 * Start a `DELETE` route at `path`, under this handle's base path. Throws on an invalid pattern. `.handler()`
	 * registers it and throws on a duplicate; a route left without it makes the first request throw.
	 */
	delete<const TPath extends string>(path: TPath): StartOf<this, TPath, "DELETE"> {
		return this.#builder("DELETE", path) as never
	}
	/**
	 * Start a `GET` route at `path`, under this handle's base path. It also answers HEAD requests, without the body, when
	 * the path has no `HEAD` route. Throws on an invalid pattern. `.handler()` registers it and throws on a duplicate; a
	 * route left without it makes the first request throw.
	 */
	get<const TPath extends string>(path: TPath): StartOf<this, TPath, "GET"> {
		return this.#builder("GET", path) as never
	}
	/**
	 * Start a `HEAD` route at `path`, under this handle's base path. It takes over HEAD from a `GET` route, and its answer
	 * goes out without a body. Throws on an invalid pattern. `.handler()` registers it and throws on a duplicate; a route
	 * left without it makes the first request throw.
	 */
	head<const TPath extends string>(path: TPath): StartOf<this, TPath, "HEAD"> {
		return this.#builder("HEAD", path) as never
	}
	/**
	 * Start an `OPTIONS` route at `path`, under this handle's base path. It takes over the path's CORS preflight: the chain
	 * of the route the preflight asks about does not run. Throws on an invalid pattern. `.handler()` registers it and throws
	 * on a duplicate; a route left without it makes the first request throw.
	 */
	options<const TPath extends string>(path: TPath): StartOf<this, TPath, "OPTIONS"> {
		return this.#builder("OPTIONS", path) as never
	}
	/**
	 * Start a `PATCH` route at `path`, under this handle's base path. Throws on an invalid pattern. `.handler()`
	 * registers it and throws on a duplicate; a route left without it makes the first request throw.
	 */
	patch<const TPath extends string>(path: TPath): StartOf<this, TPath, "PATCH"> {
		return this.#builder("PATCH", path) as never
	}
	/**
	 * Start a `POST` route at `path`, under this handle's base path. Throws on an invalid pattern. `.handler()`
	 * registers it and throws on a duplicate; a route left without it makes the first request throw.
	 */
	post<const TPath extends string>(path: TPath): StartOf<this, TPath, "POST"> {
		return this.#builder("POST", path) as never
	}
	/**
	 * Start a `PUT` route at `path`, under this handle's base path. Throws on an invalid pattern. `.handler()`
	 * registers it and throws on a duplicate; a route left without it makes the first request throw.
	 */
	put<const TPath extends string>(path: TPath): StartOf<this, TPath, "PUT"> {
		return this.#builder("PUT", path) as never
	}

	/**
	 * The Fetch handler an adapter calls, serving the whole app whichever handle it is called on. Call it as a method:
	 * detached, as in `{ fetch: app.fetch }`, it throws a `TypeError`. Finalizes once; a later registration re-finalizes.
	 * Throws synchronously when the app cannot finalize, such as a route without `.handler()`, a `use()` handle nothing
	 * used, or `requestLog()` with `logger(false)`.
	 */
	fetch(request: Request, env: TEnv, executionCtx?: ExecutionCtx): MaybePromise<Response> {
		const g = this.#graph
		if (!g.served.has(this[VIEW].chain)) {
			markUsed(this[VIEW].node)
			g.served.add(this[VIEW].chain)
			g.epoch++
		}
		return dispatch(g, request, env, executionCtx)
	}
}

/**
 * A new app started from `preset` (`definePreset()`): its own copy of the preset's settings, its chain middleware first
 * on every route, and the types they give. A setter on the app, or on the preset later, changes neither the other nor
 * another app started from it.
 */
export function honey<TEnv, TCtx, TMeta, TFactory, TDefaults extends string, TTaps extends Record<string, unknown>>(
	preset: Preset<TEnv, TCtx, TMeta, TFactory, TDefaults, TTaps>,
): Honey<TEnv, TCtx, {}, TMeta, TFactory, TDefaults, "/", TTaps>
/* last, so `ReturnType<typeof honey>` is the plain app */
/** A new app typed to the runtime env `TEnv`. */
export function honey<TEnv>(): Honey<TEnv>
export function honey<TEnv>(preset?: Preset<TEnv, unknown, unknown, unknown, string, {}>): Honey<TEnv> {
	return preset?.[SEED]() ?? new Honey<TEnv>()
}
