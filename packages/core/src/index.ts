import { HoneyContext } from "./context.ts"
import { HoneyError } from "./error.ts"
import { ERROR_META } from "./errors.ts"
import type { MiddlewareFn, RuntimeMiddleware } from "./middleware.ts"
import { collectMiddlewareMeta } from "./middleware.ts"
import { compileChain, executeChain } from "./middleware.ts"
import type { ProxyConfig } from "./proxy.ts"
import { createProxyHandler } from "./proxy.ts"
import type { CustomErrorFormatter, ErrorFormatter, ResponseOptions, TypedResponse } from "./response.ts"
import { createErrorResponse, type HoneyRes } from "./response.ts"
import type { RouteId, Segment } from "./pattern.ts"
import {
	canonical,
	expandOptional,
	isStaticPattern,
	joinPatterns,
	normalizePattern,
	parsePattern,
	routeId,
	splitRouteId,
} from "./pattern.ts"
import type { OutputValidator, RouteEntry, RouteHandler, RouteTree, TreeNode, WSRouteHandler } from "./tree.ts"
import {
	assertTreeFormat,
	cloneTree,
	createNode,
	findLeaf,
	forEachLeaf,
	freezeTree,
	hasWsLeaf,
	insertLeaf,
	matchRoute,
	matchWsRoute,
	ROUTE_TREE_VERSION,
} from "./tree.ts"
import { createBus } from "./realtime/bus.ts"
import type { RealtimeBus } from "./realtime/bus.ts"
import { createConnContext } from "./realtime/route.ts"
import type { RealtimeRouteOpts } from "./realtime/route.ts"
import type {
	ComputeErrorsByStatus,
	DefaultMeta,
	ExtractSchemas,
	HttpMethod,
	InferInputMap,
	InferOutput,
	HoneyMetaSpec,
	InputSchemasDef,
	MergePath,
	MergeRoute,
	MetaSpecConfig,
	MetaSpecEntry,
	MetaSpecMergeConflict,
	OutputSchemaDef,
	ParamsFromPath,
	StandardSchemaLike,
	StatusKey,
	TapContext,
} from "./types.ts"
import { codeToStatusKey, EK, EMPTY_OBJ, SK } from "./types.ts"
import { assertRequestContentType, validateInput, validateOutput } from "./validation.ts"
import type { WSAdapter, WSContext, WSHandler } from "./ws/cloudflare.ts"
import { loadHoneyFeature } from "./feature-load.ts"
import { getI18nRuntime } from "./i18n-slot.ts"
import { getOpenApiRuntime } from "./openapi/spec-factory.ts"
import { getServeRuntime } from "./serve-slot.ts"
import type { HoneyServeOptions, ServeHandle } from "./serve.ts"

export { HoneyContext } from "./context.ts"
/** HoneyContext without internal backing fields — use this for consumer-facing types */
export type HoneyCtx<TEnv = Record<string, unknown>> = Omit<
	import("./context.ts").HoneyContext<TEnv>,
	| "_errorToResponse"
	| "_isErrorResponse"
	| "_lzCookies"
	| "_lzHeaders"
	| "_lzSearch"
	| "_lzSearchAll"
	| "_lzUrlFn"
	| "_setErrors"
>
export { HoneyError } from "./error.ts"
export { defineErrors, ERROR_META } from "./errors.ts"
export type { ErrorMetaEntry } from "./errors.ts"
export type { MiddlewareFn } from "./middleware.ts"
export { createMiddleware, defineMiddleware } from "./middleware.ts"
export type { ProxyConfig } from "./proxy.ts"
export type { PendingTap, TapContext, TapHandler } from "./types.ts"
export type {
	CookieOptions,
	CustomErrorFormatter,
	ErrorFormatter,
	ResponseOptions,
	SSEEvent,
	SSEOptions,
	SSEStream,
	TypedResponse,
} from "./response.ts"
export { createErrorResponse, HoneyRes } from "./response.ts"
export { mergeTree } from "./tree.ts"
export type {
	DefaultMeta,
	HoneyCodegen,
	HoneyMeta,
	InferBasePath,
	InferCtx,
	InferEnv,
	InferErrorFactory,
	InferInputMap,
	InferMeta,
	InferMethods,
	InferOutput,
	InferRouteCtx,
	InferRouteErrors,
	InferRouteInput,
	InferRouteMeta,
	InferRouteMethods,
	InferRouteOutput,
	InferRoutePaths,
	InferRoutes,
	InputSchemasDef,
	MergePath,
	HoneyMetaSpec,
	MetaSpecConfig,
	MetaSpecContext,
	MetaSpecEntry,
	MetaSpecMergeConflict,
	MetaSpecExpand,
	MetaSpecProfile,
	MetaSpecSchemaEntry,
	MetaSpecSchemaSearch,
	MetaSpecSchemaSource,
	MetaSpecSingle,
	MetaSpecStrictness,
	MetaSpecTarget,
	OpenApiMeta,
	OutputSchemaDef,
	Overwrite,
	ComputeErrorsByStatus,
	RouteRecord,
	StandardSchemaLike,
	StatusKey,
	SuccessStatusKey,
} from "./types.ts"
export type { WSAdapter, WSContext, WSHandler, WSPreUpgrade } from "./ws/cloudflare.ts"
export type { ConnContext, RealtimeRouteOpts } from "./realtime/route.ts"
export type { RealtimeBus } from "./realtime/bus.ts"
export type { HoneyServeOptions, ServeHandle } from "./serve.ts"
export type { ServeRuntime } from "./detect-runtime.ts"
export { detectRuntime } from "./detect-runtime.ts"

/** Type predicate for incoming wire-protocol msg frames from the realtime client. */
function isMsgFrame(value: unknown): value is { data: unknown; t: "msg" } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false
	if (!("t" in value) || !("data" in value)) return false
	return value.t === "msg"
}

type TelemetryAdapter = {
	onError?(ctx: { duration: number; error: HoneyError; method: string; path: string }): void
	onHandler?(ctx: { duration: number; method: string; path: string; status: number }): void
	onMethodNotAllowed?(ctx: { allowed: string[]; method: string; path: string; req: Request }): void
	onMiddleware?(ctx: { duration: number; error?: unknown; name: string }): void
	onNotFound?(ctx: { method: string; path: string; req: Request }): void
	onRequest?(ctx: { env: unknown; req: Request }): void
	onResponse?(ctx: { duration: number; req: Request; status: number }): void
	onRoute?(ctx: { method: string; params: Record<string, string>; path: string; req: Request }): void
}

type ErrorI18nConfig<TEnv> = {
	errors?: Record<string, Record<string, string>>
	fieldNames?: Record<string, Record<string, string>>
	resolveLocale: (ctx: {
		cookies: Record<string, string>
		env: TEnv
		headers: Record<string, string>
		params: Record<string, string>
		req: Request
		search: Record<string, string>
	}) => string | Promise<string>
}

/** The warn side of a structured logger (`warn(obj, msg)` or `warn(msg)`), e.g. honey/logger. */
type Logger = {
	warn?(objOrMsg: Record<string, unknown> | string, msg?: string): void
}

/** Join a base path and a route or scope path into one canonical pattern. */
function mergePath(base: string, path: string): string {
	return joinPatterns(base, path)
}

/** Check whether fullPath falls under scope prefix — exact match or next char is '/'. */
function scopeMatches(prefix: string, fullPath: string): boolean {
	if (prefix === "/") return true
	if (fullPath === prefix) return true
	if (fullPath.length <= prefix.length) return false
	if (fullPath.charCodeAt(prefix.length) !== 47) return false
	return fullPath.startsWith(prefix)
}

/** What one app graph serves, resolved at finalize from records and the loaded tree. */
type FinalTable = {
	byId: Map<RouteId, RouteHandler>
	epoch: number
	/** `METHOD /path` → record, for routes without params or wildcards */
	statics: Record<string, RouteHandler>
	wsById: Map<RouteId, WSRouteHandler>
}

/**
 * One app graph — shared by every handle derived with `use()`, `basePath()`, `context()`,
 * `meta()`. Records are per graph, keyed by `RouteId`; the tree holds ids only, so a loaded
 * (shared, frozen) tree never carries another app's handlers.
 */
type HoneyGraph = {
	/** gateway catch-alls by method — root wildcards registered over a loaded tree that lacks them */
	catchAll: Map<string, RouteHandler>
	/** bumped by every registration; finalize re-runs when it moves */
	epoch: number
	final: FinalTable | null
	hasWs: boolean
	/** route data of the loaded tree (per-graph copies) — null when no tree was loaded */
	loaded: Map<RouteId, RouteEntry> | null
	/** Codegen-time meta → OpenAPI policy. Never read on the request path */
	metaSpec: MetaSpecConfig | null
	realtimeBus: RealtimeBus | null
	records: Map<RouteId, RouteHandler>
	root: TreeNode
	/** root is a loaded tree (frozen, possibly shared by other apps) — copy before inserting */
	rootShared: boolean
	/** registered after routeTree() with no leaf in the loaded tree — stale generated file */
	unexpected: Set<RouteId>
	wsRecords: Map<RouteId, WSRouteHandler>
}

function createGraph(): HoneyGraph {
	return {
		catchAll: new Map(),
		epoch: 0,
		final: null,
		hasWs: false,
		loaded: null,
		metaSpec: null,
		realtimeBus: null,
		records: new Map(),
		root: createNode(),
		rootShared: false,
		unexpected: new Set(),
		wsRecords: new Map(),
	}
}

/** Fresh copy of a record for another graph — nothing (ek set, compiled chain) is shared. */
function copyRecord(r: RouteHandler): RouteHandler {
	const out: RouteHandler = { ...r, ek: new Set(r.ek) }
	delete out._compiled
	delete out.ca
	return out
}

/** Every leaf a pattern occupies: an optional last param places two. */
function leafVariants(segments: readonly Segment[]): Segment[][] {
	return expandOptional(segments)
}

function patternOf(id: RouteId): { method: string; segments: Segment[] } {
	const { method, pattern } = splitRouteId(id)
	return { method, segments: parsePattern(pattern) }
}

/** `fn` of a tree leaf no handler serves — dispatch answers 404, codegen still documents it. */
const NOT_SERVED: RouteHandler["fn"] = () => {
	throw new Error("honey: unserved route reached its handler")
}

function isRootWildcard(segments: readonly Segment[]): boolean {
	return segments.length === 1 && segments[0].k === "wildcard"
}

const EMPTY_PARAMS = EMPTY_OBJ as Record<string, string>
const EMPTY_MW: RuntimeMiddleware[] = []

function requestIsWsUpgrade(request: Request): boolean {
	try {
		return request.headers.get("upgrade")?.toLowerCase() === "websocket"
	} catch {
		/* Deno closes the Request after upgradeWebSocket */
		return false
	}
}

/** Find first '?' or '#' in url starting from pos */
function findSearchOrHash(url: string, pos: number): number {
	for (let i = pos; i < url.length; i++) {
		const c = url.charCodeAt(i)
		if (c === 63 || c === 35) return i
	}
	return -1
}

function safeFire(fn: (() => unknown) | undefined, logger?: Logger): void {
	if (fn === undefined) return
	try {
		const result = fn()
		if (result && typeof result === "object" && "catch" in result) {
			;(result as Promise<unknown>).catch((e: unknown) => {
				logger?.warn?.({ err: e }, "telemetry callback failed")
			})
		}
	} catch (e) {
		logger?.warn?.({ err: e }, "telemetry callback failed")
	}
}

/** Internal context shared across extracted fetch sub-methods */
type FetchCtx<TEnv> = {
	env: TEnv
	executionCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined
	log: Logger | undefined
	request: Request
	startTime: number
	url: () => URL
	/** Already known from fetch() before Deno.upgradeWebSocket consumes the request. */
	wsUpgrade?: boolean
	/** Headers copied before Deno.upgradeWebSocket closes the Request. */
	headerSnap?: Headers
}

function requestWithHeaders(req: Request, headers: Headers): Request {
	return new Proxy(req, {
		get(target, prop) {
			if (prop === "headers") return headers
			const value = Reflect.get(target, prop, target)
			return typeof value === "function" ? (value as (...args: never[]) => unknown).bind(target) : value
		},
	})
}

function ctxRequest(fc: FetchCtx<unknown>): Request {
	if (!fc.headerSnap) return fc.request
	try {
		void fc.request.headers.get("upgrade")
		return fc.request
	} catch {
		return requestWithHeaders(fc.request, fc.headerSnap)
	}
}

function defaultErrorFormatter(_error: HoneyError, defaultShape: Record<string, unknown>): Record<string, unknown> {
	return defaultShape
}

type ErrorFormatterFn = ErrorFormatter

const STATIC_CTX_RESERVED = new Set(["background", "cookies", "env", "headers", "params", "req", "res", "search"])

/* errorKeys the framework throws on its own behalf — input/output validation, content negotiation,
 * routing. Always passes the boundary check; users never declare these via .errors(). */
