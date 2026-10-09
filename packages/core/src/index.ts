import { bodyKind, headResponse, isProducedStream, rawBodyOf } from "./body-kind.ts"
import { HoneyContext } from "./context.ts"
import { dict } from "./dict.ts"
import { normalizePath, pathOfUrl, searchOfUrl } from "./request-path.ts"
import { compileTrust, hasValidHost, TRUST_OFF, type TrustProxy, type TrustSetting } from "./trust.ts"
import { HoneyError } from "./error.ts"
import { ERROR_META } from "./errors.ts"
import type { ChainErrorConverter, MiddlewareFn, RuntimeMiddleware } from "./middleware.ts"
import { collectMiddlewareMeta, compileChain, RESERVED_CTX_KEYS } from "./middleware.ts"
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
	pathInScope,
	routeId,
	scopeCoverage,
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
import { resolveRealtimeConfig } from "./realtime/route.ts"
import type { RealtimeConfig, RealtimeRouteOpts } from "./realtime/route.ts"
import { createRealtimePublisher, createRealtimeSession } from "./realtime/server.ts"
import type { RealtimePublisher } from "./realtime/server.ts"
import type {
	ComputeErrorsByStatus,
	DefaultMeta,
	ExtractSchemas,
	FieldError,
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
import { assertBodySchemaAllowed, assertRequestContentType, validateInput, validateOutput } from "./validation.ts"
import type { WSAdapter, WSContext, WSHandler } from "./ws/cloudflare.ts"
import { loadHoneyFeature } from "./feature-load.ts"
import { getI18nRuntime } from "./i18n-slot.ts"
import { getOpenApiRuntime } from "./openapi/spec-factory.ts"
import { getServeRuntime } from "./serve-slot.ts"
import type { HoneyServeOptions, ServeHandle } from "./serve.ts"

export { clientInfo, HoneyContext } from "./context.ts"
export type { ClientInfo, TrustProxy } from "./trust.ts"
/** HoneyContext without internal backing fields — use this for consumer-facing types */
export type HoneyCtx<TEnv = Record<string, unknown>> = Omit<
	import("./context.ts").HoneyContext<TEnv>,
	| "_errorToResponse"
	| "_isErrorResponse"
	| "_lzClient"
	| "_lzCookies"
	| "_lzHeaders"
	| "_lzSearch"
	| "_lzSearchAll"
	| "_lzUrlFn"
	| "_rq"
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
export type { ConnContext, RealtimeLimits, RealtimeRouteOpts } from "./realtime/route.ts"
export type { RealtimePublisher } from "./realtime/server.ts"
export type { RealtimeBus } from "./realtime/bus.ts"
export type { HoneyServeOptions, ServeHandle } from "./serve.ts"
export type { ServeRuntime } from "./detect-runtime.ts"
export { detectRuntime } from "./detect-runtime.ts"

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

type ErrorCtx<TEnv> = { env: TEnv; jsonFromError: (err: HoneyError) => Response; req: Request }

type OnErrorFn<TEnv> = (
	error: unknown,
	ctx: ErrorCtx<TEnv>,
) => HoneyError | Response | Promise<HoneyError | Response | undefined | void> | undefined | void

type OnMethodNotAllowedFn<TEnv> = (ctx: ErrorCtx<TEnv> & { allowed: string[] }) => Response | Promise<Response>

type OnNotFoundFn<TEnv> = (ctx: ErrorCtx<TEnv>) => Response | Promise<Response>

type TapFn<TEnv> = (ctx: TapContext<TEnv>, payload: unknown) => void | Promise<void>

type ErrorFactoryRecord = Record<string, (...args: never[]) => unknown>

type OutputValidationMode = "always" | "dev" | "off"

/**
 * Settings of one app — shared by every handle derived from it (`use()`, `basePath()`,
 * `context()`, `meta()`), so a setter called on any handle applies to all of them and
 * serving any handle behaves the same. Records point at the settings of the app they were
 * registered on, so a mounted sub-app's routes keep their own error factory, default errors,
 * boundary and output validation.
 */
type AppSettings<TEnv = unknown> = {
	customErrorFormatter: CustomErrorFormatter | null
	customErrorSchema: StandardSchemaLike | null
	defaultBoundaryKey: string | null
	defaultErrorKeys: Set<string>
	errorFactory: ErrorFactoryRecord | null
	errorFormatter: ErrorFormatterFn
	errorI18n: ErrorI18nConfig<TEnv> | null
	errorSchema: StandardSchemaLike | null
	logger: Logger | null
	onError: OnErrorFn<TEnv> | null
	onMethodNotAllowed: OnMethodNotAllowedFn<TEnv> | null
	onNotFound: OnNotFoundFn<TEnv> | null
	/** null = never set: a mounted route follows the mounting app's mode */
	outputValidation: OutputValidationMode | null
	stripPrefix: string | null
	taps: Map<string, TapFn<TEnv>> | null
	telemetry: TelemetryAdapter | null
	trailingSlash: "enforce" | "ignore" | "strip"
	encodedSlashes: "allow" | "reject"
	trust: TrustSetting
	wsAdapter: WSAdapter | null
}

function createSettings<TEnv>(): AppSettings<TEnv> {
	return {
		customErrorFormatter: null,
		customErrorSchema: null,
		defaultBoundaryKey: null,
		defaultErrorKeys: new Set(),
		errorFactory: null,
		errorFormatter: defaultErrorFormatter,
		errorI18n: null,
		errorSchema: null,
		logger: null,
		onError: null,
		onMethodNotAllowed: null,
		onNotFound: null,
		outputValidation: null,
		stripPrefix: null,
		taps: null,
		telemetry: null,
		trailingSlash: "ignore",
		encodedSlashes: "reject",
		trust: TRUST_OFF,
		wsAdapter: null,
	}
}

/** Join a base path and a route or scope path into one canonical pattern. */
function mergePath(base: string, path: string): string {
	return joinPatterns(base, path)
}

/**
 * Everything a matched route runs, compiled once at finalize: the record (with its resolved
 * error keys, meta and chain) and one function that runs chain + handler and never rejects.
 */
type Plan = {
	/** `.context()` values copied onto each request context */
	cv: Record<string, unknown> | null
	/** declared error keys are enforced (the route, its middleware or the app declared any) */
	enf: boolean
	/** preflight runner — chain without input validation or handler; compiled on first preflight */
	pf: CompiledChain | null
	/** what the preflight runner runs */
	pfChain: RuntimeMiddleware[]
	r: RouteHandler | WSRouteHandler
	/** realtime route config when this is a realtime route */
	rt: RealtimeConfig | null
	run: CompiledChain
	/** taps of the serving app, plus those of the app the route came from */
	taps: Map<string, TapFn<unknown>> | null
}

type CompiledChain = (ctx: object) => Response | Promise<Response>

/** What one app graph serves, resolved at finalize from records and the loaded tree. */
type FinalTable = {
	byId: Map<RouteId, RouteHandler>
	convert: ChainErrorConverter
	epoch: number
	/** 404 / 405: the middleware every route runs, plus the scopes covering the request path */
	miss: Plan
	plans: Map<RouteId, Plan>
	/** `METHOD /path` → plan, for routes without params or wildcards */
	statics: Record<string, Plan>
	wsById: Map<RouteId, WSRouteHandler>
	wsPlans: Map<RouteId, Plan>
}

/** One `app.use(mw)` — the handle it returns has to register a route, or `mw` runs nowhere. */
type ChainNode = { mw: RuntimeMiddleware; parent: ChainNode | null; used: boolean }

/** A route builder still waiting for `.handler()` — reported at finalize. */
type PendingRoute = { id: string }

/** @internal — runtime entry for a scoped middleware */
type ScopedEntry = {
	/** cached from mw.errors at registration; undefined when none */
	errors: readonly string[] | undefined
	/** the middleware behind a request-path check, for routes the scope covers only partly */
	guard: RuntimeMiddleware
	mw: RuntimeMiddleware
	/** canonical full-path pattern (already rebased against basePath at .use time) */
	prefix: string
	segs: Segment[]
}

/**
 * One app graph — shared by every handle derived with `use()`, `basePath()`, `context()`,
 * `meta()`. Records are per graph, keyed by `RouteId`; the tree holds ids only, so a loaded
 * (shared, frozen) tree never carries another app's handlers.
 */
type HoneyGraph = {
	/** gateway catch-alls by method — root wildcards registered over a loaded tree that lacks them */
	catchAll: Map<string, RouteHandler>
	/** every `use(mw)` handle — one that never registers a route is reported at finalize */
	chains: ChainNode[]
	/** bumped by every registration; finalize re-runs when it moves */
	epoch: number
	final: FinalTable | null
	/** app-wide middleware that runs before every chain (serve({ cors })), keyed so a re-serve replaces it */
	global: Map<string, RuntimeMiddleware>
	hasWs: boolean
	/** route data of the loaded tree (per-graph copies) — null when no tree was loaded */
	loaded: Map<RouteId, RouteEntry> | null
	/** Codegen-time meta → OpenAPI policy. Never read on the request path */
	metaSpec: MetaSpecConfig | null
	/** route builders still waiting for `.handler()` */
	pending: Set<PendingRoute>
	realtimeBus: RealtimeBus | null
	/** `ctx.realtime`, shared by every request of this graph */
	realtimeCtx: RealtimePublisher | null
	realtimeRoutes: Map<string, RealtimeConfig>
	records: Map<RouteId, RouteHandler>
	root: TreeNode
	/** root is a loaded tree (frozen, possibly shared by other apps) — copy before inserting */
	rootShared: boolean
	/** path-scoped middleware, in registration order */
	scoped: ScopedEntry[]
	/** chains of the handles that served a request — decide what 404 and 405 run when there are no routes */
	served: Set<RuntimeMiddleware[]>
	settings: AppSettings<unknown>
	/** registered after routeTree() with no leaf in the loaded tree — stale generated file */
	unexpected: Set<RouteId>
	wsRecords: Map<RouteId, WSRouteHandler>
}

function createGraph(): HoneyGraph {
	return {
		catchAll: new Map(),
		chains: [],
		epoch: 0,
		final: null,
		global: new Map(),
		hasWs: false,
		loaded: null,
		metaSpec: null,
		pending: new Set(),
		realtimeBus: null,
		realtimeCtx: null,
		realtimeRoutes: new Map(),
		records: new Map(),
		root: createNode(),
		rootShared: false,
		scoped: [],
		served: new Set(),
		settings: createSettings(),
		unexpected: new Set(),
		wsRecords: new Map(),
	}
}

/** Fresh copy of a record for another graph — sources are copied, resolved fields recomputed there. */
function copyRecord<T extends RouteHandler | WSRouteHandler>(r: T): T {
	const out = { ...r, ek: new Set(r.ek) } as T
	if (r.dk !== undefined) out.dk = new Set(r.dk)
	if (r.cm !== undefined) out.cm = [...r.cm]
	if (r.rm !== undefined) out.rm = [...r.rm]
	delete (out as RouteHandler).ca
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

function requestIsWsUpgrade(request: Request): boolean {
	try {
		return request.headers.get("upgrade")?.toLowerCase() === "websocket"
	} catch {
		/* Deno closes the Request after upgradeWebSocket */
		return false
	}
}

/** The info object `Deno.serve` passes as the second handler argument. */
function isDenoServeInfo(env: unknown): boolean {
	return env !== null && typeof env === "object" && (env as { remoteAddr?: unknown }).remoteAddr !== undefined
}

/** `obj[key]` for an own key only; `undefined` for inherited names such as `constructor`. */
function ownValue<T>(obj: Record<string, T> | undefined, key: string): T | undefined {
	return obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined
}

/** A copy of `error` with a translated message and field paths; same key, status, data and cause. */
function translatedError(
	error: HoneyError,
	message: string | undefined,
	fields: Record<string, FieldError[]> | undefined,
): HoneyError {
	const copy = new HoneyError({
		cause: error.cause,
		data: error.data,
		errorKey: error.errorKey,
		fields: fields ?? error.fields,
		headers: error.headers,
		status: error.statusKey,
		vars: error.vars,
	})
	copy.message = message ?? error.message
	if (error.stack !== undefined) copy.stack = error.stack
	return copy
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

/** Per-request state, shared by the dispatcher, the error boundary and terminal handlers. */
type FetchCtx<TEnv> = {
	/** methods a 405 lists; also marks the miss pipeline as a 405 */
	allowed: string[] | null
	env: TEnv
	executionCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined
	log: Logger | undefined
	method: string
	path: string
	plan: Plan | null
	request: Request
	startTime: number
	/** the app's trustProxy() setting, read by ctx.ip and clientInfo() */
	trust: TrustSetting
	url: () => URL
	/** matched websocket route, for the upgrade terminal */
	ws: { handler: WSRouteHandler; params: Record<string, string> } | null
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

/* errorKeys the framework throws on its own behalf — input/output validation, content negotiation,
 * routing, and the shipped middleware. Always passes the boundary check; users never declare these via .errors(). */
const FRAMEWORK_EKS = new Set<string>([
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
	EK.forbidden,
	EK.bad_request,
	EK.malformed_body,
])

function shouldValidateOutput(mode: OutputValidationMode): boolean {
	if (mode === "always") return true
	if (mode === "off") return false
	return (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process?.env?.NODE_ENV !== "production"
}

/** The scoped middleware behind a request-path check: runs only when the path is inside the scope. */
function scopeGuard(segs: readonly Segment[], mw: RuntimeMiddleware): RuntimeMiddleware {
	const guard: RuntimeMiddleware = (ctx, next) => (pathInScope(ctx["path"] as string, segs) ? mw(ctx, next) : next())
	Object.defineProperty(guard, "name", { configurable: true, value: mw.name })
	const tagged = mw as { errors?: readonly string[]; meta?: Readonly<Record<string, unknown>> }
	if (tagged.errors) Object.defineProperty(guard, "errors", { value: tagged.errors })
	if (tagged.meta) Object.defineProperty(guard, "meta", { value: tagged.meta })
	return guard
}

/** Wrap a middleware so telemetry sees its own duration and its own throw. Built once at finalize. */
function timedMiddleware(
	mw: RuntimeMiddleware,
	onMw: NonNullable<TelemetryAdapter["onMiddleware"]>,
	log: Logger | undefined,
): RuntimeMiddleware {
	const name = mw.name || "anonymous"
	return async (ctx, next) => {
		const start = performance.now()
		try {
			const res = await mw(ctx, next)
			safeFire(() => onMw({ duration: performance.now() - start, name }), log)
			return res
		} catch (error) {
			safeFire(() => onMw({ duration: performance.now() - start, error, name }), log)
			throw error
		}
	}
}

function errorsOf(mw: RuntimeMiddleware): readonly string[] | undefined {
	return (mw as { errors?: readonly string[] }).errors
}

/** Longest run of middleware every record starts its chain with — what 404 and 405 run. */
function commonPrefix(chains: ReadonlyArray<readonly RuntimeMiddleware[]>): RuntimeMiddleware[] {
	if (chains.length === 0) return []
	let out = [...(chains[0] as readonly RuntimeMiddleware[])]
	for (let i = 1; i < chains.length && out.length > 0; i++) {
		const c = chains[i] as readonly RuntimeMiddleware[]
		let n = 0
		while (n < out.length && n < c.length && out[n] === c[n]) n++
		out = out.slice(0, n)
	}
	return out
}

function describeMw(mw: RuntimeMiddleware): string {
	return mw.name ? `"${mw.name}"` : "an anonymous middleware"
}

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
	/* view state — what routes registered through this handle capture */
	private _basePath: string
	private _chain: RuntimeMiddleware[]
	private _chainMeta: Record<string, unknown> | null
	private _contextValues: Record<string, unknown> | null
	private _graph: HoneyGraph
	/** the `use(mw)` call that created this chain — null on the root handle */
	private _node: ChainNode | null
	private _openApiCache: { epoch: number; value: Promise<unknown> } | null
	private _openApiYamlCache: { epoch: number; value: Promise<string> } | null
	private _manifestCache: { epoch: number; value: Promise<unknown> } | null

	constructor(opts?: { graph?: HoneyGraph }) {
		this._basePath = "/"
		this._chain = []
		this._chainMeta = null
		this._contextValues = null
		this._graph = opts?.graph ?? createGraph()
		this._node = null
		this._openApiCache = null
		this._openApiYamlCache = null
		this._manifestCache = null
	}

	private get _s(): AppSettings<TEnv> {
		return this._graph.settings as AppSettings<TEnv>
	}

	/** @internal — read by codegen */
	private get _metaSpec(): MetaSpecConfig | null {
		return this._graph.metaSpec
	}
	private set _metaSpec(value: MetaSpecConfig | null) {
		this._graph.metaSpec = value
	}

	/** @internal — read by codegen and OpenAPI */
	get _errorFactory(): ErrorFactoryRecord | null {
		return this._graph.settings.errorFactory
	}
	set _errorFactory(factory: ErrorFactoryRecord | null) {
		this._graph.settings.errorFactory = factory
		this._bumpEpoch()
	}

	/** @internal — read by OpenAPI */
	get _errorSchema(): StandardSchemaLike | null {
		return this._graph.settings.errorSchema
	}

	/** @internal — read by OpenAPI */
	get _customErrorSchema(): StandardSchemaLike | null {
		return this._graph.settings.customErrorSchema
	}

	private get _root(): TreeNode {
		return this._graph.root
	}

	private get _realtimeBus(): RealtimeBus | null {
		return this._graph.realtimeBus
	}

	/** A new handle on the same graph, carrying this handle's view. */
	private _derive(chain: RuntimeMiddleware[] = this._chain): Honey<TEnv> {
		const next = new Honey<TEnv>({ graph: this._graph })
		next._basePath = this._basePath
		next._chain = chain
		next._chainMeta = this._chainMeta
		next._contextValues = this._contextValues
		next._node = this._node
		return next
	}

	/** This handle registers, mounts or serves — every `use()` on its way here is in use. */
	private _markUsed(): void {
		let node = this._node
		while (node !== null && !node.used) {
			node.used = true
			node = node.parent
		}
	}

	/** @internal — used by RouteBuilder for pre-filtered error factory */
	get _factory(): unknown {
		return this._graph.settings.errorFactory
	}

	/** @internal — used by runtime error boundary */
	get _boundaryKey(): string | null {
		return this._graph.settings.defaultBoundaryKey
	}

	/** Convert an unknown thrown value to a plain error Response — no boundary, no onError. */
	private _toErrorResponse(thrown: unknown): Response {
		const error =
			thrown instanceof HoneyError
				? thrown
				: new HoneyError({
						cause: thrown,
						errorKey: EK.internal_server_error,
						status: SK.internal_server_error,
					})
		const s = this._s
		return createErrorResponse(error, s.errorFormatter, s.customErrorFormatter)
	}

	private _createBoundaryError(errorKey: string, cause: unknown, fac: ErrorFactoryRecord | null): HoneyError {
		const factory = fac as Record<string, ((opts?: { cause?: unknown }) => HoneyError) | undefined> | null
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
		const factory = this._s.errorFactory as Record<string, (() => HoneyError) | undefined> | null
		const factoryFn = factory?.[errorKey]
		if (factoryFn) {
			return factoryFn()
		}
		return new HoneyError({ errorKey, status: statusKey })
	}

	/**
	 * The i18n-resolved copy of `honeyError`: message from the locale's template for its
	 * errorKey, field paths from the locale's field names. Returns `honeyError` itself when
	 * i18n is not configured or nothing matches. Never mutates it: an error instance can be
	 * thrown again, on another request, in another locale.
	 */
	private async _resolveI18n(
		honeyError: HoneyError,
		ctx: HoneyContext<TEnv>,
		env: TEnv,
		request: Request,
		log?: Logger,
	): Promise<HoneyError> {
		const i18n = this._s.errorI18n
		if (!i18n) return honeyError
		try {
			const locale = await i18n.resolveLocale({
				cookies: ctx.cookies,
				env,
				headers: ctx.headers,
				params: ctx.params,
				req: request,
				search: ctx.search,
			})
			/* the locale can come from request data: own keys only */
			const translations = ownValue(i18n.errors, locale)
			const template = translations ? ownValue(translations, honeyError.errorKey) : undefined
			let message: string | undefined
			if (template) {
				await loadHoneyFeature("i18n")
				message = getI18nRuntime().interpolate(template, honeyError.vars ?? {}, locale)
			}

			const fieldTranslations = ownValue(i18n.fieldNames, locale)
			let fields: Record<string, FieldError[]> | undefined
			if (fieldTranslations && Object.keys(honeyError.fields).length > 0) {
				fields = dict<FieldError[]>()
				for (const name of Object.keys(honeyError.fields)) {
					fields[name] = honeyError.fields[name].map((fe) => {
						let candidate = fe.path
						while (candidate) {
							const translated = ownValue(fieldTranslations, candidate)
							if (translated) return { ...fe, path: translated }
							const dotIdx = candidate.indexOf(".")
							if (dotIdx === -1) break
							candidate = candidate.slice(dotIdx + 1)
						}
						return fe
					})
				}
			}
			if (message === undefined && fields === undefined) return honeyError
			return translatedError(honeyError, message, fields)
		} catch (e) {
			log?.warn?.({ err: e }, "i18n resolution failed")
			return honeyError
		}
	}

	/**
	 * The error boundary of every `next()`: turns what a handler or middleware threw into the
	 * Response that replaces it, so every middleware around it sees a Response. Never rejects.
	 */
	private _convertError(thrown: unknown, ctx: HoneyContext<TEnv>): Response | Promise<Response> {
		const fc = ctx._rq as FetchCtx<TEnv> | null
		const plan = fc?.plan
		if (fc === null || fc === undefined || plan === null || plan === undefined) {
			return this._safeErrorResponse(thrown)
		}
		try {
			return this._resolveErrorResponse(thrown, plan, fc, ctx).catch((e: unknown) => {
				fc.log?.warn?.({ err: e }, "error response failed")
				return this._safeErrorResponse(thrown)
			})
		} catch (e) {
			fc.log?.warn?.({ err: e }, "error response failed")
			return this._safeErrorResponse(thrown)
		}
	}

	/** Last resort when even the configured formatter throws. */
	private _safeErrorResponse(thrown: unknown): Response {
		try {
			return this._toErrorResponse(thrown instanceof HoneyError ? thrown : undefined)
		} catch {
			return new Response(JSON.stringify({ error: { errorKey: EK.internal_server_error } }), {
				headers: { "content-type": "application/json" },
				status: 500,
			})
		}
	}

	/**
	 * Convert thrown value into an error Response — resolves boundary wrapping, i18n
	 * translation, the onError callback, and error telemetry. `onResponse` telemetry is not
	 * fired here: the request fires it exactly once, on the way out.
	 */
	private async _resolveErrorResponse(
		thrown: unknown,
		plan: Plan,
		fc: FetchCtx<TEnv>,
		ctx: HoneyContext<TEnv>,
	): Promise<Response> {
		const { env, log, request, startTime, method, path } = fc
		const s = this._s
		const record = plan.r
		const fac = (record.fac ?? null) as ErrorFactoryRecord | null
		let honeyError: HoneyError
		const boundaryKey = record.bek

		if (thrown instanceof HoneyError) {
			/* framework-managed errorKeys (input/output validation, content negotiation, etc.) are always allowed
			 * regardless of the declared keys — users never declare them, the framework owns them. */
			if (plan.enf && !FRAMEWORK_EKS.has(thrown.errorKey) && !record.ek.has(thrown.errorKey)) {
				honeyError = boundaryKey
					? this._createBoundaryError(boundaryKey, thrown, fac)
					: new HoneyError({ cause: thrown, errorKey: EK.internal_server_error, status: SK.internal_server_error })
			} else {
				honeyError = thrown
			}
		} else {
			honeyError = boundaryKey
				? this._createBoundaryError(boundaryKey, thrown, fac)
				: new HoneyError({ cause: thrown, errorKey: EK.internal_server_error, status: SK.internal_server_error })
		}

		honeyError = await this._resolveI18n(honeyError, ctx, env, request, log)

		if (s.onError) {
			try {
				const customResult = await s.onError(thrown, this._makeErrorCtx(fc))
				if (customResult instanceof HoneyError) {
					/* user-mapped boundary error — re-run i18n against new errorKey,
					 * then fall through to the default response path */
					honeyError = await this._resolveI18n(customResult, ctx, env, request, log)
				} else if (customResult) {
					safeFire(
						() => s.telemetry?.onError?.({ duration: performance.now() - startTime, error: honeyError, method, path }),
						log,
					)
					ctx._isErrorResponse = true
					return customResult
				}
				/* customResult === undefined | void → fall through to default path */
			} catch (e) {
				log?.warn?.({ err: e }, "onError failed")
			}
		}

		safeFire(
			() => s.telemetry?.onError?.({ duration: performance.now() - startTime, error: honeyError, method, path }),
			log,
		)
		ctx._isErrorResponse = true
		return this._makeErrorCtx(fc).jsonFromError(honeyError)
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
			if (RESERVED_CTX_KEYS.has(key)) {
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
		this._s.logger = logger
		return this
	}

	outputValidation(mode: OutputValidationMode): this {
		this._s.outputValidation = mode
		this._bumpEpoch()
		return this
	}

	trailingSlash(mode: "enforce" | "ignore" | "strip"): this {
		this._s.trailingSlash = mode
		return this
	}

	/**
	 * Request paths containing an encoded `/` or `\` (`%2F`, `%5C`) answer 400 by default.
	 * `"allow"` keeps them encoded in the path, so they decode into a param value
	 * (`/repos/:id` with `/repos/group%2Fproject` gives `id === "group/project"`). Only allow
	 * them when nothing downstream (a `proxy()` upstream, a file resolver) treats a decoded
	 * slash as a separator.
	 */
	encodedSlashes(mode: "allow" | "reject"): this {
		this._s.encodedSlashes = mode
		return this
	}

	/**
	 * Which reverse proxies in front of the app to believe. Decides `ctx.ip`, `clientInfo()`,
	 * `ipRestrict`, and every other feature that needs the client's address, scheme or host.
	 *
	 * - `false` (default): the peer address the runtime reports is the client; `X-Forwarded-*`
	 *   headers are ignored, since any client can send them.
	 * - a hop count: exactly that many proxies, each appending its peer to `X-Forwarded-For`
	 *   (nginx `$proxy_add_x_forwarded_for`, most load balancers). The client is the entry the
	 *   outermost proxy wrote.
	 * - addresses and CIDR ranges of your proxies: hops from those addresses are skipped; the
	 *   first other address is the client.
	 */
	trustProxy(value: TrustProxy): this {
		this._s.trust = compileTrust(value)
		return this
	}

	/** Strip a URL path prefix before route matching — boundary-safe (won't strip partial segments), paths without the prefix pass through unchanged */
	stripPrefix(prefix: string): this {
		let normalized = prefix.replace(/\/+$/, "")
		if (normalized.length > 0 && normalized.charCodeAt(0) !== 47) {
			normalized = `/${normalized}`
		}
		this._s.stripPrefix = normalized === "" || normalized === "/" ? null : normalized
		return this
	}

	wsAdapter(adapter: WSAdapter): this {
		this._s.wsAdapter = adapter
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
			bek: null,
			cm: [...this._chain],
			cv: this._contextValues,
			dk: new Set(),
			ek: new Set(),
			fn: (ctx) => fn(ctx as { res: HoneyRes }),
			iv: null,
			mt: null,
			mw: [],
			os: null,
			ov: null,
			own: g.settings,
			rb: null,
			rm: [],
			xm: null,
		}
		this._markUsed()
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
	 * snapshot, and delegated leaves the gateway catch-all serves. Then resolve every record —
	 * its full chain (`chain → scoped → route → input validation`), error keys, meta and error
	 * factory — and compile it once. Re-runs whenever the graph's epoch moved. Throws, naming
	 * every route, when a loaded tree and the registered routes disagree (the generated file is
	 * stale), and when a `use(mw)` handle or a route builder was left unused (the middleware or
	 * route would silently be missing).
	 */
	_finalize(): FinalTable {
		const g = this._graph
		if (g.final !== null && g.final.epoch === g.epoch) return g.final
		this._assertNothingDiscarded()
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
						const live = copyRecord(entry.h as WSRouteHandler)
						live.id = id
						live.rp = pattern
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
					byId.set(id, live)
					continue
				}
				const ca = g.catchAll.get(method) ?? g.catchAll.get("ALL")
				if (ca !== undefined) {
					const dl = copyRecord(ca)
					dl.dl = true
					dl.id = id
					dl.rp = pattern
					dl.xm = entry.mt ? { ...entry.mt } : null
					dl.iv = entry.iv ?? null
					dl.os = entry.os ?? null
					dl.dk = new Set([...(ca.dk ?? []), ...(entry.ek ?? [])])
					if (entry.bek !== undefined && entry.bek !== null) dl.rb = entry.bek
					byId.set(id, dl)
					delegated++
					continue
				}
				/* no handler anywhere: documented (served specs list it) but answered with 404 */
				byId.set(id, {
					bek: null,
					cm: [],
					dk: new Set(entry.ek ?? []),
					dl: true,
					ek: new Set(),
					fn: NOT_SERVED,
					id,
					iv: entry.iv ?? null,
					mt: null,
					mw: [],
					os: entry.os ?? null,
					rb: entry.bek ?? null,
					rm: [],
					rp: pattern,
					xm: entry.mt ? { ...entry.mt } : null,
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

		const convert: ChainErrorConverter = (thrown, ctx) => this._convertError(thrown, ctx as HoneyContext<TEnv>)
		const plans = new Map<RouteId, Plan>()
		const wsPlans = new Map<RouteId, Plan>()
		const statics = Object.create(null) as Record<string, Plan>
		const userChains: RuntimeMiddleware[][] = []
		for (const [id, r] of byId) {
			const plan = this._planRoute(r, convert)
			plans.set(id, plan)
			if (r._skip !== true && r.dl !== true) userChains.push(r.cm ?? [])
			const { method, segments } = patternOf(id)
			for (const v of leafVariants(segments)) {
				if (isStaticPattern(v)) statics[`${method} ${canonical(v)}`] = plan
			}
		}
		for (const [id, r] of wsById) {
			wsPlans.set(id, this._planWs(r, convert))
			userChains.push(r.cm ?? [])
		}
		/* an app with no routes (static files only) has nothing but the handles that serve it */
		if (userChains.length === 0) for (const chain of g.served) userChains.push(chain)
		const miss = this._planMiss(commonPrefix(userChains), convert)
		g.final = { byId, convert, epoch: g.epoch, miss, plans, statics, wsById, wsPlans }
		return g.final
	}

	/** `use(mw)` handles that never registered, mounted or served, and builders without `.handler()`. */
	private _assertNothingDiscarded(): void {
		const g = this._graph
		const problems: string[] = []
		for (const node of g.chains) {
			if (node.used) continue
			problems.push(
				`app.use(${describeMw(node.mw)}) returned a handle that never registers a route, so the middleware runs nowhere. ` +
					"use() does not change the handle it is called on: keep the returned value and register routes on it " +
					"(`const authed = app.use(auth); authed.get(...)`), or chain it (`honey().use(mw).get(...)`).",
			)
		}
		for (const p of g.pending) {
			problems.push(`${p.id} was declared but never got a .handler() (or .proxy()), so the route is not registered.`)
		}
		if (problems.length > 0) throw new Error(`honey: ${problems.join("\n  ")}`)
	}

	/**
	 * Resolve a record against this graph: chain = captured chain, the scopes that cover its
	 * pattern (behind a request-path check where only some of its paths are inside), then its
	 * route middleware. Error keys and contributed meta come from that chain, in run order.
	 * The error factory, default errors and boundary come from the app the route was
	 * registered on when that app has a factory, else from this one.
	 */
	private _resolve(
		r: RouteHandler | WSRouteHandler,
		everyScope = false,
	): { enf: boolean; own: AppSettings<unknown>; taps: Map<string, TapFn<unknown>> | null } {
		const s = this._graph.settings
		const own = (r.own as AppSettings<unknown> | undefined) ?? s
		const src = own.errorFactory !== null ? own : s
		const segments = parsePattern(r.rp ?? "/")
		const scoped: RuntimeMiddleware[] = []
		for (const entry of this._graph.scoped) {
			if (everyScope) {
				scoped.push(entry.guard)
				continue
			}
			const cov = scopeCoverage(segments, entry.segs)
			if (cov === "all") scoped.push(entry.mw)
			else if (cov === "some") scoped.push(entry.guard)
		}
		const mw = [...this._graph.global.values(), ...(r.cm ?? []), ...scoped, ...(r.rm ?? [])]
		/* app defaults, then what the middleware declares in run order, then the route's own */
		const ek = new Set<string>(src.defaultErrorKeys)
		for (const m of mw) {
			const errs = errorsOf(m)
			if (errs) for (const k of errs) ek.add(k)
		}
		if (r.dk !== undefined) for (const k of r.dk) ek.add(k)
		const bek = r.rb ?? src.defaultBoundaryKey
		if (bek !== null) ek.add(bek)
		const enf = ek.size > 0
		const fac = src.errorFactory
		let ef: ErrorFactoryRecord | null = fac
		if (fac !== null && enf) {
			const subset = Object.create(null) as ErrorFactoryRecord
			for (const key of ek) {
				if (key in fac) subset[key] = fac[key] as ErrorFactoryRecord[string]
			}
			ef = Object.freeze(subset)
		}
		r.mw = mw
		r.ek = ek
		r.bek = bek
		r.fac = fac
		r.ef = ef
		r.mt = mergeContributedMeta(collectMiddlewareMeta([mw]), r.xm ? { ...r.xm } : null)
		/* the serving app's taps win; a route from another app keeps that app's for the rest */
		const taps =
			own === s || own.taps === null ? s.taps : s.taps === null ? own.taps : new Map([...own.taps, ...s.taps])
		return { enf, own, taps }
	}

	/** Wrap each middleware for `telemetry.onMiddleware`, once per finalize. */
	private _timed(chain: RuntimeMiddleware[]): RuntimeMiddleware[] {
		const onMw = this._graph.settings.telemetry?.onMiddleware
		if (onMw === undefined) return chain
		const log = this._graph.settings.logger ?? undefined
		return chain.map((m) => timedMiddleware(m, onMw, log))
	}

	private _planRoute(r: RouteHandler, convert: ChainErrorConverter): Plan {
		const { enf, own, taps } = this._resolve(r)
		const s = this._graph.settings
		const ovm = own.outputValidation ?? s.outputValidation ?? "off"
		const base = this._timed(r.mw)
		const chain = [...base]
		/* a delegated route's schemas document it; the body is forwarded, never validated here */
		const iv = r.iv
		if (iv && r.dl !== true) {
			chain.push((ctx, next) =>
				validateInput(
					iv,
					ctx["req"] as Request,
					ctx["params"] as Record<string, string>,
					ctx as { searchAll?: Record<string, string[]> },
				).then((validated) => {
					ctx["input"] = validated
					return next()
				}),
			)
		}
		const fn = r.fn
		const handler: CompiledChain =
			r.os && ovm !== "off"
				? (ctx) => {
						const res = fn(ctx)
						if (!shouldValidateOutput(ovm)) return res
						return res instanceof Promise
							? res.then((v) => this._validateOutput(r, ctx as HoneyContext<TEnv>, v))
							: this._validateOutput(r, ctx as HoneyContext<TEnv>, res)
					}
				: (fn as CompiledChain)
		return {
			cv: r.cv ?? null,
			enf,
			pf: null,
			pfChain: base,
			r,
			rt: null,
			run: compileChain(chain, handler, convert),
			taps,
		}
	}

	private _planWs(r: WSRouteHandler, convert: ChainErrorConverter): Plan {
		const { enf } = this._resolve(r)
		const rt = this._graph.realtimeRoutes.get(r.rp) ?? null
		const chain = this._timed(r.mw)
		const iv = r.iv
		if (iv) {
			chain.push((ctx, next) =>
				validateInput(
					iv,
					ctx["req"] as Request,
					ctx["params"] as Record<string, string>,
					ctx as { searchAll?: Record<string, string[]> },
				).then((validated) => {
					ctx["input"] = validated
					return next()
				}),
			)
		}
		const terminal: CompiledChain =
			rt !== null
				? (ctx) => this._realtimeUpgrade(ctx as HoneyContext<TEnv>, rt)
				: (ctx) => this._wsUpgrade(ctx as HoneyContext<TEnv>)
		return {
			cv: r.cv ?? null,
			enf,
			pf: null,
			pfChain: [],
			r,
			rt,
			run: compileChain(chain, terminal, convert),
			taps: null,
		}
	}

	/**
	 * 404 and 405 run through the same pipeline as a route: the middleware every route of this
	 * graph starts with (with no routes: every handle that served a request), then every scope
	 * (behind its request-path check), then the 404/405 answer. So a logger or CORS policy on the whole app also covers unknown paths, and a
	 * scope's guard answers before "not found" leaks what exists under it.
	 */
	private _planMiss(prefix: RuntimeMiddleware[], convert: ChainErrorConverter): Plan {
		const r: RouteHandler = {
			bek: null,
			cm: prefix,
			dk: new Set(),
			ek: new Set(),
			fn: (ctx) => {
				const fc = (ctx as HoneyContext<TEnv>)._rq as FetchCtx<TEnv>
				return fc.allowed !== null ? this._make405(fc, fc.allowed) : this._make404(fc)
			},
			mt: null,
			mw: [],
			rm: [],
			rp: "",
			xm: null,
		}
		/* every scope, each behind its path check — the request path decides */
		const { enf } = this._resolve(r, true)
		return {
			cv: null,
			enf,
			pf: null,
			pfChain: [],
			r,
			rt: null,
			run: compileChain(this._timed(r.mw), r.fn as CompiledChain, convert),
			taps: null,
		}
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
		const s = this._s
		if (typeof schemaOrFn === "function") {
			s.errorSchema = null
			s.errorFormatter = schemaOrFn
		} else {
			s.errorSchema = schemaOrFn
			const mapper = maybeFn as (error: HoneyError) => Record<string, unknown>
			s.errorFormatter = (error) => mapper(error)
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
		const s = this._s
		if (typeof schemaOrFn === "function") {
			s.customErrorSchema = null
			s.customErrorFormatter = schemaOrFn
		} else {
			s.customErrorSchema = schemaOrFn
			const mapper = maybeFn as (error: HoneyError, data: Record<string, unknown>) => Record<string, unknown>
			s.customErrorFormatter = (error, data) => mapper(error, data)
		}
		return this
	}

	errorI18n(config: ErrorI18nConfig<TEnv>): this {
		this._s.errorI18n = config
		return this
	}

	onError(handler: OnErrorFn<TEnv>): this {
		this._s.onError = handler
		return this
	}

	onMethodNotAllowed(handler: OnMethodNotAllowedFn<TEnv>): this {
		this._s.onMethodNotAllowed = handler
		return this
	}

	onNotFound(handler: OnNotFoundFn<TEnv>): this {
		this._s.onNotFound = handler
		return this
	}

	/** Register a tap handler keyed by name — fires after successful handler response */
	tap<K extends string>(
		key: K,
		handler: (ctx: TapContext<TEnv>, payload: K extends keyof TTaps ? TTaps[K] : unknown) => void | Promise<void>,
	): this {
		const s = this._s
		if (s.taps === null) s.taps = new Map()
		s.taps.set(key, handler as TapFn<TEnv>)
		this._bumpEpoch()
		return this
	}

	telemetry(adapter: TelemetryAdapter): this {
		this._s.telemetry = adapter
		/* onMiddleware wraps the compiled chains */
		this._bumpEpoch()
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
	 * Each record keeps this app's settings (error factory, defaults, boundary) and context
	 * values, and carries the scoped middleware that covers it here as part of its chain —
	 * scopes themselves do not travel in a tree.
	 */
	toRouteTree(): RouteTree {
		this._markUsed()
		const final = this._finalize()
		const routes = Object.create(null) as Record<RouteId, RouteEntry>
		const keep = new Set<RouteId>()
		for (const [id, r] of final.byId) {
			if (r._skip) continue
			keep.add(id)
			routes[id] = {
				bek: r.bek,
				ek: [...r.ek],
				h: this._bake(r),
				iv: r.iv ?? null,
				mt: r.mt,
				os: r.os ?? null,
			}
		}
		for (const [id, r] of final.wsById) {
			keep.add(id)
			routes[id] = { bek: r.bek, ek: [...r.ek], h: this._bake(r), iv: r.iv, mt: r.mt }
		}
		const root = createNode()
		forEachLeaf(this._root, (method, path, id) => {
			if (keep.has(id)) insertLeaf(root, parsePattern(path), method, id)
		})
		return { meta: {}, root, routes, v: ROUTE_TREE_VERSION }
	}

	/** A resolved record as a standalone source: its resolved chain minus route middleware becomes its chain. */
	private _bake<T extends RouteHandler | WSRouteHandler>(r: T): T {
		const h = copyRecord(r)
		const rm = r.rm ?? []
		/* app-wide middleware stays with the app; scopes travel as part of the chain */
		h.cm = r.mw.slice(this._graph.global.size, r.mw.length - rm.length)
		h.rm = [...rm]
		h.dk = new Set(r.ek)
		h.rb = r.bek
		h.xm = r.mt ? { ...r.mt } : null
		h.own = r.own ?? this._graph.settings
		return h
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

	/**
	 * Set the app's error factory. Like every app setting it applies to every handle of this
	 * app, whenever it is called; routes mounted from another app keep that app's factory.
	 */
	errorFactory<TFactory extends Record<string, (...args: never[]) => unknown>>(
		factory: TFactory,
	): Honey<TEnv, TCtx, TRoutes, TMeta, TFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw> {
		this._s.errorFactory = factory
		this._bumpEpoch()
		return this as unknown as Honey<TEnv, TCtx, TRoutes, TMeta, TFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
	}

	/** Error keys every route of this app declares — applies to routes registered before and after the call. */
	defaultErrors<TKeys extends ([TErrorFactory] extends [never] ? never : keyof TErrorFactory & string)>(
		...keys: TKeys[]
	): Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors | TKeys, TBasePath, TTaps, TScopedMw> {
		for (const k of keys) this._s.defaultErrorKeys.add(k)
		this._bumpEpoch()
		return this as unknown as Honey<
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
	}

	defaultBoundary<TKey extends ([TErrorFactory] extends [never] ? never : keyof TErrorFactory & string)>(
		key: TKey,
	): Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors | TKey, TBasePath, TTaps, TScopedMw> {
		this._s.defaultBoundaryKey = key
		this._s.defaultErrorKeys.add(key)
		this._bumpEpoch()
		return this as unknown as Honey<
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
			/*
			 * Chain middleware: a new handle whose routes run `mw`. This handle is unchanged —
			 * a handle that never registers a route is reported at finalize.
			 */
			const mw = pathOrMw as RuntimeMiddleware
			const node: ChainNode = { mw, parent: this._node, used: false }
			this._graph.chains.push(node)
			const next = this._derive([...this._chain, mw])
			next._node = node
			return next
		}

		/* scoped: guards every request path under the prefix, whichever handle registered the route */
		const prefix = mergePath(this._basePath, normalizePattern(pathOrMw))
		const mw = maybeMw as RuntimeMiddleware
		const segs = parsePattern(prefix)
		this._graph.scoped.push({
			errors: errorsOf(mw) ? [...(errorsOf(mw) as readonly string[])] : undefined,
			guard: scopeGuard(segs, mw),
			mw,
			prefix,
			segs,
		})
		this._bumpEpoch()
		return this._derive()
	}

	route<TSubRoutes, TSubMeta, TSubErrorFactory, TSubDefaultErrors extends string, TSubBasePath extends string>(
		sub: Honey<TEnv, TCtx, TSubRoutes, TSubMeta, TSubErrorFactory, TSubDefaultErrors, TSubBasePath>,
	): Honey<TEnv, TCtx, TRoutes & TSubRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw> {
		this._markUsed()
		/* skip self-merge: .handler() already registered into the shared graph */
		if (sub._graph !== this._graph) {
			/*
			 * Re-register the sub's records under this handle: this handle's chain runs first,
			 * its context values and chain meta apply under the sub's own. Nothing is shared by
			 * reference, so routes the sub registers later stay its own, and two parents
			 * mounting one sub each get their own records. Each record keeps the settings of
			 * the sub (error factory, defaults, boundary, output validation). Internal routes
			 * (spec, docs, manifest) never travel.
			 */
			sub._markUsed()
			const subFinal = sub._finalize()
			const subSettings = sub._graph.settings
			const mount = <T extends RouteHandler | WSRouteHandler>(r: T): T => {
				const c = copyRecord(r)
				c.cm = [...this._chain, ...(r.cm ?? [])]
				if (this._contextValues) c.cv = { ...this._contextValues, ...r.cv }
				if (this._chainMeta) c.xm = { ...this._chainMeta, ...r.xm }
				c.own = r.own ?? subSettings
				return c
			}
			for (const [id, r] of subFinal.byId) {
				if (r._skip) continue
				const { method, segments } = patternOf(id)
				this._addRoute(method, segments, mount(r))
			}
			for (const [id, r] of subFinal.wsById) {
				const { segments } = patternOf(id)
				this._addWsRoute(segments, mount(r))
			}
			this._absorbMetaSpec(sub._metaSpec)
			/* the sub's scopes guard the paths it brought — appended after this app's own */
			const g = this._graph
			for (const entry of sub._graph.scoped) {
				if (!g.scoped.includes(entry)) g.scoped.push(entry)
			}
			for (const [path, cfg] of sub._graph.realtimeRoutes) {
				if (g.realtimeRoutes.has(path)) {
					throw new Error(`Duplicate realtime route: ${path}`)
				}
				g.realtimeRoutes.set(path, cfg)
			}
			if (!g.realtimeBus && sub._graph.realtimeBus) {
				this._setBus(sub._graph.realtimeBus)
			}
			if (subSettings.taps !== null) {
				const s = this._graph.settings
				if (s.taps === null) s.taps = new Map()
				for (const [key, fn] of subSettings.taps) {
					if (!s.taps.has(key)) s.taps.set(key, fn)
				}
			}
			this._bumpEpoch()
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

	private _setBus(bus: RealtimeBus): RealtimeBus {
		const g = this._graph
		g.realtimeBus = bus
		g.realtimeCtx = createRealtimePublisher(bus, () => [...g.realtimeRoutes.values()].map((cfg) => cfg.namespace))
		return bus
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
		const pending: PendingRoute = { id: `${[method, ...(extraMethods ?? [])].join(",")} ${fullPath}` }
		this._graph.pending.add(pending)
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
			boundaryErrorKey: null,
			errorKeys: new Set(),
			extraMethods: extraMethods ?? null,
			inputSchemas: null,
			meta: this._chainMeta ? { ...this._chainMeta } : null,
			method,
			middlewares: [],
			outputSchemas: null,
			parent: this,
			path: fullPath,
			pending,
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

	/** @internal — set (or clear, with null) one app-wide middleware; used by `serve()` */
	_setGlobal(key: string, mw: RuntimeMiddleware | null): void {
		if (mw === null) {
			if (!this._graph.global.delete(key)) return
		} else {
			this._graph.global.set(key, mw)
		}
		this._bumpEpoch()
	}

	/** @internal — what a route registered through this handle captures */
	_view(): { chain: RuntimeMiddleware[]; cv: Record<string, unknown> | null; own: AppSettings<unknown> } {
		return { chain: this._chain, cv: this._contextValues, own: this._graph.settings }
	}

	/** @internal — a builder got its handler (or was abandoned on purpose) */
	_settle(pending: PendingRoute): void {
		this._graph.pending.delete(pending)
		this._markUsed()
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
		const fullPath = mergePath(this._basePath, path)
		const pending: PendingRoute = { id: `WS ${fullPath}` }
		this._graph.pending.add(pending)
		return new WSRouteBuilder<
			TEnv,
			TCtx & ApplyScoped<TScopedMw, MergePath<TBasePath, TPath>>,
			{},
			never,
			Honey<TEnv, TCtx, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>
		>({
			errorKeys: new Set(),
			inputSchemas: null,
			meta: this._chainMeta ? { ...this._chainMeta } : null,
			middlewares: [],
			parent: this,
			path: fullPath,
			pending,
		})
	}

	realtime<const TPath extends string>(
		path: TPath,
		opts: RealtimeRouteOpts<TCtx & ApplyScoped<TScopedMw, MergePath<TBasePath, TPath>>>,
	): this {
		const fullPath = mergePath(this._basePath, path)
		const g = this._graph
		const config = resolveRealtimeConfig(fullPath, opts)
		if (g.realtimeRoutes.has(fullPath)) {
			throw new Error(`Duplicate realtime route: ${fullPath}`)
		}
		if (!g.realtimeBus) this._setBus(createBus())
		g.realtimeRoutes.set(fullPath, config)
		this._markUsed()
		this._addWsRoute(parsePattern(fullPath), {
			bek: null,
			cm: [...this._chain],
			cv: this._contextValues,
			dk: new Set(),
			ek: new Set(),
			fn: Object.create(null),
			iv: null,
			mt: null,
			mw: [],
			own: g.settings,
			rb: null,
			rm: (opts.use ?? []).map((fn) => fn as RuntimeMiddleware),
			rp: fullPath,
			xm: this._chainMeta ? { ...this._chainMeta } : null,
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
		if (!this._graph.served.has(this._chain)) {
			this._markUsed()
			this._graph.served.add(this._chain)
			this._bumpEpoch()
		}
		const wsAdapter = this._graph.settings.wsAdapter
		const path = normalizePath(pathOfUrl(request.url), this._graph.settings.encodedSlashes)
		if (path === null) return this._badRequestTarget()
		/* Deno builds request.url by concatenating Host and the target, so a `Host: x/admin?` would
		 * choose the routed path. `serve()` checks Host on Deno; this covers `Deno.serve(app.fetch)`,
		 * which passes its serve info as env. Node's adapter checks it; Bun routes on the target. */
		if (isDenoServeInfo(env) && !hasValidHost(request)) return this._badRequestTarget()
		if (wsAdapter === null && !this._graph.hasWs) {
			return this._doFetch(request, env, executionCtx, path)
		}
		const isWsUpgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket"
		const headerSnap = isWsUpgrade ? new Headers(request.headers) : undefined
		const canPreUpgrade =
			isWsUpgrade &&
			wsAdapter?.preUpgrade !== undefined &&
			!this.trailingSlashRedirects(path) &&
			this._matchWs(this._finalize(), this.pathAfterPrefix(path)) !== null
		const pre = canPreUpgrade ? wsAdapter?.preUpgrade?.(request) : undefined
		/* After Deno.upgradeWebSocket the Request is closed. A sync throw here
		 * used to be boxed by async _doFetch; keep 101 returning either way. */
		let work: Response | Promise<Response>
		try {
			work = this._doFetch(request, env, executionCtx, path, isWsUpgrade === true, headerSnap)
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

	/** @internal 400 for a request path the normalization policy rejects (see `normalizePath`), or an invalid `Host`. */
	_badRequestTarget(): Response {
		return this._toErrorResponse(this._createError(EK.bad_request, SK.bad_request))
	}

	private trailingSlashRedirects(path: string): boolean {
		if (path.length <= 1) return false
		const mode = this._graph.settings.trailingSlash
		if (mode === "strip" && path.endsWith("/")) return true
		if (mode === "enforce" && !path.endsWith("/")) return true
		return false
	}

	private pathAfterPrefix(path: string): string {
		const prefix = this._graph.settings.stripPrefix
		if (prefix === null) return path
		if (path === prefix) return "/"
		if (path.startsWith(prefix) && path.charCodeAt(prefix.length) === 47) {
			return path.slice(prefix.length)
		}
		return path
	}

	private _doFetch(
		request: Request,
		env: TEnv,
		executionCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined,
		fullPath: string,
		knownWsUpgrade = false,
		headerSnap?: Headers,
	): Response | Promise<Response> {
		const startTime = performance.now()
		const final = this._finalize()
		const s = this._graph.settings
		const rawUrl = request.url

		/* lazily create URL only when actually needed (search params, redirects) */
		let _url: URL | undefined
		const getUrl = (): URL => {
			if (_url === undefined) _url = new URL(rawUrl)
			return _url
		}

		const log = s.logger ?? undefined
		const method = request.method.toUpperCase() as HttpMethod
		const fc: FetchCtx<TEnv> = {
			allowed: null,
			env,
			executionCtx,
			headerSnap,
			log,
			method,
			path: fullPath,
			plan: null,
			request,
			startTime,
			trust: s.trust,
			url: getUrl,
			ws: null,
			wsUpgrade: knownWsUpgrade,
		}

		if (s.telemetry !== null) {
			safeFire(() => s.telemetry?.onRequest?.({ env, req: request }), log)
		}

		/* trailing slash handling — a relative Location: the scheme, host and port the client
		 * used are the ones it keeps, whatever proxy terminated TLS in front of the app */
		if (this.trailingSlashRedirects(fullPath)) {
			const target = s.trailingSlash === "strip" ? fullPath.slice(0, -1) : `${fullPath}/`
			return new Response(null, {
				headers: { location: target + searchOfUrl(rawUrl) },
				status: 308,
			})
		}

		/* prefix stripping — must run AFTER trailing slash so redirects preserve the full prefixed URL */
		const path = this.pathAfterPrefix(fullPath)
		fc.path = path
		const root = this._graph.root

		/* WebSocket route check — do not re-read headers after Deno.upgradeWebSocket */
		const isWsUpgrade = knownWsUpgrade || requestIsWsUpgrade(request)
		if (isWsUpgrade) {
			const wsMatch = this._matchWs(final, path)
			if (wsMatch !== null) {
				return this._handleWs(fc, wsMatch)
			}
		}

		/* O(1) static route lookup — patterns without params or wildcards only */
		const staticHit =
			final.statics[`${method} ${path}`] ?? (method === "HEAD" ? final.statics[`GET ${path}`] : undefined)
		if (staticHit !== undefined) {
			return this._dispatchRecord(fc, staticHit, EMPTY_PARAMS)
		}

		const result = matchRoute(root, method, path)
		if (result === null) {
			/* no HTTP route: a websocket or realtime route on this path asks for an upgrade */
			if (!isWsUpgrade && this._graph.hasWs) {
				const wsMatch = this._matchWs(final, path)
				if (wsMatch !== null) {
					if (this._graph.realtimeRoutes.has(wsMatch.handler.rp)) {
						return new Response(null, { headers: { upgrade: "websocket" }, status: 426 })
					}
					return new Response("Upgrade Required", {
						headers: { connection: "Upgrade", upgrade: "websocket" },
						status: 426,
					})
				}
			}
			return this._handleMiss(fc, null)
		}
		if (!result.matched) {
			if (method === "OPTIONS") {
				const requested = request.headers.get("access-control-request-method")
				if (requested) {
					/* a preflight asks about one method: run that route's own chain */
					const hit = matchRoute(root, requested.trim().toUpperCase(), path)
					const plan = hit?.matched ? final.plans.get(hit.id) : undefined
					if (hit?.matched && plan !== undefined && plan.r.fn !== NOT_SERVED) {
						return this._handlePreflight(fc, plan, hit.params, result.allowed)
					}
				}
			}
			return this._handleMiss(fc, result.allowed)
		}
		const plan = final.plans.get(result.id)
		if (plan === undefined) return this._handleMiss(fc, null)
		return this._dispatchRecord(fc, plan, result.params)
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
		plan: Plan,
		params: Record<string, string>,
	): Response | Promise<Response> {
		const record = plan.r as RouteHandler
		if (record.fn === NOT_SERVED) return this._handleMiss(fc, null)
		/* a delegated route keeps its own input schemas for docs and the 415 check; the body
		 * itself belongs to whatever the catch-all forwards it to */
		if (record.dl === true && record.iv) {
			try {
				assertRequestContentType(record.iv, fc.request)
			} catch (thrown) {
				return this._toErrorResponse(thrown)
			}
		}
		return this._handleMatched(fc, plan, params)
	}

	private _makeErrorCtx(fc: FetchCtx<TEnv>, allowed?: string[]) {
		const s = this._s
		return {
			env: fc.env,
			jsonFromError: (err: HoneyError) => createErrorResponse(err, s.errorFormatter, s.customErrorFormatter),
			req: fc.request,
			...(allowed ? { allowed } : {}),
		}
	}

	/** A request context for `plan`: route data, context values, `ctx.errors`, `ctx.realtime`. */
	private _newCtx(fc: FetchCtx<TEnv>, plan: Plan, params: Record<string, string>, req?: Request): HoneyContext<TEnv> {
		fc.plan = plan
		const r = plan.r
		const ctx = new HoneyContext<TEnv>({
			env: fc.env,
			executionCtx: fc.executionCtx,
			meta: r.mt ?? undefined,
			params,
			path: fc.path,
			req: req ?? fc.request,
			routePattern: r.rp ?? "",
			urlFn: fc.url,
		})
		if (plan.cv !== null) Object.assign(ctx, plan.cv)
		const rt = this._graph.realtimeCtx
		if (rt !== null) (ctx as { realtime: unknown }).realtime = rt
		if (r.ef) ctx._setErrors(r.ef)
		ctx._rq = fc
		return ctx
	}

	private _handleWs(
		fc: FetchCtx<TEnv>,
		wsMatch: { handler: WSRouteHandler; params: Record<string, string> },
	): Response | Promise<Response> {
		const plan = this._finalize().wsPlans.get(wsMatch.handler.id as RouteId)
		if (plan === undefined) return this._handleMiss(fc, null)
		const isUpgrade = fc.wsUpgrade === true || requestIsWsUpgrade(fc.request)
		if (!isUpgrade) {
			return new Response(null, {
				headers: { upgrade: "websocket" },
				status: 426,
			})
		}
		if (!this._graph.settings.wsAdapter) {
			fc.log?.warn?.("WebSocket adapter not configured — call .wsAdapter()")
			return this._toErrorResponse(this._createError(EK.internal_server_error, SK.internal_server_error))
		}
		fc.ws = wsMatch
		const ctx = this._newCtx(fc, plan, wsMatch.params, ctxRequest(fc))
		return plan.run(ctx)
	}

	/** Terminal of a websocket route's chain: upgrade and wire the handler. */
	private async _wsUpgrade(finalCtx: HoneyContext<TEnv>): Promise<Response> {
		const fc = finalCtx._rq as FetchCtx<TEnv>
		const wsMatch = fc.ws as { handler: WSRouteHandler; params: Record<string, string> }
		const wsAdapter = this._graph.settings.wsAdapter as WSAdapter
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
	}

	/** Terminal of a realtime route's chain: identify, upgrade, and attach the connection to the bus. */
	private async _realtimeUpgrade(finalCtx: HoneyContext<TEnv>, config: RealtimeConfig): Promise<Response> {
		const fc = finalCtx._rq as FetchCtx<TEnv>
		const wsAdapter = this._graph.settings.wsAdapter as WSAdapter
		const bus = this._graph.realtimeBus ?? this._setBus(createBus())
		/* a throwing identify rejects the upgrade through the chain's error boundary */
		const userId = config.identify === null ? null : ((await config.identify(finalCtx)) ?? null)
		const session = createRealtimeSession({ bus, config, ctx: finalCtx, log: fc.log, userId })
		const upgradeResult = await wsAdapter.upgrade(fc.request, fc.env, session.handler)
		/* Node/CF return an open socket from upgrade(); Bun and Deno deliver it through onOpen */
		if (upgradeResult.socket && upgradeResult.socket.readyState === 1) session.attach(upgradeResult.socket)
		return upgradeResult.response
	}

	/**
	 * 404 (`allowed === null`) and 405: one pipeline with a synthetic record — full context,
	 * the app-wide middleware and the scopes covering the path run once, telemetry fires once.
	 */
	private _handleMiss(fc: FetchCtx<TEnv>, allowed: string[] | null): Response | Promise<Response> {
		const s = this._graph.settings
		const { method, path, request } = fc
		if (allowed === null) {
			safeFire(() => s.telemetry?.onNotFound?.({ method, path, req: request }), fc.log)
		} else {
			safeFire(() => s.telemetry?.onMethodNotAllowed?.({ allowed, method, path, req: request }), fc.log)
		}
		fc.allowed = allowed
		const plan = this._finalize().miss
		const ctx = this._newCtx(fc, plan, EMPTY_PARAMS)
		return this._withOnResponse(fc, plan.run(ctx))
	}

	/** Fire `onResponse` once and return. */
	private _withOnResponse(fc: FetchCtx<TEnv>, res: Response | Promise<Response>): Response | Promise<Response> {
		const s = this._graph.settings
		if (s.telemetry?.onResponse === undefined) return res
		const fire = (r: Response): Response => {
			safeFire(
				() =>
					s.telemetry?.onResponse?.({ duration: performance.now() - fc.startTime, req: fc.request, status: r.status }),
				fc.log,
			)
			return r
		}
		return res instanceof Promise ? res.then(fire) : fire(res)
	}

	private _make404(fc: FetchCtx<TEnv>): Response | Promise<Response> {
		const s = this._s
		if (s.onNotFound) return s.onNotFound(this._makeErrorCtx(fc))
		return this._makeErrorCtx(fc).jsonFromError(this._createError(EK.not_found, SK.not_found))
	}

	private async _make405(fc: FetchCtx<TEnv>, allowed: string[]): Promise<Response> {
		const s = this._s
		const res = s.onMethodNotAllowed
			? await s.onMethodNotAllowed(this._makeErrorCtx(fc, allowed) as ErrorCtx<TEnv> & { allowed: string[] })
			: this._makeErrorCtx(fc).jsonFromError(this._createError(EK.method_not_allowed, SK.method_not_allowed))
		const responseHeaders = new Headers(res.headers)
		responseHeaders.set("allow", allowed.join(", "))
		return new Response(res.body, {
			headers: responseHeaders,
			status: res.status,
		})
	}

	/**
	 * CORS preflight for a path that has no OPTIONS route: run the chain of the route the
	 * preflight asks about (`Access-Control-Request-Method`) — chain, scoped and route
	 * middleware, never input validation or the handler. Middleware that answers the
	 * preflight (cors) short-circuits; otherwise the answer is the 405 with `Allow`.
	 */
	private _handlePreflight(
		fc: FetchCtx<TEnv>,
		plan: Plan,
		params: Record<string, string>,
		allowed: string[],
	): Response | Promise<Response> {
		fc.allowed = allowed
		const ctx = this._newCtx(fc, plan, params)
		const final = this._finalize()
		plan.pf ??= compileChain(
			plan.pfChain,
			(c) => {
				const rq = (c as HoneyContext<TEnv>)._rq as FetchCtx<TEnv>
				return this._make405(rq, rq.allowed ?? [])
			},
			final.convert,
		)
		return this._withOnResponse(fc, plan.pf(ctx))
	}

	private _handleMatched(fc: FetchCtx<TEnv>, plan: Plan, params: Record<string, string>): Response | Promise<Response> {
		const ctx = this._newCtx(fc, plan, params)
		const telemetry = this._graph.settings.telemetry
		if (telemetry !== null && telemetry.onRoute !== undefined) {
			try {
				telemetry.onRoute({ method: fc.method, params, path: fc.path, req: fc.request })
			} catch {
				/* telemetry must not crash request */
			}
		}
		const res = plan.run(ctx)
		if (res instanceof Promise) return res.then((r) => this._finishMatched(fc, plan, ctx, r))
		return this._finishMatched(fc, plan, ctx, res)
	}

	/** Output validation, inside the chain: an invalid body becomes an error response the middleware sees. */
	private async _validateOutput(handler: RouteHandler, ctx: HoneyContext<TEnv>, response: Response): Promise<Response> {
		if (response === undefined || response === null || ctx._isErrorResponse) return response
		/* read the creation tag, never `response.body`: on Node that would build a stream per response */
		const kind = bodyKind(response)
		if (kind === "empty") return response
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

		/* JSON schema validation. A body Honey built from a string is validated from that string
		 * (no stream, no tee); anything else is read from a clone (Bun clone() drains the original).
		 * A stream Honey created (sse, stream, generate) is never buffered: it may never end. */
		if (ct?.startsWith("application/json") && handler.ov && !isProducedStream(response)) {
			const sk = codeToStatusKey[response.status]
			if (sk) {
				const raw = rawBodyOf(response)
				if (raw !== null) {
					const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw)
					await handler.ov(sk, text.length === 0 ? null : JSON.parse(text))
					return response
				}
				const forReturn = response.clone()
				const data: unknown = await response.json()
				await handler.ov(sk, data)
				return forReturn
			}
		}
		return response
	}

	private _finishMatched(fc: FetchCtx<TEnv>, plan: Plan, ctx: HoneyContext<TEnv>, response: Response): Response {
		const s = this._graph.settings
		const handler = plan.r
		/* taps — fire after successful handler, non-blocking */
		if (plan.taps !== null && !ctx._isErrorResponse) {
			const taps = plan.taps
			const log = fc.log

			/* meta-driven taps — fire for each registered key found in route meta */
			if (handler.mt !== null) {
				for (const [key, tapFn] of taps) {
					const metaValue = handler.mt[key]
					if (metaValue !== undefined) {
						ctx.background(
							Promise.resolve()
								.then(() => tapFn(ctx as unknown as TapContext<unknown>, metaValue))
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
								.then(() => tapFn(ctx as unknown as TapContext<unknown>, pending.payload))
								.catch((e) => log?.warn?.({ err: e, tap: pending.key }, "tap failed")),
						)
					}
				}
				ctx._pendingTaps = null
			}
		}

		if (s.telemetry !== null) {
			try {
				const duration = performance.now() - fc.startTime
				s.telemetry.onHandler?.({
					duration,
					method: fc.method,
					path: fc.path,
					status: response.status,
				})
				s.telemetry.onResponse?.({
					duration,
					req: fc.request,
					status: response.status,
				})
			} catch {
				/* telemetry must never crash the response path */
			}
		}
		if (fc.method === "HEAD") return headResponse(response)
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
	_settle(pending: PendingRoute): void
	_view(): { chain: RuntimeMiddleware[]; cv: Record<string, unknown> | null; own: unknown }
}

type RouteBuilderState<TParent> = {
	boundaryErrorKey: string | null
	/** keys the route declares itself (`.errors()`, `.boundary()`) */
	errorKeys: Set<string>
	extraMethods: (HttpMethod | "ALL")[] | null
	inputSchemas: InputSchemasDef | null
	/** explicit meta — chain `.meta()` overlaid by route `.meta()` */
	meta: Record<string, unknown> | null
	method: HttpMethod | "ALL"
	/** route-level middleware */
	middlewares: RuntimeMiddleware[]
	outputSchemas: OutputSchemaDef | null
	parent: TParent
	/** canonical full pattern */
	path: string
	/** reported at finalize until `.handler()` runs */
	pending: PendingRoute
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

		const parent = this._s.parent as unknown as HoneyInternal
		const view = parent._view()
		const base: RouteHandler = {
			_skip: isInternal || undefined,
			bek: null,
			cm: [...view.chain],
			cv: view.cv,
			dk: new Set(this._s.errorKeys),
			/* provisional until finalize resolves scopes and app defaults */
			ek: new Set(this._s.errorKeys),
			fn: fn as (ctx: unknown) => Response | Promise<Response>,
			iv: this._s.inputSchemas,
			mt: mergeContributedMeta(collectMiddlewareMeta([view.chain, this._s.middlewares]), this._s.meta),
			mw: [],
			os: this._s.outputSchemas,
			ov,
			own: view.own,
			rb: this._s.boundaryErrorKey,
			rm: [...this._s.middlewares],
			xm: this._s.meta ? { ...this._s.meta } : null,
		}

		/* one record per method — `.on([...])` registers each under its own RouteId */
		parent._settle(this._s.pending)
		const segments = parsePattern(this._s.path)
		const methods = [this._s.method, ...(this._s.extraMethods ?? [])]
		for (const method of methods) assertBodySchemaAllowed(this._s.inputSchemas, method, this._s.path)
		for (let i = 0; i < methods.length; i++) {
			parent._addRoute(methods[i], segments, i === 0 ? base : copyRecord(base))
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
		})
	}
}

type WSRouteBuilderState<TParent> = {
	errorKeys: Set<string>
	inputSchemas: InputSchemasDef | null
	meta: Record<string, unknown> | null
	middlewares: RuntimeMiddleware[]
	parent: TParent
	path: string
	pending: PendingRoute
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
		const parent = this._s.parent as unknown as HoneyInternal
		const view = parent._view()
		const routeHandler: WSRouteHandler = {
			bek: null,
			cm: [...view.chain],
			cv: view.cv,
			dk: new Set(this._s.errorKeys),
			ek: new Set(),
			fn: wsHandler as WSHandler<unknown>,
			iv: this._s.inputSchemas,
			mt: null,
			mw: [],
			own: view.own,
			rb: null,
			rm: [...this._s.middlewares],
			rp: this._s.path,
			xm: this._s.meta ? { ...this._s.meta } : null,
		}
		parent._settle(this._s.pending)
		parent._addWsRoute(parsePattern(this._s.path), routeHandler)
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
		this._s.meta = { ...this._s.meta, ...meta }
		return this
	}

	use<TAdds>(mw: MiddlewareFn<TCtx, TAdds>): WSRouteBuilder<TEnv, TCtx & TAdds, TInput, _TErrorKeys, TParent> {
		return new WSRouteBuilder<TEnv, TCtx & TAdds, TInput, _TErrorKeys, TParent>({
			...this._s,
			middlewares: [...this._s.middlewares, mw as RuntimeMiddleware],
		})
	}
}

export function honey<TEnv>(): Honey<TEnv> {
	return new Honey<TEnv>()
}
