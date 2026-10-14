/**
 * The app's type machinery: what a handler's ctx is, what each registered route records at the
 * type level (read by the RPC client and codegen), and the `Infer*` ladder over an app's phantom
 * `$routes`/`$ctx`/`$env`/`$meta` types. Type-only.
 */
import type { HoneyContext, REQUEST } from "../context/context.ts"
import type { Honey } from "./app.ts"
import type { TapMethod } from "./tap.ts"
import type { StatusKey } from "../response/status.ts"
import type { InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"

/** The request context a handler or middleware sees, without the framework's internal slot. */
export type HoneyCtx<TEnv = Record<string, unknown>> = Omit<HoneyContext<TEnv>, typeof REQUEST>

/** Built-in route meta keys. */
export type OpenApiMeta = {
	deprecated?: boolean
	description?: string
	/** Escape hatch: emitted verbatim at the highest precedence. */
	extensions?: Record<`x-${string}`, unknown>
	/** an internal route never appears in generated artifacts */
	internal?: boolean
	invalidate?: readonly string[] | null
	mcp?: boolean
	operationId?: string
	security?: Array<Record<string, string[]>> | string | string[]
	summary?: string
	tags?: string | string[]
}

export type DefaultMeta = OpenApiMeta

/** A middleware scoped by path at the type level: what it adds to routes under `path`. */
export type ScopedMwEntry = { readonly adds: unknown; readonly path: string }

/**
 * The additions of every scoped middleware whose path is `TFullPath` or one of its ancestors. A
 * widened (non-literal) scope path is skipped: `"/anywhere" extends string` would match every route.
 */
export type ApplyScoped<
	TScopedMw extends readonly ScopedMwEntry[],
	TFullPath extends string,
> = TScopedMw extends readonly [infer Head extends ScopedMwEntry, ...infer Rest extends readonly ScopedMwEntry[]]
	? (string extends Head["path"]
			? {}
			: Head["path"] extends "/"
				? Head["adds"]
				: TFullPath extends Head["path"]
					? Head["adds"]
					: TFullPath extends `${Head["path"] & string}/${string}`
						? Head["adds"]
						: {}) &
			ApplyScoped<Rest, TFullPath>
	: {}

/** Typed `ctx.params` when the route pattern names params. */
export type ApplyParams<TCtx, TParams> = [keyof TParams] extends [string]
	? string extends keyof TParams
		? TCtx
		: TCtx & { readonly params: TParams }
	: TCtx

/**
 * The full handler ctx: chain ctx, typed params, meta, pattern, declared errors and, after
 * `.input()`, ctx.input. With a factory, `errors` holds only the declared keys (as at runtime).
 */
export type HandlerCtx<
	TCtx,
	TParams,
	TAccMeta = {},
	TErrorFactory = never,
	TErrorKeys extends string = never,
	TPath extends string = string,
	TTaps = {},
	TInput = never,
> = ApplyParams<
	[TErrorFactory] extends [never]
		? [keyof TTaps] extends [never]
			? TCtx
			: Omit<TCtx, "tap">
		: Omit<TCtx, [keyof TTaps] extends [never] ? "errors" : "errors" | "tap">,
	TParams
> &
	/* declared taps replace the context's any-key tap; without them the context stays as it is */
	([keyof TTaps] extends [never] ? {} : TapMethod<TTaps>) & {
		readonly meta: Readonly<Omit<TAccMeta, "openApi" | typeof CHAIN_META>>
		readonly routePattern: TPath
	} & ([TErrorFactory] extends [never]
		? {}
		: [TErrorKeys] extends [never]
			? { readonly errors: TErrorFactory }
			: { readonly errors: Pick<TErrorFactory, TErrorKeys & keyof TErrorFactory> }) &
	([TInput] extends [never] ? {} : { readonly input: TInput })

/** One route at the type level, for the RPC client and codegen. */
export type RouteRecord<
	TMethod extends string,
	TPath extends string,
	TInput,
	TOutput,
	TCtx = unknown,
	TErrors extends string = never,
	TErrorsByStatus = never,
> = {
	[P in TPath]: {
		[M in Lowercase<TMethod>]: {
			ctx: TCtx
			errors: TErrors
			errorsByStatus: TErrorsByStatus
			input: TInput
			output: TOutput
		}
	}
}

/** Add one route to the accumulated routes (a flat intersection). */
export type MergeRoute<
	TRoutes,
	TPath extends string,
	TMethod extends string,
	TInput,
	TOutput,
	TCtx,
	TMeta = {},
	TErrors extends string = never,
	TErrorsByStatus = never,
> = TRoutes & {
	[P in TPath]: {
		[M in Lowercase<TMethod>]: {
			ctx: TCtx
			errors: TErrors
			errorsByStatus: TErrorsByStatus
			input: TInput
			meta: TMeta
			output: TOutput
		}
	}
}

/** `TMeta` defaults to `never`, and `never & X` is `never`: accumulated meta starts at `{}`. */
export type InitAccMeta<TMeta> = [TMeta] extends [never] ? {} : TMeta

/** Chain `.meta(values)` at the type level: a phantom optional key, so routes see the values without having to repeat them. */
declare const CHAIN_META: unique symbol

/** The handle's meta after a chain `.meta(values)`. */
export type WithChainMeta<TMeta, TValues> = InitAccMeta<TMeta> & { readonly [CHAIN_META]?: TValues }

/** Route meta as it is recorded: without the chain-meta key. */
export type RouteMeta<TAccMeta> = Omit<TAccMeta, typeof CHAIN_META>

type IsInternal<T> = [T] extends [{ internal: true }] ? true : false

/**
 * A route whose meta is `{ internal: true }`, on the route or on the chain it was registered on, is
 * left out of `$routes` (and so of generated clients); `never` meta is not internal.
 */
export type SkipRouteRecord<TAccMeta> = [TAccMeta] extends [never]
	? false
	: IsInternal<TAccMeta> extends true
		? true
		: TAccMeta extends { readonly [CHAIN_META]?: infer C }
			? IsInternal<NonNullable<C>>
			: false

/** The status codes `errorsByStatus` is keyed by; another status key falls back to `number`. */
type CodeOf = {
	accepted: 202
	bad_gateway: 502
	bad_request: 400
	conflict: 409
	created: 201
	forbidden: 403
	gateway_timeout: 504
	gone: 410
	internal_server_error: 500
	method_not_allowed: 405
	no_content: 204
	not_acceptable: 406
	not_found: 404
	not_implemented: 501
	ok: 200
	payment_required: 402
	service_unavailable: 503
	too_many_requests: 429
	unauthorized: 401
	unprocessable_entity: 422
}

type StatusKeyToCode<SK extends StatusKey> = SK extends keyof CodeOf ? CodeOf[SK] : number

type ErrorMetaMap = Record<string, { schema: unknown; statusKey: unknown }>

/** The status keys the declared error keys answer with. */
type UsedStatusKeys<TMeta extends ErrorMetaMap, TKeys extends string> = TKeys extends keyof TMeta
	? TMeta[TKeys]["statusKey"]
	: never

/** The body shapes of the declared error keys that answer with `TSK`: a schema's output, else `null`. */
type ShapesForStatus<
	TMeta extends ErrorMetaMap,
	TKeys extends string,
	TSK extends StatusKey,
> = TKeys extends keyof TMeta
	? TMeta[TKeys]["statusKey"] extends TSK
		? TMeta[TKeys]["schema"] extends StandardSchemaLike
			? InferOutput<TMeta[TKeys]["schema"]>
			: null
		: never
	: never

/** `{ [statusCode]: bodyShape }` from an error factory and the declared keys, for client-side discrimination. */
export type ComputeErrorsByStatus<TFactory, TErrorKeys extends string, TMetaSymbol extends symbol> = TFactory extends {
	readonly [K in TMetaSymbol]: infer TMeta
}
	? TMeta extends ErrorMetaMap
		? {
				[SK in UsedStatusKeys<TMeta, TErrorKeys> & StatusKey as StatusKeyToCode<SK>]: ShapesForStatus<
					TMeta,
					TErrorKeys,
					SK
				>
			}
		: never
	: never

/** The routes an app accumulated. */
export type InferRoutes<T> = T extends { readonly $routes: infer R } ? R : never

/** The chain's context; `res` is left out so a handler ctx is assignable into services. */
export type InferCtx<T> = T extends { readonly $ctx: infer TCtx } ? Omit<TCtx, "res"> : never

export type InferEnv<T> = T extends { readonly $env: infer TEnv } ? TEnv : never

/** Every HTTP method any route uses. */
export type InferMethods<T> = InferRoutes<T> extends infer R ? { [P in keyof R]: keyof R[P] & string }[keyof R] : never

export type InferRoutePaths<T> = keyof InferRoutes<T> & string

export type InferRouteMethods<T, TPath extends InferRoutePaths<T>> = InferRoutes<T>[TPath] extends infer M
	? keyof M & string
	: never

type RouteLookup<T, TPath extends string, TMethod extends string> =
	InferRoutes<T> extends infer R
		? TPath extends keyof R
			? R[TPath] extends infer Methods
				? TMethod extends keyof Methods
					? Methods[TMethod]
					: never
				: never
			: never
		: never

export type InferMeta<T> = T extends { readonly $meta: infer M } ? M : never

export type InferRouteCtx<T, TPath extends InferRoutePaths<T>, TMethod extends InferRouteMethods<T, TPath>> =
	RouteLookup<T, TPath, TMethod> extends { ctx: infer C } ? C : never

export type InferRouteInput<T, TPath extends InferRoutePaths<T>, TMethod extends InferRouteMethods<T, TPath>> =
	RouteLookup<T, TPath, TMethod> extends { input: infer I } ? I : never

export type InferRouteMeta<T, TPath extends InferRoutePaths<T>, TMethod extends InferRouteMethods<T, TPath>> =
	RouteLookup<T, TPath, TMethod> extends { meta: infer M } ? M : never

export type InferRouteOutput<T, TPath extends InferRoutePaths<T>, TMethod extends InferRouteMethods<T, TPath>> =
	RouteLookup<T, TPath, TMethod> extends { output: infer O } ? O : never

export type InferRouteErrors<T, TPath extends InferRoutePaths<T>, TMethod extends InferRouteMethods<T, TPath>> =
	RouteLookup<T, TPath, TMethod> extends { errors: infer E } ? E : never

export type InferErrorFactory<T> = T extends { readonly $errorFactory: infer F } ? F : never

export type InferBasePath<T> = T extends { readonly $basePath: infer P } ? P : never

/** `H` with tap payloads `TNewTaps` declared: they join its taps, and route meta may carry any of them. */
export type WithTaps<H, TNewTaps extends Record<string, unknown>> =
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
		? Honey<
				TEnv,
				TCtx,
				TRoutes,
				[TMeta] extends [never] ? Partial<TNewTaps> : TMeta & Partial<TNewTaps>,
				TFactory,
				TDefaults,
				TBase,
				TTaps & TNewTaps,
				TScoped
			>
		: never
