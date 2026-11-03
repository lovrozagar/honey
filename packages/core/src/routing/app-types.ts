/** The app's type machinery: the handler ctx, each route's record, and the `Infer*` ladder. Type-only. */
import type { HoneyContext, REQUEST } from "../context/context.ts"
import type { Honey } from "./app.ts"
import type { RouteSelectorOf } from "./codegen-types.ts"
import type { ApplyOutput } from "./output-types.ts"
import type { DeclaredMeta, InitAccMeta, RouteMeta, WithChainMeta } from "./meta-types.ts"
import type { TapMethod } from "./tap.ts"
import type { StatusKey } from "../response/status.ts"
import type { InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"

/**
 * The request context a handler or middleware sees, without the framework's internal slot. `TMeta` types `ctx.meta`:
 * a middleware typed `HoneyCtx<Env, RouteMeta>` mounts on an app that declared `metaType<RouteMeta>()`.
 */
export type HoneyCtx<TEnv = Record<string, unknown>, TMeta = Record<string, unknown>> = Omit<
	HoneyContext<TEnv>,
	typeof REQUEST | "meta"
> & {
	/** The matched route's meta: the built-in keys and the app's own. */
	readonly meta: Readonly<HoneyMeta<TMeta>>
}

/**
 * Route meta: the built-in keys every route accepts, and the app's own `T`. Name it wherever you declare route meta,
 * as in `app.metaType<HoneyMeta<RouteMeta>>()`.
 */
export type HoneyMeta<T = {}> = {
	/** Marks the operation deprecated in the generated OpenAPI document. */
	deprecated?: boolean
	/** Longer description of the operation, emitted as the OpenAPI `description`. */
	description?: string
	/** Escape hatch: emitted verbatim at the highest precedence. */
	extensions?: Record<`x-${string}`, unknown>
	/** an internal route never appears in generated artifacts */
	internal?: boolean
	/**
	 * Routes a successful call to this route makes stale, as `"METHOD /pattern"` selectors such as `"GET /users/:id"`.
	 * Generated clients read the list to mark those routes stale or refetch them. `null` or `[]` records that the call
	 * invalidates nothing, which also answers the document's check for mutations without `invalidate`. A selector that
	 * names no route fails the document unless that check is off.
	 */
	invalidate?: readonly RouteSelectorOf[] | null
	/**
	 * When `true`, marks the operation with `x-mcp` in the generated OpenAPI document, so the generated MCP server can
	 * offer it as a tool.
	 */
	mcp?: boolean
	/**
	 * Identifier of the operation in the generated OpenAPI document. Two routes declaring the same id fail the document;
	 * one route that expands into several operations (`.on()`, `all()`, an optional param) gets a suffix per operation.
	 */
	operationId?: string
	/**
	 * Security requirement documented for the operation: a scheme name, alternative scheme names, or OpenAPI requirement
	 * objects; `[]` documents the route as public, and a malformed value fails the document. honey does not enforce it
	 * on requests.
	 */
	security?: Array<Record<string, string[]>> | string | string[]
	/** One-line summary of the operation, emitted as the OpenAPI `summary`. */
	summary?: string
	/** Tag or tags that group the operation in the generated OpenAPI document. */
	tags?: string | string[]
} & T

/** A middleware scoped by path at the type level: what it adds to routes under `path`. */
export type ScopedMwEntry = {
	/** Properties the middleware adds to the ctx of routes under `path`. */ readonly adds: unknown
	/** Path prefix the middleware is scoped to, base path included; `/` covers every route. */ readonly path: string
}

/** The additions of every scoped middleware at `TFullPath` or an ancestor; a widened scope path is skipped. */
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
		: TCtx & {
				/** The route's path params by name, percent-decoded. */ readonly params: TParams
			}
	: TCtx

/** The handler ctx: params, meta, pattern, declared errors (as at runtime), input, ctx.res narrowed by output. */
export type HandlerCtx<
	TCtx,
	TParams,
	TAccMeta = {},
	TErrorFactory = never,
	TErrorKeys extends string = never,
	TPath extends string = string,
	TTaps = {},
	TInput = never,
	TOutput = never,
> = ApplyOutput<
	ApplyParams<
		[TErrorFactory] extends [never]
			? [keyof TTaps] extends [never]
				? TCtx
				: Omit<TCtx, "tap">
			: Omit<TCtx, [keyof TTaps] extends [never] ? "errors" : "errors" | "tap">,
		TParams
	> &
		/* declared taps replace the context's any-key tap; without them the context stays as it is */
		([keyof TTaps] extends [never] ? {} : TapMethod<TTaps>) & {
			/** The route's meta, frozen: what its middleware contributes, overlaid by chain and route `.meta()` values. */
			readonly meta: Readonly<Omit<RouteMeta<TAccMeta>, "openApi">>
			/** The route's canonical pattern with its base path, such as `/api/users/:id`. */
			readonly routePattern: TPath
		} & ([TErrorFactory] extends [never]
			? {}
			: [TErrorKeys] extends [never]
				? {
						/** The app's whole error factory, for a route that declares no error keys. At runtime, middleware that declares keys narrows it to those keys. */ readonly errors: TErrorFactory
					}
				: {
						/** The error factory narrowed to the keys this route declares, the app's default keys included. */ readonly errors: Pick<
							TErrorFactory,
							TErrorKeys & keyof TErrorFactory
						>
					}) &
		([TInput] extends [never]
			? {}
			: {
					/** The request values `.input()` validated, one key per declared source. */ readonly input: TInput
				}),
	TOutput
>

/** One route at the type level, for the RPC client and codegen; `request` (what a client sends) is its input. */
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
			/** The context type the route's handler receives. */
			ctx: TCtx
			/** The error keys the route declares. */
			errors: TErrors
			/** Error body shapes keyed by status code, for narrowing a failed call on the client. */
			errorsByStatus: TErrorsByStatus
			/** What the handler reads as `ctx.input`. */
			input: TInput
			/** The route's `.output()` declaration: media types to status keys to schemas. */
			output: TOutput
			/** What a client sends, which here is the route's input. */
			request: TInput
		}
	}
}