const FRAMEWORK_EKS = new Set<(typeof EK)[keyof typeof EK]>([
	EK.validation_failed,
	EK.output_validation_failed,
	EK.output_content_type_mismatch,
	EK.unsupported_media_type,
	EK.content_too_large,
	EK.method_not_allowed,
	EK.not_found,
	EK.too_many_requests,
	EK.request_timeout,
	EK.gateway_timeout,
	EK.bad_gateway,
])

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
> {
	declare readonly $basePath: TBasePath
	declare readonly $ctx: TCtx
	declare readonly $env: TEnv
	declare readonly $errorFactory: TErrorFactory
	declare readonly $meta: TMeta
	declare readonly $routes: TRoutes
	declare readonly $taps: TTaps
	private _basePath: string
	private _defaultBoundaryKey: string | null
	private _defaultErrorKeys: Set<string>
	private _errorFactory: unknown
	private _errorSchema: StandardSchemaLike | null
	private _customErrorFormatter: CustomErrorFormatter | null
	private _customErrorSchema: StandardSchemaLike | null
	private _chainMeta: Record<string, unknown> | null
	private _chainMiddlewares: RuntimeMiddleware[]
	private _scopedMiddlewares: ScopedEntry[]
	private _contextValues: Record<string, unknown> | null
	private _errorFormatter: ErrorFormatterFn
	private _errorI18n: ErrorI18nConfig<TEnv> | null
	private _globalMiddlewares: RuntimeMiddleware[]
	private _graph: HoneyGraph
	private _logger: Logger | null
	private _outputValidation: "always" | "dev" | "off"
	private _stripPrefix: string | null
	private _trailingSlash: "enforce" | "ignore" | "strip"
	private _wsAdapter: WSAdapter | null
	private _openApiCache: { epoch: number; value: Promise<unknown> } | null
	private _openApiYamlCache: { epoch: number; value: Promise<string> } | null
	private _manifestCache: { epoch: number; value: Promise<unknown> } | null
	private _onError:
		| ((
				error: unknown,
				ctx: {
					env: TEnv
					jsonFromError: (err: HoneyError) => Response
					req: Request
				},
		  ) => HoneyError | Response | Promise<HoneyError | Response | undefined | void> | undefined | void)
		| null
	private _onMethodNotAllowed:
		| ((ctx: {
				allowed: string[]
				env: TEnv
				jsonFromError: (err: HoneyError) => Response
				req: Request
		  }) => Response | Promise<Response>)
		| null
	private _onNotFound:
		| ((ctx: { env: TEnv; jsonFromError: (err: HoneyError) => Response; req: Request }) => Response | Promise<Response>)
		| null
	private _taps: Map<string, (ctx: TapContext<TEnv>, payload: unknown) => void | Promise<void>> | null
	private _telemetry: TelemetryAdapter | null
	private _realtimeRoutes: Map<
		string,
		{ handler: RealtimeRouteOpts["handler"]; middlewares?: RealtimeRouteOpts["use"]; reconnectBuffer?: number }
	>

	constructor(opts?: {
		chainMiddlewares?: RuntimeMiddleware[]
		defaultErrorKeys?: Set<string>
		globalMiddlewares?: RuntimeMiddleware[]
		graph?: HoneyGraph
		scopedMiddlewares?: ScopedEntry[]
	}) {
		this._basePath = "/"
		this._graph = opts?.graph ?? createGraph()
		this._globalMiddlewares = opts?.globalMiddlewares ?? []
		this._scopedMiddlewares = opts?.scopedMiddlewares ?? []
		this._chainMeta = null
		this._chainMiddlewares = opts?.chainMiddlewares ?? []
		this._contextValues = null
		this._defaultBoundaryKey = null
		this._defaultErrorKeys = opts?.defaultErrorKeys ?? new Set()
		this._errorFactory = null
		this._errorSchema = null
		this._customErrorFormatter = null
		this._customErrorSchema = null
		this._errorFormatter = defaultErrorFormatter
		this._errorI18n = null
		this._logger = null
		this._outputValidation = "off"
		this._stripPrefix = null
		this._trailingSlash = "ignore"
		this._wsAdapter = null
		this._openApiCache = null
		this._openApiYamlCache = null
		this._manifestCache = null
		this._onError = null
		this._onNotFound = null
		this._onMethodNotAllowed = null
		this._taps = null
		this._telemetry = null
		this._realtimeRoutes = new Map()
	}

	/** @internal — read by codegen */
	private get _metaSpec(): MetaSpecConfig | null {
		return this._graph.metaSpec
	}
	private set _metaSpec(value: MetaSpecConfig | null) {
		this._graph.metaSpec = value
	}

	private get _root(): TreeNode {
		return this._graph.root
	}

	private get _realtimeBus(): RealtimeBus | null {
		return this._graph.realtimeBus
	}
	private set _realtimeBus(value: RealtimeBus | null) {
		this._graph.realtimeBus = value
	}

	/** A new handle on the same graph, carrying this handle's settings. */
	private _derive(chainMiddlewares: RuntimeMiddleware[] = this._chainMiddlewares): Honey<TEnv> {
		const next = new Honey<TEnv>({
			chainMiddlewares,
			defaultErrorKeys: this._defaultErrorKeys,
			globalMiddlewares: this._globalMiddlewares,
			graph: this._graph,
			scopedMiddlewares: this._scopedMiddlewares,
		})
		next._basePath = this._basePath
		next._chainMeta = this._chainMeta
		next._contextValues = this._contextValues
		next._defaultBoundaryKey = this._defaultBoundaryKey
		next._errorFactory = this._errorFactory
		next._errorSchema = this._errorSchema
		next._customErrorFormatter = this._customErrorFormatter
		next._customErrorSchema = this._customErrorSchema
		next._errorFormatter = this._errorFormatter
		next._errorI18n = this._errorI18n
		next._logger = this._logger
		next._outputValidation = this._outputValidation
		next._stripPrefix = this._stripPrefix
		next._trailingSlash = this._trailingSlash
		next._wsAdapter = this._wsAdapter
		next._onError = this._onError
		next._onNotFound = this._onNotFound
		next._onMethodNotAllowed = this._onMethodNotAllowed
		next._taps = this._taps
		next._telemetry = this._telemetry
		next._realtimeRoutes = this._realtimeRoutes
		return next
	}

	/** @internal — used by RouteBuilder for pre-filtered error factory */
	get _factory(): unknown {
		return this._errorFactory
	}

	/** @internal — used by runtime error boundary */
	get _boundaryKey(): string | null {
		return this._defaultBoundaryKey
	}

	/** Convert unknown thrown value to error Response — used in WS, 404, 405 catch blocks */
	private _toErrorResponse(thrown: unknown): Response {
		const error =
			thrown instanceof HoneyError
				? thrown
				: new HoneyError({
						cause: thrown,
						errorKey: EK.internal_server_error,
						status: SK.internal_server_error,
					})
		return createErrorResponse(error, this._errorFormatter, this._customErrorFormatter)
	}

	private _createBoundaryError(errorKey: string, cause: unknown): HoneyError {
		const factory = this._errorFactory as Record<
			string,
			((opts?: { cause?: unknown }) => HoneyError) | undefined
		> | null
		const factoryFn = factory?.[errorKey]
		if (factoryFn) {
			/* check if this is a custom schema error via ERROR_META — boundary must use standard errors only */
			const meta = (factory as Record<symbol, Record<string, { schema: unknown }>>)?.[ERROR_META]
			if (meta?.[errorKey]?.schema) {
				/* custom schema error — cannot be used as boundary, fall through to manual construction */
			} else {
				return factoryFn({ cause })
			}
		}
		return new HoneyError({
			cause,
			errorKey,
			status: SK.internal_server_error,
		})
	}

	private _createError(errorKey: string, statusKey: StatusKey): HoneyError {
		const factory = this._errorFactory as Record<string, (() => HoneyError) | undefined> | null
		const factoryFn = factory?.[errorKey]
		if (factoryFn) {
			return factoryFn()
		}
		return new HoneyError({ errorKey, status: statusKey })
	}

	/** Apply error keys from a single scoped entry to every matching handler currently in the tree */
	private _applyScopedEntryErrors(entry: ScopedEntry): void {
		const errors = entry.errors
		if (!errors || errors.length === 0) return
		const apply = (h: { ek: Set<string>; rp?: string }): void => {
			if (scopeMatches(entry.prefix, h.rp ?? "")) {
				for (const k of errors) h.ek.add(k)
			}
		}
		for (const h of this._graph.records.values()) apply(h)
		for (const h of this._graph.wsRecords.values()) apply(h)
		this._bumpEpoch()
	}

	/**
	 * Meta contributed by every middleware that will run for `routePath`, in runtime order:
	 * global, chain, then scoped entries matching the path. Route-level `.use()` is folded in
	 * later, by the builder. Resolved here — at registration — because the precompiled route
	 * tree bakes `mt` as a literal, so a per-request derivation would diverge from it.
	 */
	private _contributedMetaFor(routePath: string): Record<string, unknown> | null {
		const scoped: RuntimeMiddleware[] = []
		for (const entry of this._scopedMiddlewares) {
			if (scopeMatches(entry.prefix, routePath)) scoped.push(entry.mw)
		}
		return collectMiddlewareMeta([this._globalMiddlewares, this._chainMiddlewares, scoped])
	}

	/**
	 * Back-fill meta from one scoped entry onto handlers already in the tree. Mirrors
	 * `_applyScopedEntryErrors` — `.use("/prefix", mw)` may be registered after the routes it
	 * covers, and a tag missing where enforcement happens is the worst failure direction.
	 * `mt` is frozen at registration, so this replaces the object rather than mutating it.
	 */
	private _applyScopedEntryMeta(entry: ScopedEntry): void {
		const meta = (entry.mw as { meta?: Record<string, unknown> }).meta
		if (!meta) return
		const apply = (h: { mt: Record<string, unknown> | null; rp?: string }): void => {
			if (!scopeMatches(entry.prefix, h.rp ?? "")) return
			/* contributed meta never overwrites what the route or chain stated explicitly */
			h.mt = Object.freeze(h.mt ? { ...meta, ...h.mt } : { ...meta })
		}
		for (const h of this._graph.records.values()) apply(h)
		for (const h of this._graph.wsRecords.values()) apply(h)
		this._bumpEpoch()
	}

	/** Scoped errors and meta for records finalize derives from a loaded tree (live and delegated). */
	private _applyScopedToDerived(h: RouteHandler | WSRouteHandler): void {
		for (const entry of this._scopedMiddlewares) {
			if (!scopeMatches(entry.prefix, h.rp ?? "")) continue
			if (entry.errors) for (const k of entry.errors) h.ek.add(k)
			const meta = (entry.mw as { meta?: Record<string, unknown> }).meta
			if (meta) h.mt = Object.freeze(h.mt ? { ...meta, ...h.mt } : { ...meta })
		}
	}

	/** Apply error keys from every scoped entry on this chain to every matching handler in the tree */
	private _applyAllScopedErrors(): void {
		for (const entry of this._scopedMiddlewares) {
			this._applyScopedEntryErrors(entry)
		}
	}

	/** Return scoped middleware functions that match the given route path */
	private _filterScopedForPath(routePath: string): RuntimeMiddleware[] {
		if (this._scopedMiddlewares.length === 0) return EMPTY_MW
		const out: RuntimeMiddleware[] = []
		for (const s of this._scopedMiddlewares) {
			if (scopeMatches(s.prefix, routePath)) out.push(s.mw)
		}
		return out
	}

	/** Mutates `honeyError.message` in-place with the i18n-resolved template for its errorKey.
	 * No-op when i18n is not configured or when no template matches. */
	private async _resolveI18n(
		honeyError: HoneyError,
		ctx: HoneyContext<TEnv>,
		env: TEnv,
		request: Request,
		log?: Logger,
	): Promise<void> {
		if (!this._errorI18n) return
		try {
			const locale = await this._errorI18n.resolveLocale({
				cookies: ctx.cookies,
				env,
				headers: ctx.headers,
				params: ctx.params,
				req: request,
				search: ctx.search,
			})
			const translations = this._errorI18n.errors?.[locale]
			if (translations) {
				const template = translations[honeyError.errorKey]
				if (template) {
					await loadHoneyFeature("i18n")
					honeyError.message = getI18nRuntime().interpolate(template, honeyError.vars ?? {})
				}
			}

			const fieldTranslations = this._errorI18n.fieldNames?.[locale]
			if (fieldTranslations && Object.keys(honeyError.fields).length > 0) {
				for (const fieldErrors of Object.values(honeyError.fields)) {
					for (const fe of fieldErrors) {
						let candidate = fe.path
						while (candidate) {
							const translated = fieldTranslations[candidate]
							if (translated) {
								fe.path = translated
								break
							}
							const dotIdx = candidate.indexOf(".")
							if (dotIdx === -1) break
							candidate = candidate.slice(dotIdx + 1)
						}
					}
				}
			}
		} catch (e) {
			log?.warn?.({ err: e }, "i18n resolution failed")
		}
	}

	/**
	 * Convert thrown value into an error Response — resolves boundary wrapping,
	 * i18n translation, onError callback, and telemetry.
	 * Called from the handler wrapper so errors flow back through middleware.
	 */
	private async _resolveErrorResponse(
		thrown: unknown,
		handler: RouteHandler,
		fc: FetchCtx<TEnv>,
		method: string,
		path: string,
		ctx: HoneyContext<TEnv>,
	): Promise<Response> {
		const { env, log, request, startTime } = fc
		let honeyError: HoneyError
		const boundaryKey = handler.bek ?? this._defaultBoundaryKey

		if (thrown instanceof HoneyError) {
			/* framework-managed errorKeys (input/output validation, content negotiation, etc.) are always allowed
			 * regardless of handler.ek — users never declare them, the framework owns them. */
			const isFrameworkEk = FRAMEWORK_EKS.has(thrown.errorKey as (typeof EK)[keyof typeof EK])
			if (!isFrameworkEk && handler.ek.size > 0 && !handler.ek.has(thrown.errorKey)) {
				if (boundaryKey) {
					honeyError = this._createBoundaryError(boundaryKey, thrown)
				} else {
					honeyError = new HoneyError({
						cause: thrown,
						errorKey: EK.internal_server_error,
						status: SK.internal_server_error,
					})
				}
			} else {
				honeyError = thrown
			}
		} else {
			if (boundaryKey) {
				honeyError = this._createBoundaryError(boundaryKey, thrown)
			} else {
				honeyError = new HoneyError({
					cause: thrown,
					errorKey: EK.internal_server_error,
					status: SK.internal_server_error,
				})
			}
		}

		await this._resolveI18n(honeyError, ctx, env, request, log)

		/* onError handler */
		if (this._onError) {
			try {
				const customResult = await this._onError(thrown, this._makeErrorCtx(fc))
				if (customResult instanceof HoneyError) {
					/* user-mapped boundary error — re-run i18n against new errorKey,
					 * then fall through to default response path so telemetry +
					 * jsonFromError run exactly once. */
					honeyError = customResult
					await this._resolveI18n(honeyError, ctx, env, request, log)
				} else if (customResult) {
					safeFire(
						() =>
							this._telemetry?.onError?.({
								duration: performance.now() - startTime,
								error: honeyError,
								method,
								path,
							}),
						log,
					)
					safeFire(
						() =>
							this._telemetry?.onResponse?.({
								duration: performance.now() - startTime,
								req: request,
								status: customResult.status,
							}),
						log,
					)
					ctx._isErrorResponse = true
					return customResult
				}
				/* customResult === undefined | void → fall through to default path */
			} catch {
				/* swallow onError errors */
			}
		}

		/* default error response */
		safeFire(
			() =>
				this._telemetry?.onError?.({
					duration: performance.now() - startTime,
					error: honeyError,
					method,
					path,
				}),
			log,
		)
		const res = this._makeErrorCtx(fc).jsonFromError(honeyError)
		safeFire(
			() =>
				this._telemetry?.onResponse?.({
					duration: performance.now() - startTime,
					req: request,
					status: res.status,
				}),
			log,
		)
		ctx._isErrorResponse = true
		return res
	}

	basePath<P extends string>(
		prefix: P,
	): Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors, MergePath<TBasePath, P>, TTaps, TScopedMw> {
		const next = this._derive()
		next._basePath = mergePath(this._basePath, prefix)
		return next as unknown as Honey<
			TEnv,
			TCtx,
			TRoutes,
			TMeta,
			TErrorFactory,
			TDefaultErrors,
			MergePath<TBasePath, P>,
			TTaps,
			TScopedMw
		>
	}

	context<TAdds extends Record<string, unknown>>(
		values: TAdds,
	): Honey<TEnv, TCtx & Readonly<TAdds>, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw> {
		for (const key in values) {
			if (STATIC_CTX_RESERVED.has(key)) {
				throw new Error(`context() cannot set reserved key "${key}"`)
			}
		}
		const next = this._derive()
		next._contextValues = this._contextValues ? { ...this._contextValues, ...values } : { ...values }
		return next as unknown as Honey<
			TEnv,
			TCtx & Readonly<TAdds>,
			TRoutes,
			TMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>
	}

	logger(logger: Logger): this {
		this._logger = logger
		return this
	}

	outputValidation(mode: "always" | "dev" | "off"): this {
		this._outputValidation = mode
		return this
	}

	trailingSlash(mode: "enforce" | "ignore" | "strip"): this {
		this._trailingSlash = mode
		return this
	}

	/** Strip a URL path prefix before route matching — boundary-safe (won't strip partial segments), paths without the prefix pass through unchanged */
	stripPrefix(prefix: string): this {
		let normalized = prefix.replace(/\/+$/, "")
		if (normalized.length > 0 && normalized.charCodeAt(0) !== 47) {
			normalized = `/${normalized}`
		}
		this._stripPrefix = normalized === "" || normalized === "/" ? null : normalized
		return this
	}

	wsAdapter(adapter: WSAdapter): this {
		this._wsAdapter = adapter
		return this
	}

	openapi(options: {
		description?: string
		docs?: "scalar" | "swagger"
		docsPath?: string
		filterRoutes?: (route: { meta: unknown; method: string; path: string }) => boolean
		path?: string
		/** Named metaSpec profile selecting which emitted keys this document carries */
		profile?: string
		securitySchemes?: Record<string, unknown>
		title: string
		version: string
	}): this {
		const stem = options.path ?? "/openapi"
		const yamlHeaders = { headers: { "content-type": "application/yaml; charset=utf-8" } }
		const loadJson = (): Promise<unknown> => {
			const epoch = this._graph.epoch
			if (this._openApiCache && this._openApiCache.epoch === epoch) {
				return this._openApiCache.value
			}
			let pending: Promise<unknown>
			pending = loadHoneyFeature("openapi")
				.then(() =>
					getOpenApiRuntime().generateOpenApi(this, {
						filterRoutes: options.filterRoutes,
						info: {
							description: options.description,
							title: options.title,
							version: options.version,
						},
						/* a served document is not an authoring moment — the check belongs to `honey generate` */
						invalidate: "off",
						profile: options.profile,
						securitySchemes: options.securitySchemes,
					}),
				)
				.catch((err: unknown) => {
					if (this._openApiCache?.value === pending) this._openApiCache = null
					throw err
				})
			this._openApiCache = { epoch, value: pending }
			return pending
		}
		const loadYaml = (): Promise<string> => {
			const epoch = this._graph.epoch
			if (this._openApiYamlCache && this._openApiYamlCache.epoch === epoch) {
				return this._openApiYamlCache.value
			}
			let pending: Promise<string>
			pending = Promise.resolve()
				.then(async () => getOpenApiRuntime().toYaml(await loadJson()))
				.catch((err: unknown) => {
					if (this._openApiYamlCache?.value === pending) this._openApiYamlCache = null
					throw err
				})
			this._openApiYamlCache = { epoch, value: pending }
			return pending
		}
		this._mountInternalGet(`${stem}.json`, async (ctx) => ctx.res.json("ok", await loadJson()))
		this._mountInternalGet(`${stem}.yml`, async (ctx) => ctx.res.text("ok", await loadYaml(), yamlHeaders))
		this._mountInternalGet(`${stem}.yaml`, async (ctx) => ctx.res.text("ok", await loadYaml(), yamlHeaders))
		if (options.docs) {
			const specUrl = mergePath(this._basePath, `${stem}.json`)
			const docs = options.docs
			const ui = async (ctx: { res: HoneyRes }) => {
				await loadHoneyFeature("openapi")
				return getOpenApiRuntime().docsUi(docs, specUrl)(ctx)
			}
			const preferred = options.docsPath ?? "/docs"
			const candidates = options.docsPath ? [preferred] : [preferred, "/reference"]
			let mounted = false
			for (const p of candidates) {
				if (this._mountInternalGet(p, ui)) {
					mounted = true
					break
				}
			}
			if (!mounted) {
				throw new Error(`Honey.openapi({ docs }) cannot mount at ${preferred}: already registered. Pass docsPath.`)
			}
		}
		return this
	}

	manifest(options?: { path?: string }): this {
		const path = options?.path ?? "/manifest.json"
		const load = (): Promise<unknown> => {
			const epoch = this._graph.epoch
			if (this._manifestCache && this._manifestCache.epoch === epoch) {
				return this._manifestCache.value
			}
			let pending: Promise<unknown>
			pending = loadHoneyFeature("openapi")
				.then(() => getOpenApiRuntime().generateManifest(this))
				.catch((err: unknown) => {
					if (this._manifestCache?.value === pending) this._manifestCache = null
					throw err
				})
			this._manifestCache = { epoch, value: pending }
			return pending
		}
		this._mountInternalGet(path, async (ctx) => ctx.res.json("ok", await load()))
		return this
	}

	async serve(options?: HoneyServeOptions): Promise<ServeHandle> {
		await loadHoneyFeature("serve")
		return getServeRuntime()(this, options)
	}

	/**
	 * Mount an internal GET (spec, docs, manifest). Returns false when a user route owns the
	 * exact path. Only an exact leaf counts: a `/:slug` or `/*rest` route does not block a
	 * static internal path, which wins over it on precedence anyway.
	 */
	private _mountInternalGet(path: string, fn: (ctx: { res: HoneyRes }) => Response | Promise<Response>): boolean {
		const fullPath = mergePath(this._basePath, path)
		const segments = parsePattern(fullPath)
		const id = routeId("GET", fullPath)
		const g = this._graph
		const existing = g.records.get(id)
		if (existing) return existing._skip === true
		const leaf = findLeaf(g.root, segments, "GET")
		if (leaf !== undefined && leaf !== id) return false
		if (findLeaf(g.root, segments, "ALL") !== undefined) return false
		/* a leaf the loaded tree holds for a user route the app has yet to register */
		if (leaf === id && g.loaded?.has(id)) return false
		const routeHandler: RouteHandler = {
			_skip: true,
			bek: this._defaultBoundaryKey,
			ef: null,
			ek: new Set(this._defaultErrorKeys),
			fn: (ctx) => fn(ctx as { res: HoneyRes }),
			iv: null,
			mt: null,
			mw: [...this._chainMiddlewares],
			os: null,
			ov: null,
		}
		this._addRoute("GET", segments, routeHandler)
		return true
	}

	private _bumpEpoch(): void {
		this._graph.epoch++
	}

	/** Place `id` at every leaf of `segments`, copying a shared (loaded) root first. */
	private _placeLeaves(segments: readonly Segment[], method: string, id: RouteId): void {
		const g = this._graph
		const variants = leafVariants(segments)
		if (variants.every((v) => findLeaf(g.root, v, method) === id)) return
		if (g.rootShared) {
			g.root = cloneTree(g.root)
			g.rootShared = false
		}
		for (const v of variants) insertLeaf(g.root, v, method, id)
	}

	/**
	 * @internal — register one route record. Over a loaded tree the record binds to the leaf
	 * the tree already holds for its id; a root wildcard the tree lacks becomes the gateway
	 * catch-all; any other unknown route marks the tree as stale (reported at finalize).
	 */
	_addRoute(method: string, segments: readonly Segment[], record: RouteHandler): void {
		const pattern = canonical(segments)
		const id = routeId(method, pattern)
		const g = this._graph
		if (g.records.has(id) || (isRootWildcard(segments) && g.catchAll.has(method))) {
			throw new Error(`Duplicate route: ${id}`)
		}
		record.id = id
		record.rp = pattern
		if (g.loaded !== null && record._skip !== true) {
			const known = leafVariants(segments).every((v) => findLeaf(g.root, v, method) === id)
			if (!known) {
				if (isRootWildcard(segments)) {
					record.ca = true
					g.catchAll.set(method, record)
					this._bumpEpoch()
					return
				}
				g.unexpected.add(id)
			}
		}
		this._placeLeaves(segments, method, id)
		g.records.set(id, record)
		this._bumpEpoch()
	}

	/** @internal — register one websocket (or realtime) route record. */
	_addWsRoute(segments: readonly Segment[], record: WSRouteHandler): void {
		const pattern = canonical(segments)
		const id = routeId("WS", pattern)
		const g = this._graph
		if (g.wsRecords.has(id)) throw new Error(`Duplicate WebSocket route: ${pattern}`)
		record.id = id
		record.rp = pattern
		if (g.loaded !== null && leafVariants(segments).some((v) => findLeaf(g.root, v, "WS") !== id)) {
			g.unexpected.add(id)
		}
		this._placeLeaves(segments, "WS", id)
		g.wsRecords.set(id, record)
		g.hasWs = true
		this._bumpEpoch()
	}

	/**
	 * Resolve what this graph serves: registered records, live records carried by a loaded
	 * snapshot, and delegated leaves the gateway catch-all serves. Re-runs whenever a
	 * registration bumped the epoch. Throws — naming every route — when a loaded tree and the
	 * registered routes disagree, which means the generated file is stale.
	 */
	_finalize(): FinalTable {
		const g = this._graph
		if (g.final !== null && g.final.epoch === g.epoch) return g.final
		const byId = new Map<RouteId, RouteHandler>()
		const wsById = new Map<RouteId, WSRouteHandler>()
		for (const [id, r] of g.records) byId.set(id, r)
		for (const [id, r] of g.wsRecords) wsById.set(id, r)
		const problems: string[] = []
		if (g.loaded !== null) {
			for (const id of g.unexpected) problems.push(`${id} is registered but missing from the loaded route tree`)
			let delegated = 0
			for (const [id, entry] of g.loaded) {
				const { method, pattern } = splitRouteId(id)
				if (method === "WS") {
					if (wsById.has(id)) continue
					if (entry.h !== undefined) {
						const live = { ...(entry.h as WSRouteHandler), ek: new Set(entry.h.ek), id, rp: pattern }
						this._applyScopedToDerived(live)
						wsById.set(id, live)
					}
					/* a websocket leaf nothing serves is not upgraded: the request falls through to HTTP */
					continue
				}
				if (byId.has(id)) continue
				if (entry.h !== undefined) {
					const live = copyRecord(entry.h as RouteHandler)
					live.id = id
					live.rp = pattern
					this._applyScopedToDerived(live)
					byId.set(id, live)
					continue
				}
				const ca = g.catchAll.get(method) ?? g.catchAll.get("ALL")
				if (ca !== undefined) {
					const dl = copyRecord(ca)
					dl.dl = true
					dl.id = id
					dl.rp = pattern
					dl.mt = entry.mt ? Object.freeze({ ...entry.mt }) : null
					dl.iv = entry.iv ?? null
					dl.os = entry.os ?? null
					if (entry.ek) for (const k of entry.ek) dl.ek.add(k)
					if (entry.bek !== undefined) dl.bek = entry.bek
					this._applyScopedToDerived(dl)
					byId.set(id, dl)
					delegated++
					continue
				}
				/* no handler anywhere: documented (served specs list it) but answered with 404 */
				byId.set(id, {
					bek: entry.bek ?? null,
					dl: true,
					ek: new Set(entry.ek ?? []),
					fn: NOT_SERVED,
					id,
					iv: entry.iv ?? null,
					mt: entry.mt ? Object.freeze({ ...entry.mt }) : null,
					mw: [],
					os: entry.os ?? null,
					rp: pattern,
				})
			}
			if (g.catchAll.size > 0 && delegated === 0) {
				for (const id of g.catchAll.keys()) {
					problems.push(`ALL root wildcard (${g.catchAll.get(id)?.id}) is missing from the loaded route tree`)
				}
			}
		}
		if (problems.length > 0) {
			throw new Error(`Route tree out of date — regenerate it (\`honey generate\`):\n  ${problems.join("\n  ")}`)
		}
		const statics = Object.create(null) as Record<string, RouteHandler>
		for (const [id, r] of byId) {
			const { method, segments } = patternOf(id)
			for (const v of leafVariants(segments)) {
				if (isStaticPattern(v)) statics[`${method} ${canonical(v)}`] = r
			}
		}
		g.final = { byId, epoch: g.epoch, statics, wsById }
		return g.final
	}

	/**
	 * @internal — every served route as one entry per leaf (an optional param yields two
	 * paths), in tree order. Codegen and OpenAPI read routes through this.
	 */
	_collectRoutes(includeSkipped = false): Array<{ handler: RouteHandler; method: string; path: string }> {
		const final = this._finalize()
		const out: Array<{ handler: RouteHandler; method: string; path: string }> = []
		forEachLeaf(this._root, (method, path, id) => {
			if (method === "WS") return
			const handler = final.byId.get(id)
			if (handler === undefined) return
			if (handler._skip && !includeSkipped) return
			out.push({ handler, method, path })
		})
		return out
	}

	/** @internal — websocket routes, one entry per leaf. */
	_collectWsRoutes(): Array<{ handler: WSRouteHandler; path: string }> {
		const final = this._finalize()
		const out: Array<{ handler: WSRouteHandler; path: string }> = []
		forEachLeaf(this._root, (method, path, id) => {
			if (method !== "WS") return
			const handler = final.wsById.get(id)
			if (handler !== undefined) out.push({ handler, path })
		})
		return out
	}

	/** @internal — the route-graph epoch; served documents cache against it. */
	get _epoch(): number {
		return this._graph.epoch
	}

	defaultErrorFormatter<TSchema extends StandardSchemaLike>(
		schema: TSchema,
		fn: (error: HoneyError) => InferOutput<TSchema>,
	): this
	defaultErrorFormatter(fn: ErrorFormatterFn): this
	defaultErrorFormatter(
		schemaOrFn: ErrorFormatterFn | StandardSchemaLike,
		maybeFn?: (error: HoneyError) => unknown,
	): this {
		if (typeof schemaOrFn === "function") {
			this._errorSchema = null
			this._errorFormatter = schemaOrFn
		} else {
			this._errorSchema = schemaOrFn
			const mapper = maybeFn as (error: HoneyError) => Record<string, unknown>
			this._errorFormatter = (error) => mapper(error)
		}
		return this
	}

	customErrorFormatter<TSchema extends StandardSchemaLike>(
		schema: TSchema,
		fn: (error: HoneyError, data: Record<string, unknown>) => InferOutput<TSchema>,
	): this
	customErrorFormatter(fn: CustomErrorFormatter): this
	customErrorFormatter(
		schemaOrFn: CustomErrorFormatter | StandardSchemaLike,
		maybeFn?: (error: HoneyError, data: Record<string, unknown>) => unknown,
	): this {
		if (typeof schemaOrFn === "function") {
			this._customErrorSchema = null
			this._customErrorFormatter = schemaOrFn
		} else {
			this._customErrorSchema = schemaOrFn
			const mapper = maybeFn as (error: HoneyError, data: Record<string, unknown>) => Record<string, unknown>
			this._customErrorFormatter = (error, data) => mapper(error, data)
		}
		return this
	}

	errorI18n(config: ErrorI18nConfig<TEnv>): this {
		this._errorI18n = config
		return this
	}

	onError(
		handler: (
			error: unknown,
			ctx: {
				env: TEnv
				jsonFromError: (err: HoneyError) => Response
				req: Request
			},
		) => HoneyError | Response | Promise<HoneyError | Response | undefined | void> | undefined | void,
	): this {
		this._onError = handler
		return this
	}

	onMethodNotAllowed(
		handler: (ctx: {
			allowed: string[]
			env: TEnv
			jsonFromError: (err: HoneyError) => Response
			req: Request
		}) => Response | Promise<Response>,
	): this {
		this._onMethodNotAllowed = handler
		return this
	}

	onNotFound(
		handler: (ctx: {
			env: TEnv
			jsonFromError: (err: HoneyError) => Response
			req: Request
		}) => Response | Promise<Response>,
	): this {
		this._onNotFound = handler
		return this
	}

	/** Register a tap handler keyed by name — fires after successful handler response */
	tap<K extends string>(
		key: K,
		handler: (ctx: TapContext<TEnv>, payload: K extends keyof TTaps ? TTaps[K] : unknown) => void | Promise<void>,
	): this {
		if (this._taps === null) {
			this._taps = new Map()
		}
		this._taps.set(key, handler as (ctx: TapContext<TEnv>, payload: unknown) => void | Promise<void>)
		return this
	}

	telemetry(adapter: TelemetryAdapter): this {
		this._telemetry = adapter
		return this
	}

	/**
	 * Load a route tree — a generated `routes.gen.ts`, an `app.toRouteTree()` snapshot, or a
	 * `mergeTree()` of either. The tree supplies the router topology; what each route runs
	 * comes from the routes this app registers afterwards (bound by `RouteId`), from live
	 * records in a snapshot, or — for leaves with neither — from a root wildcard the app
	 * registers as its gateway catch-all. Must be called before any route is registered.
	 */
	routeTree(tree: RouteTree): this {
		assertTreeFormat(tree)
		const g = this._graph
		if (g.loaded !== null) throw new Error("routeTree() was already called on this app")
		for (const r of g.records.values()) {
			if (r._skip !== true) throw new Error(`routeTree() must be called before routes are registered (${r.id} is)`)
		}
		if (g.wsRecords.size > 0 || g.catchAll.size > 0) {
			throw new Error("routeTree() must be called before routes are registered")
		}
		forEachLeaf(tree.root, (method, path, id) => {
			if (!(id in tree.routes)) throw new Error(`routeTree(): leaf ${method} ${path} has no route entry (${id})`)
		})
		const internals = [...g.records.values()]
		g.records.clear()
		g.root = freezeTree(tree.root)
		g.rootShared = true
		g.loaded = new Map()
		for (const id of Object.keys(tree.routes)) g.loaded.set(id, { ...tree.routes[id] })
		if (hasWsLeaf(g.root)) g.hasWs = true
		/* internal routes mounted before the tree was loaded move onto the loaded topology */
		for (const r of internals) {
			const { method, segments } = patternOf(r.id as RouteId)
			this._addRoute(method, segments, r)
		}
		this._bumpEpoch()
		return this
	}

	/**
	 * Snapshot this app's routes as a tree: a copy of the topology plus, per route, its data
	 * and its live record. Internal routes (spec, docs, manifest) are left out. Loading the
	 * snapshot into another app serves these records; nothing in it is shared with this app.
	 */
	toRouteTree(): RouteTree {
		const final = this._finalize()
		const routes = Object.create(null) as Record<RouteId, RouteEntry>
		const keep = new Set<RouteId>()
		for (const [id, r] of final.byId) {
			if (r._skip) continue
			keep.add(id)
			routes[id] = {
				bek: r.bek,
				ek: [...r.ek],
				h: copyRecord(r),
				iv: r.iv ?? null,
				mt: r.mt,
				os: r.os ?? null,
			}
		}
		for (const [id, r] of final.wsById) {
			keep.add(id)
			routes[id] = { bek: r.bek, ek: [...r.ek], h: { ...r, ek: new Set(r.ek) }, iv: r.iv, mt: r.mt }
		}
		const root = createNode()
		forEachLeaf(this._root, (method, path, id) => {
			if (keep.has(id)) insertLeaf(root, parsePattern(path), method, id)
		})
		return { meta: {}, root, routes, v: ROUTE_TREE_VERSION }
	}

	/**
	 * @internal — generate-time: copy input/output schemas from `source` onto this app's
	 * routes that lack them (a gateway serves its generated tree, which carries none).
	 */
	_overlaySchemas(source: RouteTree): void {
		const g = this._graph
		for (const [id, entry] of Object.entries(source.routes)) {
			const iv = entry.iv ?? (entry.h as RouteHandler | undefined)?.iv ?? null
			const os = entry.os ?? (entry.h as RouteHandler | undefined)?.os ?? null
			if (iv === null && os === null) continue
			const record = g.records.get(id)
			if (record !== undefined) {
				record.iv ??= iv
				record.os ??= os
				continue
			}
			const loaded = g.loaded?.get(id)
			if (loaded !== undefined) {
				loaded.iv ??= iv
				loaded.os ??= os
			}
		}
		this._bumpEpoch()
	}

	errorFactory<TFactory extends Record<string, (...args: never[]) => unknown>>(
		factory: TFactory,
	): Honey<TEnv, TCtx, TRoutes, TMeta, TFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw> {
		const next = this as unknown as Honey<
			TEnv,
			TCtx,
			TRoutes,
			TMeta,
			TFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>
		next._errorFactory = factory
		return next
	}

	defaultErrors<TKeys extends ([TErrorFactory] extends [never] ? never : keyof TErrorFactory & string)>(
		...keys: TKeys[]
	): Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors | TKeys, TBasePath, TTaps, TScopedMw> {
		const next = this as unknown as Honey<
			TEnv,
			TCtx,
			TRoutes,
			TMeta,
			TErrorFactory,
			TDefaultErrors | TKeys,
			TBasePath,
			TTaps,
			TScopedMw
		>
		for (const k of keys) {
			next._defaultErrorKeys.add(k)
		}
		return next
	}

	defaultBoundary<TKey extends ([TErrorFactory] extends [never] ? never : keyof TErrorFactory & string)>(
		key: TKey,
	): Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors | TKey, TBasePath, TTaps, TScopedMw> {
		const next = this as unknown as Honey<
			TEnv,
			TCtx,
			TRoutes,
			TMeta,
			TErrorFactory,
			TDefaultErrors | TKey,
			TBasePath,
			TTaps,
			TScopedMw
		>
		next._defaultBoundaryKey = key
		next._defaultErrorKeys.add(key)
		return next
	}

	/** Phantom overload — constrains what route-level .meta() accepts */
	meta<TNewMeta extends Record<string, unknown>>(): Honey<
		TEnv,
		TCtx,
		TRoutes,
		TNewMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	>
	/** Typed chain-level default meta — constrains route meta and sets runtime defaults in one call */
	meta<TNewMeta extends Record<string, unknown>, TValues extends Partial<DefaultMeta> & Partial<TNewMeta>>(
		values: TValues,
	): Honey<TEnv, TCtx, TRoutes, TNewMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
	/** Chain-level default meta — merged into every route registered on this chain */
	meta<TValues extends Partial<DefaultMeta> & ([TMeta] extends [never] ? {} : Partial<TMeta>)>(
		values: TValues,
	): Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
	meta(
		values?: Record<string, unknown>,
	): Honey<TEnv, TCtx, TRoutes, unknown, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw> {
		if (values === undefined) {
			/* phantom overload — type-only, no runtime effect */
			return this as Honey<TEnv, TCtx, TRoutes, unknown, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
		}
		/* chain-level meta — copy-on-write */
		const next = this._derive()
		next._chainMeta = this._chainMeta ? { ...this._chainMeta, ...values } : { ...values }
		return next as unknown as Honey<
			TEnv,
			TCtx,
			TRoutes,
			unknown,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>
	}

	/**
	 * Declare what flows from route meta and route schemas into the OpenAPI document.
	 * Codegen-time only — never consulted on the request path. See docs/meta-spec.md.
	 */
	metaSpec<TSpec extends HoneyMetaSpec<TMeta>>(spec: TSpec): this {
		if (this._metaSpec !== null) {
			throw new Error("metaSpec() was already declared on this app — declare the whole policy in one call")
		}
		this._metaSpec = spec as MetaSpecConfig
		return this
	}

	/**
	 * Merge a mounted sub-app's policy into this one.
	 *
	 * The parent wins on conflict, so one gateway keeps one answer for its aggregate document —
	 * with a single exception. A sub entry of `false` wins over anything the parent says, because
	 * hiding is a safety claim and the strictest claim has to survive composition: a worker that
	 * declares a field unpublishable must not have the gateway publish it. Wrongly hidden is a
	 * visible gap; wrongly published is a leak.
	 *
	 * Every other disagreement is recorded and reported at codegen. Silently dropping a sub's
	 * entry is how someone ends up diffing two documents to find out why they differ.
	 */
	private _absorbMetaSpec(sub: MetaSpecConfig | null): void {
		if (!sub) return
		const own = this._metaSpec
		if (!own) {
			this._metaSpec = sub
			return
		}
		const conflicts: MetaSpecMergeConflict[] = [...(own.conflicts ?? []), ...(sub.conflicts ?? [])]

		const mergeMeta = (): Record<string, MetaSpecEntry> => {
			const merged: Record<string, MetaSpecEntry> = { ...sub.meta, ...own.meta }
			for (const [key, subEntry] of Object.entries(sub.meta ?? {})) {
				const ownEntry = own.meta?.[key]
				if (ownEntry === undefined || ownEntry === subEntry) continue
				if (subEntry === false && ownEntry !== false) {
					merged[key] = false
					conflicts.push({ key, resolution: "hidden", section: "meta" })
					continue
				}
				conflicts.push({ key, resolution: "parent", section: "meta" })
			}
			return merged
		}

		const recordOverlap = (section: "profiles" | "schema", subSide: object, ownSide: object): void => {
			for (const [key, subEntry] of Object.entries(subSide)) {
				const ownEntry = (ownSide as Record<string, unknown>)[key]
				if (ownEntry === undefined || ownEntry === subEntry) continue
				conflicts.push({ key, resolution: "parent", section })
			}
		}
		recordOverlap("schema", sub.schema ?? {}, own.schema ?? {})
		recordOverlap("profiles", sub.profiles ?? {}, own.profiles ?? {})

		this._metaSpec = {
			conflicts,
			meta: mergeMeta(),
			profiles: { ...sub.profiles, ...own.profiles },
			schema: { ...sub.schema, ...own.schema },
			strict: own.strict ?? sub.strict,
		}
	}

	/** Declare tap payload types — auto-extends meta with Partial<T> for meta-driven taps */
	taps<TNewTaps extends Record<string, unknown>>(): Honey<
		TEnv,
		Omit<TCtx, "tap"> & { tap<K extends keyof TNewTaps>(key: K, payload: TNewTaps[K]): void },
		TRoutes,
		[TMeta] extends [never] ? Partial<TNewTaps> : TMeta & Partial<TNewTaps>,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TNewTaps,
		TScopedMw
	> {
		return this as unknown as Honey<
			TEnv,
			Omit<TCtx, "tap"> & { tap<K extends keyof TNewTaps>(key: K, payload: TNewTaps[K]): void },
			TRoutes,
			[TMeta] extends [never] ? Partial<TNewTaps> : TMeta & Partial<TNewTaps>,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TNewTaps,
			TScopedMw
		>
	}

	use<TAdds>(
		mw: MiddlewareFn<TCtx, TAdds>,
	): Honey<TEnv, TCtx & TAdds, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>

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
		readonly [...TScopedMw, { readonly path: MergePath<TBasePath, TPath>; readonly adds: TAdds }]
	>

	/* oxlint-disable-next-line typescript/no-explicit-any -- overload impl requires erased types */
	use(pathOrMw: string | MiddlewareFn<any, any>, maybeMw?: MiddlewareFn<any, any>): any {
		if (typeof pathOrMw !== "string") {
			const mw = pathOrMw as RuntimeMiddleware
			return this._derive([...this._chainMiddlewares, mw])
		}

		/* scoped path */
		const normalizedPrefix = normalizePattern(pathOrMw)
		const fullPrefix = mergePath(this._basePath, normalizedPrefix)
		const mw = maybeMw as RuntimeMiddleware
		const mwWithErrors = maybeMw as MiddlewareFn<unknown, unknown>
		const entry: ScopedEntry = {
			errors: mwWithErrors.errors ? [...mwWithErrors.errors] : undefined,
			mw,
			prefix: fullPrefix,
		}
		this._scopedMiddlewares.push(entry)
		const newChain = this._derive()
		newChain._applyScopedEntryErrors(entry)
		newChain._applyScopedEntryMeta(entry)
		return newChain
	}

	route<TSubRoutes, TSubMeta, TSubErrorFactory, TSubDefaultErrors extends string, TSubBasePath extends string>(
		sub: Honey<TEnv, TCtx, TSubRoutes, TSubMeta, TSubErrorFactory, TSubDefaultErrors, TSubBasePath>,
	): Honey<TEnv, TCtx, TRoutes & TSubRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw> {
		/* skip self-merge: .handler() already registered into the shared graph */
		if (sub._graph !== this._graph) {
			/*
			 * Copy the sub's resolved records into this graph — nothing is shared by reference,
			 * so routes the sub registers later stay its own, and two parents mounting one sub
			 * each get their own records. Internal routes (spec, docs, manifest) never travel.
			 */
			const subFinal = sub._finalize()
			for (const [id, r] of subFinal.byId) {
				if (r._skip) continue
				const { method, segments } = patternOf(id)
				this._addRoute(method, segments, copyRecord(r))
			}
			for (const [id, r] of subFinal.wsById) {
				const { segments } = patternOf(id)
				this._addWsRoute(segments, { ...r, ek: new Set(r.ek) })
			}
			this._absorbMetaSpec(sub._metaSpec)
			/* carry sub's scoped mw entries into parent's runtime list (parent scopes run first) */
			for (const entry of sub._scopedMiddlewares) {
				this._scopedMiddlewares.push(entry)
			}
			for (const [path, cfg] of sub._realtimeRoutes) {
				if (this._realtimeRoutes.has(path)) {
					throw new Error(`Duplicate realtime route: ${path}`)
				}
				this._realtimeRoutes.set(path, cfg)
			}
			if (!this._realtimeBus && sub._realtimeBus) {
				this._realtimeBus = sub._realtimeBus
			}
			if (sub._taps !== null) {
				if (this._taps === null) this._taps = new Map()
				for (const [key, fn] of sub._taps) {
					if (!this._taps.has(key)) this._taps.set(key, fn)
				}
			}
			/* apply all scoped error keys + contributed meta to matching records */
			this._applyAllScopedErrors()
			for (const entry of this._scopedMiddlewares) this._applyScopedEntryMeta(entry)
		}
		return this as unknown as Honey<
			TEnv,
			TCtx,
			TRoutes & TSubRoutes,
			TMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>
	}

	private _registerRoute<TPath extends string, TMethod extends HttpMethod | "ALL">(
		method: TMethod,
		path: TPath,
		extraMethods?: (HttpMethod | "ALL")[],
	): BuilderChain<
		TEnv,
		TCtx & ApplyScoped<TScopedMw, MergePath<TBasePath, TPath>>,
		{},
		never,
		{},
		MergePath<TBasePath, TPath>,
		TMethod,
		TRoutes,
		never,
		TCtx,
		TMeta,
		InitAccMeta<TMeta>,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		const fullPath = mergePath(this._basePath, path)
		const errorKeys = new Set(this._defaultErrorKeys)
		for (const entry of this._scopedMiddlewares) {
			if (entry.errors && scopeMatches(entry.prefix, fullPath)) {
				for (const k of entry.errors) errorKeys.add(k)
			}
		}
		return new RouteBuilder<
			TEnv,
			TCtx & ApplyScoped<TScopedMw, MergePath<TBasePath, TPath>>,
			{},
			never,
			{},
			MergePath<TBasePath, TPath>,
			TMethod,
			TRoutes,
			never,
			TCtx,
			TMeta,
			InitAccMeta<TMeta>,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>({
			boundaryErrorKey: this._defaultBoundaryKey,
			errorKeys,
			extraMethods: extraMethods ?? null,
			inputSchemas: null,
			meta: this._chainMeta ? { ...this._chainMeta } : null,
			method,
			middlewares: [],
			mwMeta: this._contributedMetaFor(fullPath),
			outputSchemas: null,
			parent: this,
			parentMiddlewares: this._chainMiddlewares,
			path: fullPath,
		}) as unknown as BuilderChain<
			TEnv,
			TCtx & ApplyScoped<TScopedMw, MergePath<TBasePath, TPath>>,
			{},
			never,
			{},
			MergePath<TBasePath, TPath>,
			TMethod,
			TRoutes,
			never,
			TCtx,
			TMeta,
			InitAccMeta<TMeta>,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>
	}

	on<const TPath extends string, const TMethods extends readonly [HttpMethod | "ALL", ...(HttpMethod | "ALL")[]]>(
		methods: TMethods,
		path: TPath,
	): BuilderChain<
		TEnv,
		TCtx & ApplyScoped<TScopedMw, MergePath<TBasePath, TPath>>,
		{},
		never,
		{},
		MergePath<TBasePath, TPath>,
		TMethods[number],
		TRoutes,
		never,
		TCtx,
		TMeta,
		InitAccMeta<TMeta>,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		const [first, ...rest] = methods
		return this._registerRoute<TPath, TMethods[number]>(
			first,
			path,
			rest.length > 0 ? (rest as (HttpMethod | "ALL")[]) : undefined,
		)
	}

	all<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "ALL">("ALL", path)
	}
	delete<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "DELETE">("DELETE", path)
	}
	get<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "GET">("GET", path)
	}
	head<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "HEAD">("HEAD", path)
	}
	options<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "OPTIONS">("OPTIONS", path)
	}
	patch<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "PATCH">("PATCH", path)
	}
	post<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "POST">("POST", path)
	}
	put<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "PUT">("PUT", path)
	}

	ws<const TPath extends string>(
		path: TPath,
	): WSRouteBuilder<
		TEnv,
		TCtx & ApplyScoped<TScopedMw, MergePath<TBasePath, TPath>>,
		{},
		never,
		Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
	> {
		return new WSRouteBuilder<
			TEnv,
			TCtx & ApplyScoped<TScopedMw, MergePath<TBasePath, TPath>>,
			{},
			never,
			Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
		>({
			boundaryErrorKey: this._defaultBoundaryKey,
			errorKeys: new Set(),
			inputSchemas: null,
			meta: null,
			middlewares: [],
			mwMeta: this._contributedMetaFor(mergePath(this._basePath, path)),
			parent: this,
			parentMiddlewares: this._chainMiddlewares,
			path: mergePath(this._basePath, path),
		})
	}

	realtime(path: string, opts: RealtimeRouteOpts): this {
		const fullPath = mergePath(this._basePath, path)

		if (!this._realtimeBus) {
			this._realtimeBus = createBus()
		}

		if (this._realtimeRoutes.has(fullPath)) {
			throw new Error(`Duplicate realtime route: ${fullPath}`)
		}

		this._realtimeRoutes.set(fullPath, {
			handler: opts.handler,
			middlewares: opts.use,
			reconnectBuffer: opts.reconnectBuffer,
		})

		const mw: RuntimeMiddleware[] = []
		if (opts.use) {
			for (const fn of opts.use) {
				mw.push(fn as RuntimeMiddleware)
			}
		}

		this._addWsRoute(parsePattern(fullPath), {
			bek: this._defaultBoundaryKey,
			ek: new Set(),
			fn: Object.create(null),
			iv: null,
			mt: null,
			mw: [...this._chainMiddlewares, ...mw],
			rp: fullPath,
		})
		return this
	}

	/**
	 * Deno must call `Deno.upgradeWebSocket` in the same turn as the serve
	 * callback. When the adapter implements `preUpgrade`, we do that here
	 * and return the 101 response before any middleware Promise.
	 */
	fetch(
		request: Request,
		env: TEnv,
		executionCtx?: { waitUntil?: (p: Promise<unknown>) => void },
	): Response | Promise<Response> {
		if (this._wsAdapter === null && !this._graph.hasWs) {
			return this._doFetch(request, env, executionCtx)
		}
		const isWsUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket"
		const headerSnap = isWsUpgrade ? new Headers(request.headers) : undefined
		const path = this.pathFromRequest(request)
		const canPreUpgrade =
			isWsUpgrade &&
			this._wsAdapter?.preUpgrade !== undefined &&
			!this.trailingSlashRedirects(path) &&
			this._matchWs(this._finalize(), this.pathAfterPrefix(path)) !== null
		const pre = canPreUpgrade ? this._wsAdapter?.preUpgrade?.(request) : undefined
		/* After Deno.upgradeWebSocket the Request is closed. A sync throw here
		 * used to be boxed by async _doFetch; keep 101 returning either way. */
		let work: Response | Promise<Response>
		try {
			work = this._doFetch(request, env, executionCtx, isWsUpgrade === true, headerSnap)
		} catch (err) {
			work = Promise.reject(err)
		}
		if (!pre) return work
		void Promise.resolve(work)
			.then((res) => {
				if (res.status === 101) return
				const code = res.status === 401 ? 4401 : 1008
				const reason = res.status === 401 ? "unauthorized" : "upgrade rejected"
				const reject = () => {
					try {
						pre.socket.close(code, reason)
					} catch {
						/* already closed */
					}
				}
				if (pre.whenOpen) pre.whenOpen(reject)
				else reject()
			})
			.catch(() => {
				try {
					pre.socket.close(1011, "internal error")
				} catch {
					/* already closed */
				}
			})
		return pre.response
	}

	private pathFromRequest(request: Request): string {
		const rawUrl = request.url
		const protoEnd = rawUrl.indexOf("//")
		const pathStart = protoEnd === -1 ? 0 : rawUrl.indexOf("/", protoEnd + 2)
		const searchOrHash = pathStart === -1 ? -1 : findSearchOrHash(rawUrl, pathStart)
		if (pathStart === -1) return "/"
		if (searchOrHash === -1) return rawUrl.substring(pathStart)
		return rawUrl.substring(pathStart, searchOrHash)
	}

	private trailingSlashRedirects(path: string): boolean {
		if (path.length <= 1) return false
		if (this._trailingSlash === "strip" && path.endsWith("/")) return true
		if (this._trailingSlash === "enforce" && !path.endsWith("/")) return true
		return false
	}

	private pathAfterPrefix(path: string): string {
		if (this._stripPrefix === null) return path
		if (path === this._stripPrefix) return "/"
		if (path.startsWith(this._stripPrefix) && path.charCodeAt(this._stripPrefix.length) === 47) {
			return path.slice(this._stripPrefix.length)
		}
		return path
	}

	private _doFetch(
		request: Request,
		env: TEnv,
		executionCtx?: { waitUntil?: (p: Promise<unknown>) => void },
		knownWsUpgrade = false,
		headerSnap?: Headers,
	): Response | Promise<Response> {
		const startTime = performance.now()
		const final = this._finalize()

		/* fast path extraction — avoids expensive new URL() allocation */
		const rawUrl = request.url
		const protoEnd = rawUrl.indexOf("//")
		const pathStart = protoEnd === -1 ? 0 : rawUrl.indexOf("/", protoEnd + 2)
		const searchOrHash = pathStart === -1 ? -1 : findSearchOrHash(rawUrl, pathStart)
		let path: string
		if (pathStart === -1) {
			path = "/"
		} else if (searchOrHash === -1) {
			path = rawUrl.substring(pathStart)
		} else {
			path = rawUrl.substring(pathStart, searchOrHash)
		}

		/* lazily create URL only when actually needed (search params, redirects) */
		let _url: URL | undefined
		const getUrl = (): URL => {
			if (_url === undefined) _url = new URL(rawUrl)
			return _url
		}

		const log = this._logger ?? undefined
		const fc: FetchCtx<TEnv> = {
			env,
			executionCtx,
			log,
			request,
			startTime,
			url: getUrl,
			wsUpgrade: knownWsUpgrade,
			headerSnap,
		}

		if (this._telemetry !== null) {
			safeFire(() => this._telemetry?.onRequest?.({ env, req: request }), log)
		}

		/* trailing slash handling */
		if (path.length > 1) {
			if (this._trailingSlash === "strip" && path.endsWith("/")) {
				const redirectUrl = getUrl()
				redirectUrl.pathname = path.slice(0, -1)
				return new Response(null, {
					headers: { location: redirectUrl.toString() },
					status: 308,
				})
			}
			if (this._trailingSlash === "enforce" && !path.endsWith("/")) {
				const redirectUrl = getUrl()
				redirectUrl.pathname = `${path}/`
				return new Response(null, {
					headers: { location: redirectUrl.toString() },
					status: 308,
				})
			}
		}

		/* prefix stripping — must run AFTER trailing slash so redirects preserve the full prefixed URL */
		if (this._stripPrefix !== null) {
			if (path === this._stripPrefix) {
				path = "/"
			} else if (path.startsWith(this._stripPrefix) && path.charCodeAt(this._stripPrefix.length) === 47) {
				path = path.slice(this._stripPrefix.length)
			}
		}

		const root = this._graph.root

		/* WebSocket route check — do not re-read headers after Deno.upgradeWebSocket */
		const isWsUpgrade = knownWsUpgrade || requestIsWsUpgrade(request)
		if (isWsUpgrade) {
			const wsMatch = this._matchWs(final, path)
			if (wsMatch !== null) {
				return this._handleWs(fc, wsMatch)
			}
		}

		const method = request.method.toUpperCase() as HttpMethod

		/* O(1) static route lookup — patterns without params or wildcards only */
		const staticHit =
			final.statics[`${method} ${path}`] ?? (method === "HEAD" ? final.statics[`GET ${path}`] : undefined)
		if (staticHit !== undefined) {
			return this._dispatchRecord(fc, method, path, staticHit, EMPTY_PARAMS)
		}

		const result = matchRoute(root, method, path)
		if (result === null) {
			/* no HTTP route: a websocket or realtime route on this path asks for an upgrade */
			if (!isWsUpgrade && this._graph.hasWs) {
				const wsMatch = this._matchWs(final, path)
				if (wsMatch !== null) {
					if (this._realtimeRoutes.has(wsMatch.handler.rp)) {
						return new Response(null, { headers: { upgrade: "websocket" }, status: 426 })
					}
					return new Response("Upgrade Required", {
						headers: { connection: "Upgrade", upgrade: "websocket" },
						status: 426,
					})
				}
			}
			return this._handle404(fc, method, path)
		}
		if (!result.matched) {
			if (
				method === "OPTIONS" &&
				fc.request.headers.has("access-control-request-method") &&
				result.allowed.length > 0
			) {
				const fallback = this._preflightFallbackMethod(result.allowed)
				const retry = matchRoute(root, fallback, path)
				const retryRecord = retry?.matched ? final.byId.get(retry.id) : undefined
				if (retry?.matched && retryRecord !== undefined) {
					return this._handleCorsPreflight(fc, path, retryRecord, retry.params, result.allowed)
				}
			}
			return this._handle405(fc, method, path, result.allowed)
		}
		const record = final.byId.get(result.id)
		if (record === undefined) return this._handle404(fc, method, path)
		return this._dispatchRecord(fc, method, path, record, result.params)
	}

	private _matchWs(
		final: FinalTable,
		path: string,
	): { handler: WSRouteHandler; params: Record<string, string> } | null {
		const hit = matchWsRoute(this._graph.root, path)
		if (hit === null) return null
		const handler = final.wsById.get(hit.id)
		return handler === undefined ? null : { handler, params: hit.params }
	}

	private _dispatchRecord(
		fc: FetchCtx<TEnv>,
		method: HttpMethod,
		path: string,
		record: RouteHandler,
		params: Record<string, string>,
	): Response | Promise<Response> {
		if (record.fn === NOT_SERVED) return this._handle404(fc, method, path)
		/* a delegated route keeps its own input schemas for docs and the 415 check; the body
		 * itself belongs to whatever the catch-all forwards it to */
		if (record.dl === true && record.iv) {
			try {
				assertRequestContentType(record.iv, fc.request)
			} catch (thrown) {
				return this._toErrorResponse(thrown)
			}
		}
		return this._handleMatched(fc, method, path, record, params)
	}

	private _makeErrorCtx(fc: FetchCtx<TEnv>, allowed?: string[]) {
		return {
			env: fc.env,
			jsonFromError: (err: HoneyError) => createErrorResponse(err, this._errorFormatter, this._customErrorFormatter),
			req: fc.request,
			...(allowed ? { allowed } : {}),
		}
	}

	private async _handleWs(
		fc: FetchCtx<TEnv>,
		wsMatch: { handler: WSRouteHandler; params: Record<string, string> },
	): Promise<Response> {
		/* Dispatch to realtime handler if this path is registered as a realtime route */
		const realtimeConfig = this._realtimeRoutes.get(wsMatch.handler.rp)
		if (realtimeConfig) {
			return this._handleRealtime(fc, wsMatch, realtimeConfig)
		}

		const isUpgrade = fc.wsUpgrade === true || requestIsWsUpgrade(fc.request)
		if (!isUpgrade) {
			return new Response(null, {
				headers: { upgrade: "websocket" },
				status: 426,
			})
		}

		const wsAdapter = this._wsAdapter
		if (!wsAdapter) {
			fc.log?.warn?.("WebSocket adapter not configured — call .wsAdapter()")
			return createErrorResponse(
				this._createError(EK.internal_server_error, SK.internal_server_error),
				this._errorFormatter,
				this._customErrorFormatter,
			)
		}

		const wsCtx = new HoneyContext({
			env: fc.env,
			executionCtx: fc.executionCtx,
			params: wsMatch.params,
			req: ctxRequest(fc),
			urlFn: fc.url,
		})
		if (this._contextValues) Object.assign(wsCtx, this._contextValues)

		/*
		 * WS ordering: [global → scoped → chain+handler-route-specific]
		 * WS bakes chain mw into handler.mw at registration, so scoped runs before chain.
		 * This is an unavoidable inconsistency vs HTTP (where chain runs before scoped).
		 */
		const scopedForPath = this._filterScopedForPath(wsMatch.handler.rp)
		const allWsMw: RuntimeMiddleware[] = [...this._globalMiddlewares, ...scopedForPath, ...wsMatch.handler.mw]

		try {
			return await executeChain(allWsMw, wsCtx, async (finalCtx) => {
				const userHandler = wsMatch.handler.fn
				let messageQueue: Promise<void> = Promise.resolve()

				const onOpenFn = userHandler.onOpen
				const onMsgFn = userHandler.onMessage
				const onCloseFn = userHandler.onClose
				const onErrorFn = userHandler.onError
				const onReconnectFn = userHandler.onReconnect
				const reconnectToken = fc.url().searchParams.get("reconnect_token")

				const wrappedHandler: WSHandler<unknown> = {}

				if (reconnectToken && onReconnectFn) {
					wrappedHandler.onOpen = (_ctx, ws) => {
						onReconnectFn(finalCtx, ws, reconnectToken)
					}
				} else if (onOpenFn) {
					wrappedHandler.onOpen = (_ctx, ws) => {
						onOpenFn(finalCtx, ws)
					}
				}

				if (onMsgFn) {
					wrappedHandler.onMessage = (_ctx, ws, data) => {
						messageQueue = messageQueue
							.then(() => onMsgFn(finalCtx, ws, data))
							.catch((err: unknown) => {
								onErrorFn?.(finalCtx, ws, err)
							})
					}
				}

				if (onCloseFn) {
					wrappedHandler.onClose = (_ctx, ws, code, reason) => {
						onCloseFn(finalCtx, ws, code, reason)
					}
				}

				if (onErrorFn) {
					wrappedHandler.onError = (_ctx, ws, error) => {
						onErrorFn(finalCtx, ws, error)
					}
				}

				const upgradeResult = await wsAdapter.upgrade(fc.request, fc.env, wrappedHandler)
				return upgradeResult.response
			})
		} catch (thrown) {
			return this._toErrorResponse(thrown)
		}
	}

	private async _handleRealtime(
		fc: FetchCtx<TEnv>,
		wsMatch: { handler: WSRouteHandler; params: Record<string, string> },
		config: { handler: RealtimeRouteOpts["handler"]; middlewares?: RealtimeRouteOpts["use"]; reconnectBuffer?: number },
	): Promise<Response> {
		const isUpgrade = fc.wsUpgrade === true || requestIsWsUpgrade(fc.request)
		if (!isUpgrade) {
			return new Response(null, {
				headers: { upgrade: "websocket" },
				status: 426,
			})
		}

		const wsAdapter = this._wsAdapter
		if (!wsAdapter) {
			fc.log?.warn?.("WebSocket adapter not configured — call .wsAdapter()")
			return createErrorResponse(
				this._createError(EK.internal_server_error, SK.internal_server_error),
				this._errorFormatter,
				this._customErrorFormatter,
			)
		}

		/* Lazily create bus if not yet initialized (happens when realtime() was called on a child chain) */
		if (!this._realtimeBus) {
			this._realtimeBus = createBus()
		}
		const bus = this._realtimeBus

		const ctx = new HoneyContext({
			env: fc.env,
			executionCtx: fc.executionCtx,
			params: wsMatch.params,
			req: ctxRequest(fc),
			urlFn: fc.url,
		})
		if (this._contextValues) Object.assign(ctx, this._contextValues)
		Object.assign(ctx, {
			realtime: { publish: (topic: string, data: unknown) => bus.publish(topic, data) },
		})

		const scopedForPath = this._filterScopedForPath(wsMatch.handler.rp)
		const allMw: RuntimeMiddleware[] = [...this._globalMiddlewares, ...scopedForPath, ...wsMatch.handler.mw]

		try {
			return await executeChain(allMw, ctx, async (finalCtx) => {
				const connId = crypto.randomUUID()

				let socket: WSContext<unknown> | null = null
				let conn: ReturnType<typeof createConnContext> | null = null

				/*
				 * initConn creates the ConnContext and calls the user handler.
				 * Called from onOpen (for Bun where socket arrives later)
				 * or inline after upgrade (for Node/CF where socket is immediate).
				 */
				const initConn = (ws: WSContext<unknown>) => {
					socket = ws
					conn = createConnContext({
						bus,
						closeFn: (reason) => {
							if (socket) socket.close(1000, reason)
						},
						id: connId,
						sendFn: (payload) => {
							if (socket)
								socket.send(typeof payload === "object" && payload !== null ? JSON.stringify(payload) : String(payload))
						},
						transport: "ws",
						userId: null,
					})

					bus.onMessage(connId, (data) => {
						if (socket) {
							socket.send(typeof data === "object" && data !== null ? JSON.stringify(data) : String(data))
						}
					})

					config.handler(finalCtx, conn)
				}

				const wrappedHandler: WSHandler<unknown> = {
					onClose: (_ctx, _ws, _code, reason) => {
						if (!conn) return
						const handlers = conn._handlers
						if (handlers.close) {
							handlers.close(reason || "normal")
						}
						bus.unsubscribeAll(connId)
						bus.removeHandler(connId)
					},
					onMessage: (_ctx, _ws, data) => {
						if (!conn) return
						const handlers = conn._handlers
						if (handlers.message && typeof data === "string") {
							try {
								const parsed: unknown = JSON.parse(data)
								if (isMsgFrame(parsed)) {
									handlers.message(parsed.data)
								}
							} catch {
								/* ignore malformed frames */
							}
						}
					},
					onOpen: (_ctx, ws) => {
						if (!socket) initConn(ws)
					},
				}

				const upgradeResult = await wsAdapter.upgrade(fc.request, fc.env, wrappedHandler)

				/* Node/CF adapters return the socket from upgrade(); Bun returns undefined (socket comes via onOpen).
				 * Deno pre-upgrade may still be CONNECTING — wait for onOpen so the first send is not dropped. */
				if (upgradeResult.socket && !socket && upgradeResult.socket.readyState === 1) {
					initConn(upgradeResult.socket)
				}

				return upgradeResult.response
			})
		} catch (thrown) {
			return this._toErrorResponse(thrown)
		}
	}

	private async _handle404(fc: FetchCtx<TEnv>, method: string, path: string): Promise<Response> {
		safeFire(() => this._telemetry?.onNotFound?.({ method, path, req: fc.request }), fc.log)
		const make404 = () => {
			if (this._onNotFound) {
				return this._onNotFound(this._makeErrorCtx(fc))
			}
			return this._makeErrorCtx(fc).jsonFromError(this._createError(EK.not_found, SK.not_found))
		}
		try {
			const ctx404 = new HoneyContext({
				env: fc.env,
				executionCtx: fc.executionCtx,
				params: {},
				req: fc.request,
				urlFn: fc.url,
			})
			if (this._contextValues) Object.assign(ctx404, this._contextValues)
			const res =
				this._chainMiddlewares.length > 0
					? await executeChain(this._chainMiddlewares, ctx404, make404)
					: await make404()
			safeFire(
				() =>
					this._telemetry?.onResponse?.({
						duration: performance.now() - fc.startTime,
						req: fc.request,
						status: res.status,
					}),
				fc.log,
			)
			return res
		} catch (thrown) {
			return this._toErrorResponse(thrown)
		}
	}

	private _preflightFallbackMethod(allowed: string[]): HttpMethod {
		if (allowed.includes("GET")) return "GET"
		if (allowed.includes("HEAD")) return "HEAD"
		if (allowed.includes("POST")) return "POST"
		return allowed[0] as HttpMethod
	}

	/** Run the existing method's middleware for a CORS preflight. Do not invoke the route handler. */
	private async _handleCorsPreflight(
		fc: FetchCtx<TEnv>,
		path: string,
		handler: RouteHandler,
		params: Record<string, string>,
		allowed: string[],
	): Promise<Response> {
		const ctx = new HoneyContext({
			env: fc.env,
			executionCtx: fc.executionCtx,
			meta: handler.mt ? Object.freeze(handler.mt) : undefined,
			params,
			path,
			req: fc.request,
			routePattern: handler.rp ?? "",
			urlFn: fc.url,
		})
		if (this._contextValues) Object.assign(ctx, this._contextValues)
		try {
			return await executeChain([...this._globalMiddlewares, ...handler.mw], ctx, () =>
				this._handle405(fc, "OPTIONS", path, allowed),
			)
		} catch (thrown) {
			return this._toErrorResponse(thrown)
		}
	}

	private async _handle405(fc: FetchCtx<TEnv>, method: string, path: string, allowed: string[]): Promise<Response> {
		safeFire(
			() =>
				this._telemetry?.onMethodNotAllowed?.({
					allowed,
					method,
					path,
					req: fc.request,
				}),
			fc.log,
		)
		const make405 = async () => {
			if (this._onMethodNotAllowed) {
				const res = await this._onMethodNotAllowed(
					this._makeErrorCtx(fc, allowed) as {
						allowed: string[]
						env: TEnv
						jsonFromError: (err: HoneyError) => Response
						req: Request
					},
				)
				const responseHeaders = new Headers(res.headers)
				responseHeaders.set("allow", allowed.join(", "))
				return new Response(res.body, {
					headers: responseHeaders,
					status: res.status,
				})
			}
			const err = this._createError(EK.method_not_allowed, SK.method_not_allowed)
			const res = this._makeErrorCtx(fc).jsonFromError(err)
			const responseHeaders = new Headers(res.headers)
			responseHeaders.set("allow", allowed.join(", "))
			return new Response(res.body, {
				headers: responseHeaders,
				status: res.status,
			})
		}
		try {
			const ctx405 = new HoneyContext({
				env: fc.env,
				executionCtx: fc.executionCtx,
				params: {},
				req: fc.request,
				urlFn: fc.url,
			})
			if (this._contextValues) Object.assign(ctx405, this._contextValues)
			const finalRes =
				this._chainMiddlewares.length > 0
					? await executeChain(this._chainMiddlewares, ctx405, make405)
					: await make405()
			safeFire(
				() =>
					this._telemetry?.onResponse?.({
						duration: performance.now() - fc.startTime,
						req: fc.request,
						status: finalRes.status,
					}),
				fc.log,
			)
			return finalRes
		} catch (thrown) {
			return this._toErrorResponse(thrown)
		}
	}

	private _handleMatched(
		fc: FetchCtx<TEnv>,
		method: HttpMethod,
		path: string,
		handler: RouteHandler,
		params: Record<string, string>,
	): Response | Promise<Response> {
		const { env, executionCtx, log, request } = fc

		/* resolve error factory — pre-computed ef preferred, else build/use global */
		let errors: Record<string, (...args: never[]) => unknown> | undefined
		if (handler.ef != null) {
			errors = handler.ef
		} else if (this._errorFactory !== null) {
			if (handler.ek.size > 0) {
				const factory = this._errorFactory as Record<string, (...args: never[]) => unknown>
				const subset = Object.create(null) as Record<string, unknown>
				for (const key of handler.ek) {
					if (key in factory) {
						subset[key] = factory[key]
					}
				}
				errors = Object.freeze(subset) as Record<string, (...args: never[]) => unknown>
			} else {
				errors = this._errorFactory as Record<string, (...args: never[]) => unknown>
			}
		}

		const resolvedMeta = handler.mt

		const ctx = new HoneyContext({
			env,
			executionCtx,
			meta: resolvedMeta ?? undefined,
			params,
			path,
			req: request,
			routePattern: handler.rp ?? "",
			urlFn: fc.url,
		})
		if (this._contextValues) Object.assign(ctx, this._contextValues)
		if (this._realtimeBus) {
			const rtBus = this._realtimeBus
			Object.assign(ctx, {
				realtime: { publish: (topic: string, data: unknown) => rtBus.publish(topic, data) },
			})
		}
		if (errors) {
			ctx._setErrors(errors)
		}

		if (this._telemetry !== null) {
			try {
				this._telemetry.onRoute?.({ method, params, path, req: request })
			} catch {
				/* telemetry must not crash request */
			}
		}

		/*
		 * Tier 3: Use pre-compiled chain when possible.
		 * Compiled chains are cached on the handler — created once, reused per request.
		 * Falls back to dynamic assembly when telemetry wrapping, input validation, or
		 * scoped middleware is in play (scoped mw cannot be baked into the compiled cache
		 * because each route may match a different subset).
		 */
		const hasTelemetryMw = this._telemetry?.onMiddleware !== undefined
		/* a delegated route's schemas document it; the body is forwarded, never validated here */
		const hasInputValidation = handler.iv != null && handler.dl !== true

		/*
		 * Error resolver — stored on ctx so the cached handler wrapper can read it.
		 * Converts handler errors into error Responses inside the middleware chain,
		 * allowing all post-next() middleware code (headers, logging, timing) to run.
		 */
		ctx._errorToResponse = (thrown: unknown) => this._resolveErrorResponse(thrown, handler, fc, method, path, ctx)

		const onError = (thrown: unknown): Response | Promise<Response> => {
			if (ctx._errorToResponse) return ctx._errorToResponse(thrown)
			return this._toErrorResponse(thrown)
		}

		const after = (response: Response): Response | Promise<Response> => {
			try {
				const done = this._afterMatched(fc, method, path, handler, ctx, response)
				if (done instanceof Promise) return done.catch(onError)
				return done
			} catch (thrown) {
				return onError(thrown)
			}
		}

		try {
			if (!hasTelemetryMw && !hasInputValidation && this._scopedMiddlewares.length === 0) {
				if (!handler._compiled) {
					const chainMw = this._chainMiddlewares
					const handlerHasChain = chainMw.length > 0 && chainMw.every((mw, i) => handler.mw[i] === mw)
					const allMw = handlerHasChain
						? [...this._globalMiddlewares, ...handler.mw]
						: [...this._globalMiddlewares, ...chainMw, ...handler.mw]
					handler._compiled = compileChain(allMw, (c) => {
						try {
							const result = handler.fn(c)
							if (result instanceof Promise) {
								return result.catch((thrown: unknown) => {
									const hCtx = c as HoneyContext<TEnv>
									if (hCtx._errorToResponse) return hCtx._errorToResponse(thrown)
									throw thrown
								})
							}
							return result
						} catch (thrown) {
							const hCtx = c as HoneyContext<TEnv>
							if (hCtx._errorToResponse) return hCtx._errorToResponse(thrown)
							throw thrown
						}
					})
				}
				const result = handler._compiled(ctx)
				if (result instanceof Promise) return result.then(after, onError)
				return after(result)
			}

			const scopedForPath = this._filterScopedForPath(handler.rp ?? "")
			const chainMw = this._chainMiddlewares
			const handlerHasChain = chainMw.length > 0 && chainMw.every((mw, i) => handler.mw[i] === mw)
			/*
			 * Ordering: [global → chain → scoped → handler-route-specific]
			 * When handlerHasChain, handler.mw = [chain..., routeSpecific...].
			 * Scoped must go after chain but before route-specific, so we split.
			 */
			let allMiddlewares: RuntimeMiddleware[] = handlerHasChain
				? [
						...this._globalMiddlewares,
						...handler.mw.slice(0, chainMw.length),
						...scopedForPath,
						...handler.mw.slice(chainMw.length),
					]
				: [...this._globalMiddlewares, ...chainMw, ...scopedForPath, ...handler.mw]

			if (hasTelemetryMw) {
				const onMw = this._telemetry?.onMiddleware
				if (onMw) {
					allMiddlewares = allMiddlewares.map((mw) => {
						const name = mw.name || "anonymous"
						const wrapped: RuntimeMiddleware = async (wCtx, wNext) => {
							const mwStart = performance.now()
							try {
								const res = await mw(wCtx, wNext)
								safeFire(() => onMw({ duration: performance.now() - mwStart, name }), log)
								return res
							} catch (error) {
								safeFire(
									() =>
										onMw({
											duration: performance.now() - mwStart,
											error,
											name,
										}),
									log,
								)
								throw error
							}
						}
						return wrapped
					})
				}
			}

			if (hasInputValidation) {
				const schemas = handler.iv
				if (schemas) {
					const inputMw: RuntimeMiddleware = async (inputCtx, inputNext) => {
						const validated = await validateInput(schemas, inputCtx["req"] as Request, params)
						return inputNext({ input: validated })
					}
					allMiddlewares.push(inputMw)
				}
			}

			return executeChain(allMiddlewares, ctx, (finalCtx) => {
				try {
					const result = handler.fn(finalCtx)
					if (result instanceof Promise) {
						return result.catch((thrown: unknown) => {
							const hCtx = finalCtx as HoneyContext<TEnv>
							if (hCtx._errorToResponse) return hCtx._errorToResponse(thrown)
							throw thrown
						})
					}
					return result
				} catch (thrown) {
					const hCtx = finalCtx as HoneyContext<TEnv>
					if (hCtx._errorToResponse) return hCtx._errorToResponse(thrown)
					throw thrown
				}
			}).then(after, onError)
		} catch (thrown) {
			/* safety net — middleware-level errors (input validation, middleware crash) */
			return onError(thrown)
		}
	}

	private _afterMatched(
		fc: FetchCtx<TEnv>,
		method: HttpMethod,
		path: string,
		handler: RouteHandler,
		ctx: HoneyContext<TEnv>,
		response: Response,
	): Response | Promise<Response> {
		const validateOut =
			this._outputValidation === "always" ||
			(this._outputValidation === "dev" &&
				(globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== "production")
		if (handler.os && validateOut && response.body !== null && !ctx._isErrorResponse) {
			return this._validateThenFinish(fc, method, path, handler, ctx, response)
		}
		return this._finishMatched(fc, method, path, handler, ctx, response)
	}

	private async _validateThenFinish(
		fc: FetchCtx<TEnv>,
		method: HttpMethod,
		path: string,
		handler: RouteHandler,
		ctx: HoneyContext<TEnv>,
		response: Response,
	): Promise<Response> {
		const ct = response.headers.get("content-type")

		/* content-type mismatch check */
		if (ct && handler.os) {
			const declaredTypes = Object.keys(handler.os)
			const matches = declaredTypes.some((t) => ct.startsWith(t))
			if (!matches) {
				throw new HoneyError({
					errorKey: EK.output_content_type_mismatch,
					status: SK.internal_server_error,
				})
			}
		}

		/* JSON schema validation — read original, return clone (Bun clone() drains original) */
		if (ct?.startsWith("application/json") && handler.ov) {
			const sk = codeToStatusKey[response.status]
			if (sk) {
				const forReturn = response.clone()
				const data: unknown = await response.json()
				await handler.ov(sk, data)
				response = forReturn
			}
		}
		return this._finishMatched(fc, method, path, handler, ctx, response)
	}

	private _finishMatched(
		fc: FetchCtx<TEnv>,
		method: HttpMethod,
		path: string,
		handler: RouteHandler,
		ctx: HoneyContext<TEnv>,
		response: Response,
	): Response {
		/* taps — fire after successful handler, non-blocking */
		if (this._taps !== null && !ctx._isErrorResponse) {
			const taps = this._taps
			const log = fc.log

			/* meta-driven taps — fire for each registered key found in route meta */
			if (handler.mt !== null) {
				for (const [key, tapFn] of taps) {
					const metaValue = handler.mt[key]
					if (metaValue !== undefined) {
						ctx.background(
							Promise.resolve()
								.then(() => tapFn(ctx, metaValue))
								.catch((e) => log?.warn?.({ err: e, tap: key }, "tap failed")),
						)
					}
				}
			}

			/* dynamic taps — fire for each c.tap() call */
			if (ctx._pendingTaps !== null) {
				for (const pending of ctx._pendingTaps) {
					const tapFn = taps.get(pending.key)
					if (tapFn !== undefined) {
						ctx.background(
							Promise.resolve()
								.then(() => tapFn(ctx, pending.payload))
								.catch((e) => log?.warn?.({ err: e, tap: pending.key }, "tap failed")),
						)
					}
				}
				ctx._pendingTaps = null
			}
		}

		if (this._telemetry !== null) {
			try {
				const duration = performance.now() - fc.startTime
				this._telemetry.onHandler?.({
					duration,
					method,
					path,
					status: response.status,
				})
				this._telemetry.onResponse?.({
					duration,
					req: fc.request,
					status: response.status,
				})
			} catch {
				/* telemetry must never crash the response path */
			}
		}
		/* HEAD responses must have empty body — preserve headers + status */
		if (method === "HEAD") {
			return new Response(null, {
				headers: response.headers,
				status: response.status,
			})
		}
		return response
	}
}

