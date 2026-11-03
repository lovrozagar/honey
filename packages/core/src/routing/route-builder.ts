/**
 * The route builder: what `app.get(path)` returns. `.meta()`, `.errors()`, `.boundary()`, `.use()`,
 * `.input()` and `.output()` shape the route; `.handler()` registers it (one record per method) and
 * returns the app typed with the new route. A one-shot method disappears from the chain once called.
 */
import type { ERROR_META } from "../errors/errors.ts"
import { compileInput, type InputSchemas, type InputStep, type InputTypes } from "../input/input.ts"
import type { KnownStatusKeys, OutputSchemas } from "./output-types.ts"
import type { ErrorFactories } from "./settings.ts"
import type { MaybePromise, MiddlewareFn, RuntimeMiddleware } from "../middleware/middleware.ts"
import type { TypedResponse } from "../response/response.ts"
import type { Honey } from "./app.ts"
import type {
	ApplyScoped,
	ChainSupplied,
	ComputeErrorsByStatus,
	HoneyMeta,
	HandlerCtx,
	InitAccMeta,
	MergeRoute,
	RouteMeta,
	ScopedMwEntry,
	SkipRouteRecord,
	WithMiddlewareMeta,
} from "./app-types.ts"
import { joinPatterns, parsePattern } from "./pattern.ts"
import { addRoute, type HandleView, type HoneyGraph, type PendingRoute, type RouteSource, settle } from "./register.ts"
import type { MergePath, ParamsFromPath } from "./types.ts"

/** Everything a builder carries at the type level. */
export type BuilderTypes = {
	/** The meta accumulated for the route so far. */
	accMeta: unknown
	/** The handle's ctx, without scoped or route middleware: what the app `.handler()` returns keeps. */
	baseCtx: unknown
	/** The app's base path. */
	basePath: string
	/** The ctx the handler sees before its own declarations: the app's plus middleware added so far. */
	ctx: unknown
	/** The error keys every route of the app declares. */
	defaultErrors: string
	/** The app's environment type: what `ctx.env` holds. */
	env: unknown
	/** The error factory in effect for the route. */
	errorFactory: unknown
	/** The error keys the route declares. */
	errorKeys: string
	/** ctx.input once `.input()` ran, `never` before; `request` what a client sends, `{}` before */
	input: unknown
	/** What a client sends, once `.input()` ran. */
	request: unknown
	/** what `.output()` declares; `never` before */
	output: unknown
	/** The meta type the app handle declared; `never` when it declared none. */
	meta: unknown
	/** The route's HTTP method, or a union of them for `app.on()`. */
	method: string
	/** The route's full path, base path included. */
	path: string
	/** The routes the app has accumulated. */
	routes: unknown
	/** The path-scoped middleware of the app. */
	scopedMw: readonly ScopedMwEntry[]
	/** The tap payloads the app declared. */
	taps: Record<string, unknown>
	/** The one-shot methods already called. */
	used: string
}

/** `B` with the fields of `U` replaced. */
type Next<B extends BuilderTypes, U extends Partial<BuilderTypes>> = {
	[K in keyof BuilderTypes]: K extends keyof U ? U[K] : B[K]
}

/** The builder methods that can be called once per route. */
type OneShotKey = "boundary" | "errors" | "input" | "meta" | "output"

/** The builder with the one-shot methods already used removed. */
export type BuilderChain<B extends BuilderTypes> = Omit<RouteBuilder<B>, B["used"] & OneShotKey>

/** The keys a route may still declare: the factory's, minus the app defaults. */
type DeclarableKey<B extends BuilderTypes> = [B["errorFactory"]] extends [never]
	? never
	: Exclude<keyof B["errorFactory"] & string, B["defaultErrors"]>

/** The error metadata (body schema and status key per key) an error factory carries, or `{}`. */
type ErrorMetaOf<F> = F extends { readonly [ERROR_META]: infer M } ? M : {}

/** The route's factory once `.errors(named, ...)` ran: the named factory's keys and meta over the app's. */
type WithNamedFactory<TApp, TNamed> = [TApp] extends [never]
	? TNamed
	: Omit<TApp, keyof TNamed> &
			Omit<TNamed, typeof ERROR_META> & {
				readonly [ERROR_META]: Omit<ErrorMetaOf<TApp>, keyof ErrorMetaOf<TNamed>> & ErrorMetaOf<TNamed>
			}