/** Add one route to the accumulated routes (a flat intersection); `request` is what a client sends. */
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
	TRequest = TInput,
> = TRoutes & {
	[P in TPath]: {
		[M in Lowercase<TMethod>]: {
			/** The context type the route's handler receives. */
			ctx: TCtx
			/** The error keys the route declares, the app's default keys included. */
			errors: TErrors
			/** Error body shapes keyed by status code, for narrowing a failed call on the client. */
			errorsByStatus: TErrorsByStatus
			/** What the handler reads as `ctx.input`. */
			input: TInput
			/** The app's declared meta plus the route's own `.meta()` values; chain values are left out. */
			meta: TMeta
			/** The route's `.output()` declaration: media types to status keys to schemas. */
			output: TOutput
			/** What a client sends, by source: each schema's input type, where `input` holds its output. */
			request: TRequest
		}
	}
}

export type {
	ChainSupplied,
	DeclaredMeta,
	InitAccMeta,
	RouteMeta,
	SkipRouteRecord,
	WithChainMeta,
	WithMiddlewareMeta,
} from "./meta-types.ts"

/** The status codes `errorsByStatus` is keyed by; another status key falls back to `number`. */
type CodeOf = {
	/** HTTP 202 Accepted. */
	accepted: 202
	/** HTTP 502 Bad Gateway. */
	bad_gateway: 502
	/** HTTP 400 Bad Request. */
	bad_request: 400
	/** HTTP 409 Conflict. */
	conflict: 409
	/** HTTP 201 Created. */
	created: 201
	/** HTTP 403 Forbidden. */
	forbidden: 403
	/** HTTP 504 Gateway Timeout. */
	gateway_timeout: 504
	/** HTTP 410 Gone. */
	gone: 410
	/** HTTP 500 Internal Server Error. */
	internal_server_error: 500
	/** HTTP 405 Method Not Allowed. */
	method_not_allowed: 405
	/** HTTP 204 No Content. */
	no_content: 204
	/** HTTP 406 Not Acceptable. */
	not_acceptable: 406
	/** HTTP 404 Not Found. */
	not_found: 404
	/** HTTP 501 Not Implemented. */
	not_implemented: 501
	/** HTTP 200 OK. */
	ok: 200
	/** HTTP 402 Payment Required. */
	payment_required: 402
	/** HTTP 503 Service Unavailable. */
	service_unavailable: 503
	/** HTTP 429 Too Many Requests. */
	too_many_requests: 429
	/** HTTP 401 Unauthorized. */
	unauthorized: 401
	/** HTTP 422 Unprocessable Entity. */
	unprocessable_entity: 422
}