/*
 * Handler Type Algebra
 * These types compose the handler context from route configuration.
 * NarrowMethod → ApplyOutput → ApplyParams → HandlerCtx
 */

/**
 * When content type IS declared → narrow the method (constrain status keys + body).
 * When content type NOT declared → remove the method (Omit).
 * Narrowed methods return TypedResponse<CT, K> for compile-time CT+SK safety.
 */
/** Resolve body type: schema → InferOutput, plain type → use as-is */
type ResolveBody<T, TBody> = TBody extends "infer" ? (T extends StandardSchemaLike ? InferOutput<T> : T) : TBody

type NarrowMethod<TRes, TSchemas, Method extends string, CT extends string, TBody> = [TSchemas] extends [never]
	? Omit<TRes, Method>
	: TSchemas extends Record<string, unknown>
		? Omit<TRes, Method> & {
				[M in Method]: <K extends keyof TSchemas & string>(
					statusKey: K,
					body: ResolveBody<TSchemas[K], TBody>,
					opts?: ResponseOptions,
				) => TypedResponse<CT, K>
			}
		: Omit<TRes, Method>

/**
 * SSE uses a callback signature, not statusKey+body like other methods.
 * Gate presence on text/event-stream declaration, preserve original signature.
 */
type NarrowSSE<TOutput> = [ExtractSchemas<TOutput, "text/event-stream">] extends [never] ? {} : { sse: HoneyRes["sse"] }

