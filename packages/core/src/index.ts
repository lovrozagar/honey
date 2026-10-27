/**
 * `@lovrozagar/honey`: the app (`honey()`), its context, errors, middleware and responses, the tree merge, and the
 * types an app is read through. Everything optional is its own subpath; nothing here registers itself (H23).
 */
export { toFetchRequest } from "./adapters/fetch-request.ts"
export type { ServeHandle } from "./adapters/serve.ts"
export { HoneyContext } from "./context/context.ts"
export type { CookieOptions } from "./context/cookie.ts"
export { HoneyError } from "./errors/error.ts"
export { defineErrors, ERROR_META, type ErrorMetaEntry } from "./errors/errors.ts"
export { createErrorResponse, type CustomErrorFormatter, type ErrorFormatter } from "./errors/projector.ts"
export type { InferInputMap } from "./input/input.ts"
export type {
	HoneyMetaSpec,
	MetaSpecConfig,
	MetaSpecContext,
	MetaSpecEntry,
	MetaSpecExpand,
	MetaSpecMergeConflict,
	MetaSpecProfile,
	MetaSpecSchemaEntry,
	MetaSpecSchemaSearch,
	MetaSpecSchemaSource,
	MetaSpecSingle,
	MetaSpecStrictness,
} from "./meta/meta-spec-merge.ts"
export { createMiddleware, defineMiddleware, type MiddlewareFn } from "./middleware/middleware.ts"
export type { ProxyConfig } from "./proxy/proxy.ts"
export type { RealtimeBus } from "./realtime/bus.ts"
export type { ConnContext, RealtimeLimits } from "./realtime/route.ts"
export type { RealtimePublisher } from "./realtime/server.ts"
export { HoneyRes, type ResponseOptions, type TypedResponse } from "./response/response.ts"
export type { SSEEvent, SSEOptions, SSEStream } from "./response/sse.ts"
export type { StatusKey } from "./response/status.ts"
export { Honey, honey } from "./routing/app.ts"
export type {
	ComputeErrorsByStatus,
	DefaultMeta,
	HoneyCtx,
	InferBasePath,
	InferCtx,
	InferEnv,
	InferErrorFactory,
	InferMeta,
	InferMethods,
	InferRouteCtx,
	InferRouteErrors,
	InferRouteInput,
	InferRouteMeta,
	InferRouteMethods,
	InferRouteOutput,
	InferRoutePaths,
	InferRoutes,
	OpenApiMeta,
	RouteRecord,
} from "./routing/app-types.ts"
export type { HoneyCodegen, RouteSelectorOf, WithOutput } from "./routing/codegen-types.ts"
export type { TapContext, TapHandler } from "./routing/tap.ts"
export { mergeTree } from "./routing/tree-merge.ts"
export type { MergePath, PrefixRoutes } from "./routing/types.ts"
export { detectRuntime, type ServeRuntime } from "./runtime/detect-runtime.ts"
export type { InferOutput, StandardSchemaLike } from "./validation/standard-schema.ts"
export type { WSAdapter, WSContext, WSHandler } from "./ws/contract.ts"
export type { WSOriginPolicy } from "./ws/origin.ts"
export type { WSAdapterOptions } from "./ws/shared.ts"