/** What `.errors(named, ...keys)` changes. */
type NamedErrors<B extends BuilderTypes, TFactory, TKeys extends string> = {
	/** The route's factory with the named one laid over the app's. */
	errorFactory: WithNamedFactory<B["errorFactory"], TFactory>
	/** The route's declared keys plus the newly named ones. */
	errorKeys: B["errorKeys"] | TKeys
	/** Records `.errors()` as called, so it leaves the chain. */
	used: B["used"] | "errors"
}

/** The handler's ctx for the route `B` describes. */
export type RouteHandlerCtx<B extends BuilderTypes> = HandlerCtx<
	B["ctx"],
	ParamsFromPath<B["path"]>,
	B["accMeta"],
	B["errorFactory"],
	B["errorKeys"] | B["defaultErrors"],
	B["path"],
	B["taps"],
	B["input"],
	B["output"]
>

/** The app `.handler()` returns: the same handle, typed with the new route. */
export type HandlerReturn<B extends BuilderTypes> = Honey<
	B["env"],
	B["baseCtx"],
	SkipRouteRecord<B["accMeta"]> extends true
		? B["routes"]
		: MergeRoute<
				B["routes"],
				B["path"],
				B["method"],
				[B["input"]] extends [never] ? {} : B["input"],
				[B["output"]] extends [never] ? {} : B["output"],
				RouteHandlerCtx<B>,
				RouteMeta<B["accMeta"]>,
				B["errorKeys"] | B["defaultErrors"],
				ComputeErrorsByStatus<B["errorFactory"], B["errorKeys"] | B["defaultErrors"], typeof ERROR_META>,
				B["request"]
			>,
	B["meta"],
	B["errorFactory"],
	B["defaultErrors"],
	B["basePath"],
	B["taps"],
	B["scopedMw"]
>

/** The builder `app.get(path)` starts, from the app handle's own type. */
export type StartOf<H, TPath extends string, TMethod extends string> =
	H extends Honey<
		infer TEnv,
		infer TCtx,
		infer TRoutes,
		infer TMeta,
		infer TFactory,
		infer TDefaults extends string,
		infer TBase extends string,
		infer TTaps extends Record<string, unknown>,
		infer TScoped extends readonly ScopedMwEntry[]
	>
		? BuilderChain<{
				/** Starts from the meta the app declared, or `{}` when it declared none. */
				accMeta: InitAccMeta<TMeta>
				/** The app's ctx. */
				baseCtx: TCtx
				/** The app's base path. */
				basePath: TBase
				/** The app's ctx plus what middleware scoped to this path adds. */
				ctx: TCtx & ApplyScoped<TScoped, MergePath<TBase, TPath>>
				/** The app's default error keys. */
				defaultErrors: TDefaults
				/** The app's environment type. */
				env: TEnv
				/** The app's error factory. */
				errorFactory: TFactory
				/** No keys declared yet. */
				errorKeys: never
				/** No `.input()` yet. */
				input: never
				/** The meta type the app declared. */
				meta: TMeta
				/** No `.output()` yet. */
				output: never
				/** No client input yet. */
				request: {}
				/** The route's HTTP method, or a union of them for `app.on()`. */
				method: TMethod
				/** The route's full path, base path included. */
				path: MergePath<TBase, TPath>
				/** The routes the app has so far. */
				routes: TRoutes
				/** The app's path-scoped middleware. */
				scopedMw: TScoped
				/** The app's declared tap payloads. */
				taps: TTaps
				/** No one-shot method called yet. */
				used: never
			}>
		: never