/** Universal methods — always available, not gated by output declaration */
type UniversalRes = Pick<HoneyRes, "noContent" | "raw" | "redirect" | "stream">

/**
 * Constrain ctx.res when output schemas are declared.
 * Declared content types → method constrained (status keys + body type).
 * Undeclared content types → method removed.
 * Universal methods (noContent, redirect, stream, raw) always available.
 * HoneyContext has no private brand, so Omit<TCtx, "res"> replaces the wide HoneyRes.
 */
type ApplyOutput<TCtx, TOutput> = [keyof TOutput] extends [never]
	? TCtx
	: Omit<TCtx, "res"> & {
			readonly res: UniversalRes &
				NarrowMethod<{}, ExtractSchemas<TOutput, "application/json">, "json", "application/json", "infer"> &
				NarrowMethod<{}, ExtractSchemas<TOutput, "text/plain">, "text", "text/plain", string> &
				NarrowMethod<{}, ExtractSchemas<TOutput, "text/html">, "html", "text/html", string> &
				NarrowMethod<{}, ExtractSchemas<TOutput, "application/xml">, "xml", "application/xml", string> &
				NarrowMethod<{}, ExtractSchemas<TOutput, "text/csv">, "csv", "text/csv", string> &
				NarrowMethod<
					{},
					ExtractSchemas<TOutput, "application/octet-stream">,
					"binary",
					"application/octet-stream",
					ArrayBuffer | Uint8Array<ArrayBuffer>
				> &
				NarrowSSE<TOutput>
		}

