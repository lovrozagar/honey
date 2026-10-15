/**
 * The route builder: what `app.get(path)` returns. `.meta()`, `.errors()`, `.boundary()`, `.use()`,
 * `.input()` and `.output()` shape the route; `.handler()` registers it (one record per method) and
 * returns the app typed with the new route. A one-shot method disappears from the chain once called.
 */
import type { ERROR_META } from "../errors/errors.ts"
import { compileInput, type InferInputMap, type InputSchemas, type InputStep } from "../input/input.ts"
import type { KnownStatusKeys, OutputSchemas } from "./output-types.ts"
import type { ErrorFactories } from "./settings.ts"
import type { MaybePromise, MiddlewareFn, RuntimeMiddleware } from "../middleware/middleware.ts"
import type { TypedResponse } from "../response/response.ts"
import type { Honey } from "./app.ts"
import type {
	ApplyScoped,
	ComputeErrorsByStatus,
	DefaultMeta,
	HandlerCtx,
	InitAccMeta,
	MergeRoute,
	RouteMeta,
	ScopedMwEntry,
	SkipRouteRecord,
} from "./app-types.ts"
import { joinPatterns, parsePattern } from "./pattern.ts"
import { addRoute, type HandleView, type HoneyGraph, type PendingRoute, type RouteSource, settle } from "./register.ts"
import type { MergePath, ParamsFromPath } from "./types.ts"

/** Everything a builder carries at the type level. */
export type BuilderTypes = {
	accMeta: unknown
	baseCtx: unknown
	basePath: string
	ctx: unknown
	defaultErrors: string
	env: unknown
	errorFactory: unknown
	errorKeys: string
	/** ctx.input once `.input()` ran; `never` before */
	input: unknown
	/** what `.output()` declares; `never` before */
	output: unknown
	meta: unknown
	method: string
	path: string
	routes: unknown
	scopedMw: readonly ScopedMwEntry[]
	taps: Record<string, unknown>
	used: string
}

/** `B` with the fields of `U` replaced. */
type Next<B extends BuilderTypes, U extends Partial<BuilderTypes>> = {
	[K in keyof BuilderTypes]: K extends keyof U ? U[K] : B[K]
}

type OneShotKey = "boundary" | "errors" | "input" | "meta" | "output"

/** The builder with the one-shot methods already used removed. */
export type BuilderChain<B extends BuilderTypes> = Omit<RouteBuilder<B>, B["used"] & OneShotKey>

/** The keys a route may still declare: the factory's, minus the app defaults. */
type DeclarableKey<B extends BuilderTypes> = [B["errorFactory"]] extends [never]
	? never
	: Exclude<keyof B["errorFactory"] & string, B["defaultErrors"]>

type ErrorMetaOf<F> = F extends { readonly [ERROR_META]: infer M } ? M : {}

/** The route's factory once `.errors(named, ...)` ran: the named factory's keys and meta over the app's. */
type WithNamedFactory<TApp, TNamed> = [TApp] extends [never]
	? TNamed
	: Omit<TApp, keyof TNamed> &
			Omit<TNamed, typeof ERROR_META> & {
				readonly [ERROR_META]: Omit<ErrorMetaOf<TApp>, keyof ErrorMetaOf<TNamed>> & ErrorMetaOf<TNamed>
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
				ComputeErrorsByStatus<B["errorFactory"], B["errorKeys"] | B["defaultErrors"], typeof ERROR_META>
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
				accMeta: InitAccMeta<TMeta>
				baseCtx: TCtx
				basePath: TBase
				ctx: TCtx & ApplyScoped<TScoped, MergePath<TBase, TPath>>
				defaultErrors: TDefaults
				env: TEnv
				errorFactory: TFactory
				errorKeys: never
				input: never
				meta: TMeta
				output: never
				method: TMethod
				path: MergePath<TBase, TPath>
				routes: TRoutes
				scopedMw: TScoped
				taps: TTaps
				used: never
			}>
		: never

/** What a builder carries at runtime. */
export type BuilderState = {
	readonly boundaryKey: string | null
	/** keys the route declares itself */
	readonly errorKeys: ReadonlySet<string>
	/** the factory `.errors(factory, ...keys)` named */
	readonly errorSource: ErrorFactories | null
	readonly extraMethods: readonly string[]
	readonly graph: HoneyGraph
	/** the compiled `.input()` step */
	readonly input: InputStep | null
	/** what `.output()` declared */
	readonly output: OutputSchemas | null
	/** explicit meta: chain `.meta()` overlaid by route `.meta()` */
	readonly meta: Readonly<Record<string, unknown>> | null
	readonly method: string
	readonly middlewares: readonly RuntimeMiddleware[]
	/** the handle `.handler()` returns */
	readonly parent: unknown
	/** canonical full pattern */
	readonly path: string
	readonly pending: PendingRoute
	readonly view: HandleView
}