/** What a builder carries at runtime. */
export type BuilderState = {
	/** The error key an undeclared or unknown throw becomes on this route; `null` defers to the app's. */
	readonly boundaryKey: string | null
	/** keys the route declares itself */
	readonly errorKeys: ReadonlySet<string>
	/** the factory `.errors(factory, ...keys)` named */
	readonly errorSource: ErrorFactories | null
	/** Methods registered beside `method` when the route was started with `app.on()`. */
	readonly extraMethods: readonly string[]
	/** The app graph the route registers into. */
	readonly graph: HoneyGraph
	/** `.input()`: the schemas as written (for documentation) and the step they compile to */
	readonly input: {
		/** The schemas as written, kept for documentation. */ readonly schemas: InputSchemas
		/** The compiled validation step run after the middleware. */ readonly step: InputStep
	} | null
	/** what `.output()` declared */
	readonly output: OutputSchemas | null
	/** explicit meta: chain `.meta()` overlaid by route `.meta()` */
	readonly meta: Readonly<Record<string, unknown>> | null
	/** The route's first HTTP method. */
	readonly method: string
	/** Route-level middleware added with `.use()`. */
	readonly middlewares: readonly RuntimeMiddleware[]
	/** the handle `.handler()` returns */
	readonly parent: unknown
	/** canonical full pattern */
	readonly path: string
	/** The graph's entry for this builder: `.handler()` removes it, and one left at finalize is an error. */
	readonly pending: PendingRoute
	/** What the route takes from the handle that started it: base path, chain, context values and meta. */
	readonly view: HandleView
}

/**
 * Builds one route: declare errors, meta, input, output and middleware, then register it with `.handler()`. Each of `errors`, `boundary`, `meta`, `input` and `output` can be called once: the chain's type drops it after the call.
 */
export class RouteBuilder<B extends BuilderTypes> {
	/* type only, read by codegen: the ctx middleware built (before the handler's own declarations), the methods, the full path */
	/** The ctx middleware built, before the handler's own declarations. Type only, read by codegen. */
	declare readonly $ctx: B["ctx"]
	/** The route's HTTP method, or a union of them for `app.on()`. Type only, read by codegen. */
	declare readonly $method: B["method"]
	/** The route's full path. Type only, read by codegen. */
	declare readonly $path: B["path"]
	readonly #s: BuilderState

	/** Takes the builder state; `app.get(path)` and the other method calls create builders for you. */
	constructor(state: BuilderState) {
		this.#s = state
	}