/** Public alias for codegen — applies output schema constraints to a context type */
export type WithOutput<TCtx, TOutput> = ApplyOutput<TCtx, TOutput>

/** @internal — tuple entry describing a scoped middleware at the type level */
type ScopedMwEntry = { readonly path: string; readonly adds: unknown }

/**
 * Walk TScopedMw tuple, intersect `adds` for every entry whose `path` is a prefix of TFullPath.
 * Prefix semantics: TFullPath extends `${P}` (exact) | `${P}/${string}` (descendant).
 *
 * Non-literal-path guard: if Head["path"] is the base `string` type (happens when
 * the user passes a widened variable), skip the entry via `string extends Head["path"] ? {}`.
 * This prevents the always-true `'/anywhere' extends string` from polluting every route.
 */
type ApplyScoped<TScopedMw extends readonly ScopedMwEntry[], TFullPath extends string> = TScopedMw extends readonly [
	infer Head extends ScopedMwEntry,
	...infer Rest extends readonly ScopedMwEntry[],
]
	? (string extends Head["path"]
			? {}
			: TFullPath extends Head["path"]
				? Head["adds"]
				: TFullPath extends `${Head["path"] & string}/${string}`
					? Head["adds"]
					: {}) &
			ApplyScoped<Rest, TFullPath>
	: {}