/** The numeric status code for a status key, or `number` when the key is not one of the common ones. */
type StatusKeyToCode<SK extends StatusKey> = SK extends keyof CodeOf ? CodeOf[SK] : number

/** Per-error-key metadata of an error factory: the body schema and the status key. */
type ErrorMetaMap = Record<
	string,
	{
		/** The schema of the error's body; without one, the body shape reads as `null`. */ schema: unknown
		/** The status key the error answers with. */ statusKey: unknown
	}
>

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

/** The env type an app was created with (`TEnv` in `honey<TEnv>()`), which handlers read as `ctx.env`. */
export type InferEnv<T> = T extends { readonly $env: infer TEnv } ? TEnv : never

/** Every HTTP method any route uses. */
export type InferMethods<T> = InferRoutes<T> extends infer R ? { [P in keyof R]: keyof R[P] & string }[keyof R] : never

/** The union of an app's route paths, base paths included; routes marked `internal` are left out. */
export type InferRoutePaths<T> = keyof InferRoutes<T> & string

/** The lowercase HTTP methods an app declares for the route at `TPath`. */
export type InferRouteMethods<T, TPath extends InferRoutePaths<T>> = InferRoutes<T>[TPath] extends infer M
	? keyof M & string
	: never

/** The accumulated record of one route, or `never` when `TPath` and `TMethod` name no route. */
type RouteLookup<T, TPath extends string, TMethod extends string> =
	InferRoutes<T> extends infer R
		? TPath extends keyof R
			? TMethod extends keyof R[TPath]
				? R[TPath][TMethod]
				: never
			: never
		: never

/** The route meta an app declared with `metaType<T>()`, chain values left out; `never` when it declared none. */
export type InferMeta<T> = T extends { readonly $meta: infer M } ? DeclaredMeta<M> : never

/** The handler context type of one route. */
export type InferRouteCtx<T, TPath extends InferRoutePaths<T>, TMethod extends InferRouteMethods<T, TPath>> =
	RouteLookup<T, TPath, TMethod> extends { ctx: infer C } ? C : never

/** What one route's handler reads as `ctx.input`; `{}` for a route without `.input()`. */
export type InferRouteInput<T, TPath extends InferRoutePaths<T>, TMethod extends InferRouteMethods<T, TPath>> =
	RouteLookup<T, TPath, TMethod> extends { input: infer I } ? I : never

/** The meta type recorded for one route: the app's declared meta plus the route's own `.meta()` values. */
export type InferRouteMeta<T, TPath extends InferRoutePaths<T>, TMethod extends InferRouteMethods<T, TPath>> =
	RouteLookup<T, TPath, TMethod> extends { meta: infer M } ? M : never

/** One route's `.output()` declaration, by media type and status key; `{}` for a route without `.output()`. */
export type InferRouteOutput<T, TPath extends InferRoutePaths<T>, TMethod extends InferRouteMethods<T, TPath>> =
	RouteLookup<T, TPath, TMethod> extends { output: infer O } ? O : never

/** The error keys one route declares, the app's default keys included. */
export type InferRouteErrors<T, TPath extends InferRoutePaths<T>, TMethod extends InferRouteMethods<T, TPath>> =
	RouteLookup<T, TPath, TMethod> extends { errors: infer E } ? E : never

/** The error factory type set with `errorFactory()`; `never` when none was set. */
export type InferErrorFactory<T> = T extends { readonly $errorFactory: infer F } ? F : never
/** The base path set on a handle with `basePath()`; `/` when none was set. */
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