/** A new route's error declarations: no keys, no boundary, no named factory. */
export function undeclared(): Pick<BuilderState, "boundaryKey" | "errorKeys" | "errorSource"> {
	return { boundaryKey: null, errorKeys: new Set(), errorSource: null }
}

export class RouteBuilder<B extends BuilderTypes> {
	readonly #s: BuilderState

	constructor(state: BuilderState) {
		this.#s = state
	}

	#next<N extends BuilderTypes>(changes: Partial<BuilderState>): BuilderChain<N> {
		return new RouteBuilder<N>({ ...this.#s, ...changes }) as unknown as BuilderChain<N>
	}

	/** Declare the error keys this route may throw, from a factory or the app's. */
	errors<
		TFactory extends Record<string, (...args: never[]) => unknown>,
		TKeys extends Exclude<keyof TFactory & string, B["defaultErrors"]>,
	>(
		factory: TFactory,
		...keys: TKeys[]
	): BuilderChain<
		Next<
			B,
			{
				errorFactory: WithNamedFactory<B["errorFactory"], TFactory>
				errorKeys: B["errorKeys"] | TKeys
				used: B["used"] | "errors"
			}
		>
	>
	errors<TKeys extends DeclarableKey<B>>(
		...keys: TKeys[]
	): BuilderChain<Next<B, { errorKeys: B["errorKeys"] | TKeys; used: B["used"] | "errors" }>>
	errors(...args: unknown[]): unknown {
		const named = typeof args[0] === "object" && args[0] !== null ? (args[0] as ErrorFactories) : null
		const keys = (named === null ? args : args.slice(1)) as string[]
		return this.#next({ errorKeys: new Set([...this.#s.errorKeys, ...keys]), errorSource: named })
	}

	/** The error an undeclared or unknown throw becomes on this route. */
	boundary<TKey extends DeclarableKey<B>>(
		key: TKey,
	): BuilderChain<Next<B, { errorKeys: B["errorKeys"] | TKey; used: B["used"] | "boundary" }>> {
		return this.#next({ boundaryKey: key, errorKeys: new Set([...this.#s.errorKeys, key]) })
	}

	meta<TRouteMeta extends Partial<DefaultMeta> & ([B["meta"]] extends [never] ? {} : B["meta"])>(
		meta: TRouteMeta,
	): BuilderChain<Next<B, { accMeta: B["accMeta"] & TRouteMeta; used: B["used"] | "meta" }>> {
		const merged: Record<string, unknown> = { ...this.#s.meta, ...meta }
		const invalidate = merged.invalidate
		if (Array.isArray(invalidate) && invalidate.length > 1) merged.invalidate = [...new Set(invalidate)]
		return this.#next({ meta: merged })
	}

	/** Validate params, query, headers, cookies and one body onto ctx.input: the first failure is a 400 (415). */
	input<const TSchemas extends InputSchemas>(
		schemas: TSchemas,
	): BuilderChain<Next<B, { input: InferInputMap<TSchemas>; used: B["used"] | "input" }>> {
		const s = this.#s
		return this.#next({ input: compileInput(schemas, [s.method, ...s.extraMethods], s.path) })
	}

	/** Declare what the route answers: ctx.res narrows to it, and `outputValidation` checks it. */
	output<const TOutput extends OutputSchemas>(
		schemas: TOutput & KnownStatusKeys<TOutput>,
	): BuilderChain<Next<B, { output: TOutput; used: B["used"] | "output" }>> {
		return this.#next({ output: schemas })
	}

	/** Route-level middleware, after the chain and the scopes. */
	use<TAdds>(mw: MiddlewareFn<B["ctx"], TAdds>): BuilderChain<Next<B, { ctx: B["ctx"] & TAdds }>> {
		return this.#next({ middlewares: [...this.#s.middlewares, mw as unknown as RuntimeMiddleware] })
	}

	/** Register the route, once per method, and return the app typed with it. */
	handler(fn: (ctx: RouteHandlerCtx<B>) => MaybePromise<TypedResponse>): HandlerReturn<B> {
		const s = this.#s
		settle(s.graph, s.pending, s.view.node)
		const source: RouteSource = {
			cm: s.view.chain,
			cv: s.view.contextValues,
			dk: s.errorKeys,
			ef: s.errorSource,
			fn: fn as unknown as RouteSource["fn"],
			in: s.input,
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
		...undeclared(),
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