/** @internal — runtime entry for a scoped middleware */
type ScopedEntry = {
	/** merged full-path prefix (already rebased against basePath at .use time) */
	prefix: string
	mw: RuntimeMiddleware
	/** cached from mw.errors at registration; undefined when none */
	errors: readonly string[] | undefined
}

/** Apply typed params — override params with specific keys when route has :param segments */
type ApplyParams<TCtx, TParams> = [keyof TParams] extends [string]
	? string extends keyof TParams
		? TCtx
		: TCtx & { readonly params: TParams }
	: TCtx

/** Typed tap method — constrained to registered tap keys when TTaps is non-empty */
type TypedTap<TTaps extends Record<string, unknown>> = [keyof TTaps] extends [never]
	? { tap(key: string, payload: unknown): void }
	: { tap<K extends string & keyof TTaps>(key: K, payload: TTaps[K]): void }

/** Build the full handler context: base ctx + params + input + meta + errors + taps + output-constrained methods */
type HandlerCtx<
	TCtx,
	TInput,
	TOutput,
	TParams,
	TAccMeta = {},
	TErrorFactory = never,
	TErrorKeys extends string = never,
	TPath extends string = string,
	TTaps extends Record<string, unknown> = {},
> = ApplyOutput<
	ApplyParams<[keyof TInput] extends [never] ? TCtx : TCtx & { input: TInput }, TParams> & {
		readonly meta: Readonly<Omit<TAccMeta, "openApi">>
		readonly routePattern: TPath
	} & ([TErrorFactory] extends [never]
			? {}
			: [TErrorKeys] extends [never]
				? { readonly errors: TErrorFactory }
				: {
						readonly errors: Pick<TErrorFactory, TErrorKeys & keyof TErrorFactory>
					}) &
		TypedTap<TTaps>,
	TOutput