	#next<N extends BuilderTypes>(changes: Partial<BuilderState>): BuilderChain<N> {
		return new RouteBuilder<N>({ ...this.#s, ...changes }) as unknown as BuilderChain<N>
	}

	/**
	 * Declare error keys this route may throw, built from `factory` instead of the app's.
	 * With any key declared, `ctx.errors` holds only declared keys, and a thrown `HoneyError` with another key
	 * (honey's own keys excepted) answers as the boundary error, or a 500.
	 */
	errors<
		TFactory extends Record<string, (...args: never[]) => unknown>,
		TKeys extends Exclude<keyof TFactory & string, B["defaultErrors"]>,
	>(factory: TFactory, ...keys: TKeys[]): BuilderChain<Next<B, NamedErrors<B, TFactory, TKeys>>>
	/**
	 * Declare keys of the app's error factory that this route may throw.
	 * With any key declared, `ctx.errors` holds only declared keys, and a thrown `HoneyError` with another key
	 * (honey's own keys excepted) answers as the boundary error, or a 500.
	 */
	errors<TKeys extends DeclarableKey<B>>(
		...keys: TKeys[]
	): BuilderChain<
		Next<
			B,
			{
				/** The route's declared keys plus the new ones. */ errorKeys: B["errorKeys"] | TKeys
				/** Records `.errors()` as called. */ used: B["used"] | "errors"
			}
		>
	>
	errors(...args: unknown[]): unknown {
		const named = typeof args[0] === "object" && args[0] !== null ? (args[0] as ErrorFactories) : null
		const keys = (named === null ? args : args.slice(1)) as string[]
		return this.#next({ errorKeys: new Set([...this.#s.errorKeys, ...keys]), errorSource: named })
	}

	/** The error an undeclared or unknown throw becomes on this route. */
	boundary<TKey extends DeclarableKey<B>>(
		key: TKey,
	): BuilderChain<
		Next<
			B,
			{
				/** The route's declared keys plus the boundary key. */ errorKeys: B["errorKeys"] | TKey
				/** Records `.boundary()` as called. */ used: B["used"] | "boundary"
			}
		>
	> {
		return this.#next({ boundaryKey: key, errorKeys: new Set([...this.#s.errorKeys, key]) })
	}

	/** Set the route's meta, merged over the chain's. A repeated `invalidate` entry is removed. */
	meta<TRouteMeta extends HoneyMeta & ([B["meta"]] extends [never] ? {} : ChainSupplied<B["meta"]>)>(
		meta: TRouteMeta,
	): BuilderChain<
		Next<
			B,
			{
				/** The meta accumulated so far plus these values. */ accMeta: B["accMeta"] & TRouteMeta
				/** Records `.meta()` as called. */ used: B["used"] | "meta"
			}
		>
	> {
		const merged: Record<string, unknown> = { ...this.#s.meta, ...meta }
		const invalidate = merged.invalidate
		if (Array.isArray(invalidate) && invalidate.length > 1) merged.invalidate = [...new Set(invalidate)]
		return this.#next({ meta: merged })
	}

	/** Validate params, query, headers, cookies and one body onto ctx.input: the first failure is a 400 (415). */
	input<const TSchemas extends InputSchemas>(
		schemas: TSchemas,
	): BuilderChain<
		Next<
			B,
			InputTypes<TSchemas> & {
				/** Records `.input()` as called. */ used: B["used"] | "input"
			}
		>
	> {
		const step = compileInput(schemas, [this.#s.method, ...this.#s.extraMethods], this.#s.path)
		return this.#next({ input: { schemas, step } })
	}

	/** Declare what the route answers: ctx.res narrows to it, and `outputValidation` checks it. */
	output<const TOutput extends OutputSchemas>(
		schemas: TOutput & KnownStatusKeys<TOutput>,
	): BuilderChain<
		Next<
			B,
			{
				/** The declared output. */ output: TOutput
				/** Records `.output()` as called. */ used: B["used"] | "output"
			}
		>
	> {
		return this.#next({ output: schemas })
	}

	/** Route-level middleware, after the chain and the scopes; the meta it gives counts as supplied for `.meta()`. */
	use<TAdds, TMwMeta = {}>(
		mw: MiddlewareFn<B["ctx"], TAdds, string, TMwMeta>,
	): BuilderChain<
		Next<
			B,
			{
				/** The ctx plus what the middleware adds. */ ctx: B["ctx"] & TAdds
				/** The handle's meta, with what the middleware gives counted as supplied. */
				meta: WithMiddlewareMeta<B["meta"], TMwMeta>
			}
		>
	> {
		return this.#next({ middlewares: [...this.#s.middlewares, mw as unknown as RuntimeMiddleware] })
	}

	/** Register the route, once per method, and return the app typed with it. Throws on a route already registered. */
	handler(fn: (ctx: RouteHandlerCtx<B>) => MaybePromise<TypedResponse>): HandlerReturn<B> {
		const s = this.#s
		settle(s.graph, s.pending, s.view.node)
		const source: RouteSource = {
			cm: s.view.chain,
			cv: s.view.contextValues,
			dk: s.errorKeys,
			ef: s.errorSource,
			fn: fn as unknown as RouteSource["fn"],
			in: s.input?.step ?? null,
			iv: s.input?.schemas ?? null,
			out: s.output,
			own: s.graph.settings,
			rb: s.boundaryKey,
			rm: s.middlewares,
			xm: s.meta,
		}
		const segments = parsePattern(s.path)
		for (const method of [s.method, ...s.extraMethods]) addRoute(s.graph, method, segments, source)
		return s.parent as HandlerReturn<B>
	}
}

/** The builder for `method` (and `extraMethods`) at `path` under `view`'s basePath, pending until `.handler()`. */
export function startRoute(
	graph: HoneyGraph,
	view: HandleView,
	parent: unknown,
	route: { readonly extraMethods: readonly string[]; readonly method: string; readonly path: string },
): unknown {
	const fullPath = joinPatterns(view.basePath, route.path)
	const pending: PendingRoute = { id: `${[route.method, ...route.extraMethods].join(",")} ${fullPath}` }
	graph.pending.add(pending)
	return new RouteBuilder({
		boundaryKey: null,
		errorKeys: new Set(),
		errorSource: null,
		extraMethods: route.extraMethods,
		graph,
		input: null,
		meta: view.chainMeta,
		method: route.method,
		output: null,
		middlewares: [],
		parent,
		path: fullPath,
		pending,
		view,
	})
}
