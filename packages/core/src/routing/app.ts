/**
 * The app: `honey()` and the `Honey` handle. A handle is a view (basePath, chain, context values,
 * chain meta) over one shared graph; `use()`, `basePath()`, `context()` and `meta()` return a new
 * handle on the same graph, and the settings setters apply to the whole app.
 */
import { type ExecutionCtx, type HoneyContext, isReservedCtxKey } from "../context/context.ts"
import type { MaybePromise, MiddlewareFn, RuntimeMiddleware } from "../middleware/middleware.ts"
import type { DeclaredMeta, DefaultMeta, ScopedMwEntry, WithChainMeta } from "./app-types.ts"
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
	VIEW,
} from "./register.ts"
import { type StartOf, startRoute } from "./route-builder.ts"
import type { AppSettings } from "./settings.ts"
import { RouteTreeChain } from "./route-tree.ts"
import type { HttpMethod, MergePath, PrefixRoutes } from "./types.ts"

export { GRAPH } from "./register.ts"

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
	declare readonly $basePath: TBasePath
	declare readonly $ctx: TCtx
	declare readonly $env: TEnv
	declare readonly $errorFactory: TErrorFactory
	declare readonly $meta: TMeta
	declare readonly $routes: TRoutes
	declare readonly $taps: TTaps
	readonly #graph: HoneyGraph
	/** this handle's view: read-only, reached through a symbol the package does not export */
	readonly [VIEW]: HandleView

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

	basePath<P extends string>(
		prefix: P,
	): Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors, MergePath<TBasePath, P>, TTaps, TScopedMw> {
		return this.#derive({ basePath: joinPatterns(this[VIEW].basePath, prefix) })
	}

	/** Static values every route registered through the new handle finds on `ctx`. */
	context<TAdds extends Record<string, unknown>>(
		values: TAdds,
	): Honey<TEnv, TCtx & Readonly<TAdds>, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw> {
		for (const key in values) if (isReservedCtxKey(key)) throw new Error(`context() cannot set reserved key "${key}"`)
		return this.#derive({ contextValues: { ...this[VIEW].contextValues, ...values } })
	}

	/** The app's error factory; routes mounted from another app keep that app's. */
	errorFactory<TFactory extends Record<string, (...args: never[]) => unknown>>(
		factory: TFactory,
	): Honey<TEnv, TCtx, TRoutes, TMeta, TFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw> {
		this.settings.errorFactory = factory
		this.#graph.epoch++
		return this as never
	}

	/** Error keys every route of this app declares, registered before or after the call. */
	defaultErrors<TKeys extends ([TErrorFactory] extends [never] ? never : keyof TErrorFactory & string)>(
		...keys: TKeys[]
	): Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors | TKeys, TBasePath, TTaps, TScopedMw> {
		for (const key of keys) this.settings.defaultErrorKeys.add(key)
		this.#graph.epoch++
		return this as never
	}

	/** The error an undeclared or unknown throw becomes on routes without their own `.boundary()`. */
	defaultBoundary<TKey extends ([TErrorFactory] extends [never] ? never : keyof TErrorFactory & string)>(
		key: TKey,
	): Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors | TKey, TBasePath, TTaps, TScopedMw> {
		this.settings.defaultBoundaryKey = key
		this.settings.defaultErrorKeys.add(key)
		this.#graph.epoch++
		return this as never
	}

	protected override invalidate(): void {
		this.#graph.epoch++
	}

	/** Type only: constrain what route `.meta()` accepts; declared tap keys stay allowed. */
	meta<TNewMeta extends Record<string, unknown>>(): Honey<
		TEnv,
		TCtx,
		TRoutes,
		[keyof TTaps] extends [never] ? TNewMeta : TNewMeta & Partial<TTaps>,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	>
	/**
	 * Typed chain meta, the meta type given explicitly (`meta<AppMeta>({ … })`): constrain route meta
	 * and set defaults in one call. `TNewMeta` defaults to `never`, so a call that leaves it out
	 * resolves to the next overload instead of binding it to a wide record.
	 */
	meta<
		TNewMeta extends Record<string, unknown> = never,
		TValues extends Partial<DefaultMeta> & Partial<TNewMeta> = Partial<DefaultMeta> & Partial<TNewMeta>,
	>(values: TValues): Honey<TEnv, TCtx, TRoutes, TNewMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
	/** Chain meta, merged into every route registered through the new handle; its values reach the routes' types (`internal: true`). */
	meta<
		const TValues extends Partial<DefaultMeta> &
			([DeclaredMeta<TMeta>] extends [never] ? Record<string, unknown> : Partial<DeclaredMeta<TMeta>>),
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
	>
	meta(values?: Record<string, unknown>): unknown {
		if (values === undefined) return this
		return this.#derive({ chainMeta: { ...this[VIEW].chainMeta, ...values } })
	}

	/** Chain middleware: a new handle whose routes run `mw`; this handle is unchanged. */
	use<TAdds>(
		mw: MiddlewareFn<TCtx, TAdds>,
	): Honey<TEnv, TCtx & TAdds, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
	/** Scoped middleware: runs for every request path under `path`, whichever handle registered the route. */
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
		readonly [...TScopedMw, { readonly adds: TAdds; readonly path: MergePath<TBasePath, TPath> }]
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
	 * Mount a sub-app under this handle's basePath (and `prefix`): this handle's chain runs before
	 * the sub's; the sub's own basePath stays part of each path.
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

	/** One route for several methods: one record per method. */
	on<const TPath extends string, const TMethods extends readonly [HttpMethod | "ALL", ...(HttpMethod | "ALL")[]]>(
		methods: TMethods,
		path: TPath,
	): StartOf<this, TPath, TMethods[number]> {
		const [first, ...rest] = methods
		return this.#builder(first, path, rest) as never
	}

	all<const TPath extends string>(path: TPath): StartOf<this, TPath, "ALL"> {
		return this.#builder("ALL", path) as never
	}
	delete<const TPath extends string>(path: TPath): StartOf<this, TPath, "DELETE"> {
		return this.#builder("DELETE", path) as never
	}
	get<const TPath extends string>(path: TPath): StartOf<this, TPath, "GET"> {
		return this.#builder("GET", path) as never
	}
	head<const TPath extends string>(path: TPath): StartOf<this, TPath, "HEAD"> {
		return this.#builder("HEAD", path) as never
	}
	options<const TPath extends string>(path: TPath): StartOf<this, TPath, "OPTIONS"> {
		return this.#builder("OPTIONS", path) as never
	}
	patch<const TPath extends string>(path: TPath): StartOf<this, TPath, "PATCH"> {
		return this.#builder("PATCH", path) as never
	}
	post<const TPath extends string>(path: TPath): StartOf<this, TPath, "POST"> {
		return this.#builder("POST", path) as never
	}
	put<const TPath extends string>(path: TPath): StartOf<this, TPath, "PUT"> {
		return this.#builder("PUT", path) as never
	}

	/** The Fetch handler an adapter calls. Finalizes once; a later registration re-finalizes. */
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

/** A new app typed to the runtime env `TEnv`. */
export function honey<TEnv>(): Honey<TEnv> {
	return new Honey<TEnv>()
}