>

/** @internal — exposes private Honey members for RouteBuilder/WSRouteBuilder access */
type HoneyInternal = {
	_addRoute(method: string, segments: readonly Segment[], record: RouteHandler): void
	_addWsRoute(segments: readonly Segment[], record: WSRouteHandler): void
	_factory: unknown
}

type RouteBuilderState<TParent> = {
	boundaryErrorKey: string | null
	errorKeys: Set<string>
	extraMethods: (HttpMethod | "ALL")[] | null
	inputSchemas: InputSchemasDef | null
	meta: Record<string, unknown> | null
	/** meta contributed by middleware — kept apart so explicit .meta() always outranks it */
	mwMeta: Record<string, unknown> | null
	method: HttpMethod | "ALL"
	middlewares: RuntimeMiddleware[]
	outputSchemas: OutputSchemaDef | null
	parent: TParent
	parentMiddlewares: RuntimeMiddleware[]
	/** canonical full pattern */
	path: string
}

/**
 * Route meta = middleware-contributed meta, overlaid by everything stated explicitly
 * (chain `.meta()`, then route `.meta()`). Explicit always wins.
 */
function mergeContributedMeta(
	contributed: Record<string, unknown> | null | undefined,
	explicit: Record<string, unknown> | null,
): Record<string, unknown> | null {
	if (!contributed) return explicit ? Object.freeze(explicit) : null
	return Object.freeze(explicit ? { ...contributed, ...explicit } : { ...contributed })
}

/** Honey.TMeta defaults to never; never & X is never, so start acc meta at {}. */
type InitAccMeta<TMeta> = [TMeta] extends [never] ? {} : TMeta

/** Skip $routes merge only for a real `{ internal: true }` meta — not for `never`. */
type SkipRouteRecord<TAccMeta> = [TAccMeta] extends [never]
	? false
	: [TAccMeta] extends [{ internal: true }]
		? true
		: false

/** Return type for handler() — extracted to avoid 3x duplication */
type HandlerReturn<
	TEnv,
	TBaseCtx,
	TRoutes,
	TPath extends string,
	TMethod extends string,
	TInput,
	TOutput,
	TCtx,
	TAccMeta,
	TErrorFactory,
	_TErrorKeys extends string,
	TDefaultErrors extends string,
	TMeta,
	TBasePath extends string = "/",
	TTaps extends Record<string, unknown> = {},
	TScopedMw extends readonly ScopedMwEntry[] = [],
> = Honey<
	TEnv,
	TBaseCtx,
	SkipRouteRecord<TAccMeta> extends true
		? TRoutes
		: MergeRoute<
				TRoutes,
				TPath,
				TMethod,
				TInput,
				TOutput,
				HandlerCtx<
					TCtx,
					TInput,
					TOutput,
					ParamsFromPath<TPath>,
					TAccMeta,
					TErrorFactory,
					_TErrorKeys | TDefaultErrors,
					TPath,
					TTaps
				>,
				TAccMeta,
				_TErrorKeys | TDefaultErrors,
				ComputeErrorsByStatus<TErrorFactory, _TErrorKeys | TDefaultErrors, typeof ERROR_META>
			>,
	TMeta,
	TErrorFactory,
	TDefaultErrors,
	TBasePath,
	TTaps,
	TScopedMw
>

type OneShotKey = "boundary" | "errors" | "input" | "meta" | "output"

type BuilderChain<
	TEnv,
	TCtx,
	TInput,
	TErrorKeys extends string,
	TOutput,
	TPath extends string,
	TMethod extends string,
	TRoutes,
	TUsed extends string,
	TBaseCtx,
	TMeta,
	TAccMeta,
	TErrorFactory,
	TDefaultErrors extends string,
	TBasePath extends string,
	TTaps extends Record<string, unknown> = {},
	TScopedMw extends readonly ScopedMwEntry[] = [],
> = Omit<
	RouteBuilder<
		TEnv,
		TCtx,
		TInput,
		TErrorKeys,
		TOutput,
		TPath,
		TMethod,
		TRoutes,
		TUsed,
		TBaseCtx,
		TMeta,
		TAccMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	>,
	TUsed & OneShotKey
>

class RouteBuilder<
	TEnv,
	TCtx,
	TInput = {},
	_TErrorKeys extends string = never,
	TOutput = {},
	TPath extends string = string,
	TMethod extends string = string,
	TRoutes = {},
	TUsed extends string = never,
	TBaseCtx = TCtx,
	TMeta = never,
	TAccMeta = {},
	TErrorFactory = never,
	TDefaultErrors extends string = never,
	TBasePath extends string = "/",
	TTaps extends Record<string, unknown> = {},
	TScopedMw extends readonly ScopedMwEntry[] = [],
> {
	private _s: RouteBuilderState<
		Honey<TEnv, TBaseCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
	>

	constructor(
		state: RouteBuilderState<
			Honey<TEnv, TBaseCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
		>,
	) {
		this._s = state
	}

	errors<
		TFactory extends Record<string, (...args: never[]) => unknown>,
		TKeys extends Exclude<keyof TFactory & string, TDefaultErrors>,
	>(
		factory: TFactory,
		...keys: TKeys[]
	): BuilderChain<
		TEnv,
		TCtx,
		TInput,
		_TErrorKeys | TKeys,
		TOutput,
		TPath,
		TMethod,
		TRoutes,
		TUsed | "errors",
		TBaseCtx,
		TMeta,
		TAccMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	>
	errors<
		TKeys extends ([TErrorFactory] extends [never] ? never : Exclude<keyof TErrorFactory & string, TDefaultErrors>),
	>(
		...keys: TKeys[]
	): BuilderChain<
		TEnv,
		TCtx,
		TInput,
		_TErrorKeys | TKeys,
		TOutput,
		TPath,
		TMethod,
		TRoutes,
		TUsed | "errors",
		TBaseCtx,
		TMeta,
		TAccMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	>
	errors(
		...args: unknown[]
	): BuilderChain<
		TEnv,
		TCtx,
		TInput,
		string,
		TOutput,
		TPath,
		TMethod,
		TRoutes,
		TUsed | "errors",
		TBaseCtx,
		TMeta,
		TAccMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		const keys = typeof args[0] === "object" && args[0] !== null ? (args.slice(1) as string[]) : (args as string[])
		for (const k of keys) {
			this._s.errorKeys.add(k)
		}
		return new RouteBuilder<
			TEnv,
			TCtx,
			TInput,
			string,
			TOutput,
			TPath,
			TMethod,
			TRoutes,
			TUsed | "errors",
			TBaseCtx,
			TMeta,
			TAccMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>({
			...this._s,
			errorKeys: this._s.errorKeys,
		})
	}

	boundary<
		TKey extends ([TErrorFactory] extends [never] ? never : Exclude<keyof TErrorFactory & string, TDefaultErrors>),
	>(
		key: TKey,
	): BuilderChain<
		TEnv,
		TCtx,
		TInput,
		_TErrorKeys | TKey,
		TOutput,
		TPath,
		TMethod,
		TRoutes,
		TUsed | "boundary",
		TBaseCtx,
		TMeta,
		TAccMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		this._s.boundaryErrorKey = key
		this._s.errorKeys.add(key)
		return new RouteBuilder<
			TEnv,
			TCtx,
			TInput,
			_TErrorKeys | TKey,
			TOutput,
			TPath,
			TMethod,
			TRoutes,
			TUsed | "boundary",
			TBaseCtx,
			TMeta,
			TAccMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>({
			...this._s,
			boundaryErrorKey: key,
			errorKeys: this._s.errorKeys,
		})
	}

	handler(
		fn: (
			ctx: HandlerCtx<
				TCtx,
				TInput,
				TOutput,
				ParamsFromPath<TPath>,
				TAccMeta,
				TErrorFactory,
				_TErrorKeys | TDefaultErrors,
				TPath,
				TTaps
			>,
		) => TypedResponse | Promise<TypedResponse>,
	): HandlerReturn<
		TEnv,
		TBaseCtx,
		TRoutes,
		TPath,
		TMethod,
		TInput,
		TOutput,
		TCtx,
		TAccMeta,
		TErrorFactory,
		_TErrorKeys,
		TDefaultErrors,
		TMeta,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		let ov: OutputValidator | null = null
		const outputSchemas = this._s.outputSchemas
		if (outputSchemas) {
			const jsonSchemas = outputSchemas["application/json"]
			if (jsonSchemas) {
				ov = async (statusKey: string, data: unknown) => {
					const schema = jsonSchemas[statusKey as keyof typeof jsonSchemas]
					if (schema) {
						await validateOutput(schema, statusKey, data)
					}
				}
			}
		}

		const isInternal = Symbol.for("honey.internal") in fn
		if (isInternal) {
			Object.defineProperty(fn, Symbol.for("honey.app"), { value: this._s.parent })
		}

		const base: RouteHandler = {
			_skip: isInternal || undefined,
			bek: this._s.boundaryErrorKey,
			ef: null,
			ek: this._s.errorKeys,
			fn: fn as (ctx: unknown) => Response | Promise<Response>,
			iv: this._s.inputSchemas,
			mt: mergeContributedMeta(this._s.mwMeta, this._s.meta),
			mw: [...this._s.parentMiddlewares, ...this._s.middlewares],
			os: this._s.outputSchemas,
			ov,
		}

		/* one record per method — `.on([...])` registers each under its own RouteId */
		const parent = this._s.parent as unknown as HoneyInternal
		const segments = parsePattern(this._s.path)
		const methods = [this._s.method, ...(this._s.extraMethods ?? [])]
		for (let i = 0; i < methods.length; i++) {
			parent._addRoute(methods[i], segments, i === 0 ? base : { ...base, ek: new Set(base.ek) })
		}
		return this._s.parent as HandlerReturn<
			TEnv,
			TBaseCtx,
			TRoutes,
			TPath,
			TMethod,
			TInput,
			TOutput,
			TCtx,
			TAccMeta,
			TErrorFactory,
			_TErrorKeys,
			TDefaultErrors,
			TMeta,
			TBasePath,
			TTaps,
			TScopedMw
		>
	}

	proxy(
		config: ProxyConfig<
			HandlerCtx<
				TCtx,
				TInput,
				TOutput,
				ParamsFromPath<TPath>,
				TAccMeta,
				TErrorFactory,
				_TErrorKeys | TDefaultErrors,
				TPath,
				TTaps
			>
		>,
	): HandlerReturn<
		TEnv,
		TBaseCtx,
		TRoutes,
		TPath,
		TMethod,
		TInput,
		TOutput,
		TCtx,
		TAccMeta,
		TErrorFactory,
		_TErrorKeys,
		TDefaultErrors,
		TMeta,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		const proxyHandler = createProxyHandler(config)
		return this.handler(
			proxyHandler as (
				ctx: HandlerCtx<
					TCtx,
					TInput,
					TOutput,
					ParamsFromPath<TPath>,
					TAccMeta,
					TErrorFactory,
					_TErrorKeys | TDefaultErrors,
					TPath,
					TTaps
				>,
			) => Promise<TypedResponse>,
		)
	}

	input<TSchemas extends InputSchemasDef>(
		schemas: TSchemas,
	): BuilderChain<
		TEnv,
		TCtx,
		TInput & InferInputMap<TSchemas>,
		_TErrorKeys,
		TOutput,
		TPath,
		TMethod,
		TRoutes,
		TUsed | "input",
		TBaseCtx,
		TMeta,
		TAccMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		return new RouteBuilder<
			TEnv,
			TCtx,
			TInput & InferInputMap<TSchemas>,
			_TErrorKeys,
			TOutput,
			TPath,
			TMethod,
			TRoutes,
			TUsed | "input",
			TBaseCtx,
			TMeta,
			TAccMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>({
			...this._s,
			inputSchemas: schemas,
		})
	}

	meta<TRouteMeta extends Partial<DefaultMeta> & ([TMeta] extends [never] ? {} : TMeta)>(
		meta: TRouteMeta,
	): BuilderChain<
		TEnv,
		TCtx,
		TInput,
		_TErrorKeys,
		TOutput,
		TPath,
		TMethod,
		TRoutes,
		TUsed | "meta",
		TBaseCtx,
		TMeta,
		TAccMeta & TRouteMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		return new RouteBuilder<
			TEnv,
			TCtx,
			TInput,
			_TErrorKeys,
			TOutput,
			TPath,
			TMethod,
			TRoutes,
			TUsed | "meta",
			TBaseCtx,
			TMeta,
			TAccMeta & TRouteMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>({
			...this._s,
			meta: (() => {
				const merged: Record<string, unknown> = { ...this._s.meta, ...meta }
				const inv = merged["invalidate"]
				if (Array.isArray(inv) && inv.length > 1) {
					merged["invalidate"] = [...new Set(inv)]
				}
				return merged
			})(),
		})
	}

	output<TOutputSchemas extends OutputSchemaDef>(
		_schemas: TOutputSchemas,
	): BuilderChain<
		TEnv,
		TCtx,
		TInput,
		_TErrorKeys,
		TOutputSchemas,
		TPath,
		TMethod,
		TRoutes,
		TUsed | "output",
		TBaseCtx,
		TMeta,
		TAccMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		return new RouteBuilder<
			TEnv,
			TCtx,
			TInput,
			_TErrorKeys,
			TOutputSchemas,
			TPath,
			TMethod,
			TRoutes,
			TUsed | "output",
			TBaseCtx,
			TMeta,
			TAccMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>({
			...this._s,
			outputSchemas: _schemas,
		})
	}

	use<TAdds>(
		mw: MiddlewareFn<TCtx, TAdds>,
	): BuilderChain<
		TEnv,
		TCtx & TAdds,
		TInput,
		_TErrorKeys,
		TOutput,
		TPath,
		TMethod,
		TRoutes,
		TUsed,
		TBaseCtx,
		TMeta,
		TAccMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		if (mw.errors) {
			for (const k of mw.errors) {
				this._s.errorKeys.add(k)
			}
		}
		return new RouteBuilder<
			TEnv,
			TCtx & TAdds,
			TInput,
			_TErrorKeys,
			TOutput,
			TPath,
			TMethod,
			TRoutes,
			TUsed,
			TBaseCtx,
			TMeta,
			TAccMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>({
			...this._s,
			middlewares: [...this._s.middlewares, mw as RuntimeMiddleware],
			mwMeta: mw.meta ? { ...this._s.mwMeta, ...mw.meta } : this._s.mwMeta,
		})
	}
}

type WSRouteBuilderState<TParent> = {
	mwMeta?: Record<string, unknown> | null
	boundaryErrorKey: string | null
	errorKeys: Set<string>
	inputSchemas: InputSchemasDef | null
	meta: Record<string, unknown> | null
	middlewares: RuntimeMiddleware[]
	parent: TParent
	parentMiddlewares: RuntimeMiddleware[]
	path: string
}

class WSRouteBuilder<TEnv, TCtx, TInput = {}, _TErrorKeys extends string = never, TParent = unknown> {
	private _s: WSRouteBuilderState<TParent>

	constructor(state: WSRouteBuilderState<TParent>) {
		this._s = state
	}

	errors<TFactory extends Record<string, (...args: never[]) => unknown>>(
		factory: TFactory,
		...keys: Array<keyof TFactory & string>
	): WSRouteBuilder<TEnv, TCtx, TInput, _TErrorKeys | (keyof TFactory & string), TParent> {
		void factory
		for (const k of keys) {
			this._s.errorKeys.add(k)
		}
		return new WSRouteBuilder<TEnv, TCtx, TInput, _TErrorKeys | (keyof TFactory & string), TParent>({
			...this._s,
			errorKeys: this._s.errorKeys,
		})
	}

	handler(wsHandler: WSHandler<TCtx>): TParent {
		const routeHandler: WSRouteHandler = {
			bek: this._s.boundaryErrorKey,
			ek: this._s.errorKeys,
			fn: wsHandler as WSHandler<unknown>,
			iv: this._s.inputSchemas,
			mt: mergeContributedMeta(this._s.mwMeta, this._s.meta),
			mw: [...this._s.parentMiddlewares, ...this._s.middlewares],
			rp: this._s.path,
		}
		;(this._s.parent as unknown as HoneyInternal)._addWsRoute(parsePattern(this._s.path), routeHandler)
		return this._s.parent
	}

	input<TSchemas extends Pick<InputSchemasDef, "cookies" | "headers" | "search">>(
		schemas: TSchemas,
	): WSRouteBuilder<TEnv, TCtx, TInput & InferInputMap<TSchemas>, _TErrorKeys, TParent> {
		return new WSRouteBuilder<TEnv, TCtx, TInput & InferInputMap<TSchemas>, _TErrorKeys, TParent>({
			...this._s,
			inputSchemas: schemas,
		})
	}

	meta(meta: Record<string, unknown>): this {
		this._s.meta = meta
		return this
	}

	use<TAdds>(mw: MiddlewareFn<TCtx, TAdds>): WSRouteBuilder<TEnv, TCtx & TAdds, TInput, _TErrorKeys, TParent> {
		if (mw.errors) {
			for (const k of mw.errors) {
				this._s.errorKeys.add(k)
			}
		}
		return new WSRouteBuilder<TEnv, TCtx & TAdds, TInput, _TErrorKeys, TParent>({
			...this._s,
			middlewares: [...this._s.middlewares, mw as RuntimeMiddleware],
			mwMeta: mw.meta ? { ...this._s.mwMeta, ...mw.meta } : this._s.mwMeta,
		})
	}
}

export function honey<TEnv>(): Honey<TEnv> {
	return new Honey<TEnv>()
}
