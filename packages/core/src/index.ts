import { HoneyContext } from "./context.ts";
import { HoneyError } from "./error.ts";
import { ERROR_META } from "./errors.ts";
import type { MiddlewareFn, RuntimeMiddleware } from "./middleware.ts";
import { compileChain, executeChain } from "./middleware.ts";
import type { ProxyConfig } from "./proxy.ts";
import { createProxyHandler } from "./proxy.ts";
import type {
	CustomErrorFormatter,
	ErrorFormatter,
	ResponseOptions,
	TypedResponse,
} from "./response.ts";
import { createErrorResponse, type HoneyRes } from "./response.ts";
import type {
	OutputValidator,
	RouteHandler,
	RouteTree,
	TreeNode,
	WSRouteHandler,
} from "./tree.ts";
import {
	createNode,
	insertRoute,
	insertWsRoute,
	matchRoute,
	matchWsRoute,
	mergeInto,
} from "./tree.ts";
import { createBus } from "./realtime/bus.ts";
import type { RealtimeBus } from "./realtime/bus.ts";
import { createConnContext } from "./realtime/route.ts";
import type { RealtimeRouteOpts } from "./realtime/route.ts";
	import type {
		ComputeErrorsByStatus,
		DefaultMeta,
	ExtractSchemas,
	HttpMethod,
		InferInputMap,
		InferOutput,
		InputSchemasDef,
		MergePath,
		MergeRoute,
		OutputSchemaDef,
		ParamsFromPath,
		StandardSchemaLike,
		StatusKey,
	TapContext,
} from "./types.ts";
import { codeToStatusKey, EK, SK } from "./types.ts";
import { validateInput, validateOutput } from "./validation.ts";
import type { WSAdapter, WSContext, WSHandler } from "./ws/cloudflare.ts";

export { HoneyContext } from "./context.ts";
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
>;
export { HoneyError } from "./error.ts";
export { defineErrors, ERROR_META } from "./errors.ts";
export type { ErrorMetaEntry } from "./errors.ts";
export type { MiddlewareFn } from "./middleware.ts";
export { createMiddleware, defineMiddleware } from "./middleware.ts";
export type { ProxyConfig } from "./proxy.ts";
export type { PendingTap, TapContext, TapHandler } from "./types.ts";
export type {
	CookieOptions,
	CustomErrorFormatter,
	ErrorFormatter,
	ResponseOptions,
	SSEEvent,
	SSEOptions,
	SSEStream,
	TypedResponse,
} from "./response.ts";
export { createErrorResponse, HoneyRes } from "./response.ts";
export { mergeTree } from "./tree.ts";
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
	OpenApiMeta,
	OutputSchemaDef,
	Overwrite,
	ComputeErrorsByStatus,
	RouteRecord,
	StandardSchemaLike,
	StatusKey,
	SuccessStatusKey,
} from "./types.ts";
export type { WSAdapter, WSContext, WSHandler } from "./ws/cloudflare.ts";
export type { ConnContext, RealtimeRouteOpts } from "./realtime/route.ts";
export type { RealtimeBus } from "./realtime/bus.ts";
export { generateMCPServer } from "./codegen-mcp.ts";

/** Type predicate for incoming wire-protocol msg frames from the realtime client. */
function isMsgFrame(value: unknown): value is { data: unknown; t: "msg" } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (!("t" in value) || !("data" in value)) return false;
	return value.t === "msg";
}

type TelemetryAdapter = {
	onError?(ctx: {
		duration: number;
		error: HoneyError;
		method: string;
		path: string;
	}): void;
	onHandler?(ctx: {
		duration: number;
		method: string;
		path: string;
		status: number;
	}): void;
	onMethodNotAllowed?(ctx: {
		allowed: string[];
		method: string;
		path: string;
		req: Request;
	}): void;
	onMiddleware?(ctx: { duration: number; error?: unknown; name: string }): void;
	onNotFound?(ctx: { method: string; path: string; req: Request }): void;
	onRequest?(ctx: { env: unknown; req: Request }): void;
	onResponse?(ctx: { duration: number; req: Request; status: number }): void;
	onRoute?(ctx: {
		method: string;
		params: Record<string, string>;
		path: string;
		req: Request;
	}): void;
};

type ErrorI18nConfig<TEnv> = {
	errors?: Record<string, Record<string, string>>;
	fieldNames?: Record<string, Record<string, string>>;
	resolveLocale: (ctx: {
		cookies: Record<string, string>;
		env: TEnv;
		headers: Record<string, string>;
		params: Record<string, string>;
		req: Request;
		search: Record<string, string>;
	}) => string | Promise<string>;
};

type Logger = {
	warn?(msg: string, ...args: unknown[]): void;
};

function mergePath(base: string, path: string): string {
	if (base === "/") return path;
	if (path === "/") return base;
	return `${base}${path}`;
}

/** Normalize a scope prefix: ensure leading slash, strip trailing slash (except "/"). */
function normalizeScopePath(raw: string): string {
	let p = raw;
	if (p.length === 0) return "/";
	if (p.charCodeAt(0) !== 47) p = `/${p}`;
	if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	return p;
}

/** Check whether fullPath falls under scope prefix — exact match or next char is '/'. */
function scopeMatches(prefix: string, fullPath: string): boolean {
	if (prefix === "/") return true;
	if (fullPath === prefix) return true;
	if (fullPath.length <= prefix.length) return false;
	if (fullPath.charCodeAt(prefix.length) !== 47) return false;
	return fullPath.startsWith(prefix);
}

function walkTreeHandlers(
	root: TreeNode,
	cb: (h: RouteHandler) => void,
	wsCb?: (h: WSRouteHandler) => void,
): void {
	if (root.m) {
		for (const h of Object.values(root.m) as RouteHandler[]) cb(h);
	}
	if (root.w) {
		for (const h of Object.values(root.w.m) as RouteHandler[]) cb(h);
	}
	if (root.ws && wsCb) wsCb(root.ws);
	for (const child of Object.values(root.s)) walkTreeHandlers(child, cb, wsCb);
	if (root.d) walkTreeHandlers(root.d.c, cb, wsCb);
}

/** Find first '?' or '#' in url starting from pos */
function findSearchOrHash(url: string, pos: number): number {
	for (let i = pos; i < url.length; i++) {
		const c = url.charCodeAt(i);
		if (c === 63 || c === 35) return i;
	}
	return -1;
}

function safeFire(fn: (() => unknown) | undefined, logger?: Logger): void {
	if (fn === undefined) return;
	try {
		const result = fn();
		if (result && typeof result === "object" && "catch" in result) {
			(result as Promise<unknown>).catch((e: unknown) => {
				logger?.warn?.("telemetry callback failed", e);
			});
		}
	} catch (e) {
		logger?.warn?.("telemetry callback failed", e);
	}
}

/** Internal context shared across extracted fetch sub-methods */
type FetchCtx<TEnv> = {
	env: TEnv;
	executionCtx: { waitUntil?: (p: Promise<unknown>) => void } | undefined;
	log: Logger | undefined;
	request: Request;
	startTime: number;
	url: () => URL;
};

function defaultErrorFormatter(
	_error: HoneyError,
	defaultShape: Record<string, unknown>,
): Record<string, unknown> {
	return defaultShape;
}

type ErrorFormatterFn = ErrorFormatter;

const STATIC_CTX_RESERVED = new Set([
	"background",
	"cookies",
	"env",
	"headers",
	"params",
	"req",
	"res",
	"search",
]);

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
]);

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
	declare readonly $basePath: TBasePath;
	declare readonly $ctx: TCtx;
	declare readonly $env: TEnv;
	declare readonly $errorFactory: TErrorFactory;
	declare readonly $meta: TMeta;
	declare readonly $routes: TRoutes;
	declare readonly $taps: TTaps;
	private _basePath: string;
	private _defaultBoundaryKey: string | null;
	private _defaultErrorKeys: Set<string>;
	private _errorFactory: unknown;
	private _errorSchema: StandardSchemaLike | null;
	private _customErrorFormatter: CustomErrorFormatter | null;
	private _customErrorSchema: StandardSchemaLike | null;
	private _chainMeta: Record<string, unknown> | null;
	private _chainMiddlewares: RuntimeMiddleware[];
	private _scopedMiddlewares: ScopedEntry[];
	private _contextValues: Record<string, unknown> | null;
	private _errorFormatter: ErrorFormatterFn;
	private _errorI18n: ErrorI18nConfig<TEnv> | null;
	private _globalMiddlewares: RuntimeMiddleware[];
	private _handlerMap: Record<string, RouteHandler> | null;
	private _hasRouteTree: boolean;
	private _hasWsRoutes: boolean;
	private _logger: Logger | null;
	private _outputValidation: "always" | "dev" | "off";
	private _staticRoutes: Record<string, RouteHandler> | null;
	private _stripPrefix: string | null;
	private _trailingSlash: "enforce" | "ignore" | "strip";
	private _wsAdapter: WSAdapter | null;
	private _onError:
		| ((
				error: unknown,
				ctx: {
					env: TEnv;
					jsonFromError: (err: HoneyError) => Response;
					req: Request;
				},
		  ) => HoneyError | Response | Promise<HoneyError | Response | undefined | void> | undefined | void)
		| null;
	private _onMethodNotAllowed:
		| ((ctx: {
				allowed: string[];
				env: TEnv;
				jsonFromError: (err: HoneyError) => Response;
				req: Request;
		  }) => Response | Promise<Response>)
		| null;
	private _onNotFound:
		| ((ctx: {
				env: TEnv;
				jsonFromError: (err: HoneyError) => Response;
				req: Request;
		  }) => Response | Promise<Response>)
		| null;
	private _root: TreeNode;
	private _taps: Map<
		string,
		(ctx: TapContext<TEnv>, payload: unknown) => void | Promise<void>
	> | null;
	private _telemetry: TelemetryAdapter | null;
	private _realtimeBus: RealtimeBus | null;
	private _realtimeRoutes: Map<string, { handler: RealtimeRouteOpts["handler"]; middlewares?: RealtimeRouteOpts["use"]; reconnectBuffer?: number }>;

	constructor(opts?: {
		chainMiddlewares?: RuntimeMiddleware[];
		defaultErrorKeys?: Set<string>;
		globalMiddlewares?: RuntimeMiddleware[];
		handlerMap?: Record<string, RouteHandler> | null;
		root?: TreeNode;
		scopedMiddlewares?: ScopedEntry[];
	}) {
		this._basePath = "/";
		this._root = opts?.root ?? createNode();
		this._globalMiddlewares = opts?.globalMiddlewares ?? [];
		this._scopedMiddlewares = opts?.scopedMiddlewares ?? [];
		this._chainMeta = null;
		this._chainMiddlewares = opts?.chainMiddlewares ?? [];
		this._contextValues = null;
		this._defaultBoundaryKey = null;
		this._defaultErrorKeys = opts?.defaultErrorKeys ?? new Set();
		this._errorFactory = null;
		this._errorSchema = null;
		this._customErrorFormatter = null;
		this._customErrorSchema = null;
		this._errorFormatter = defaultErrorFormatter;
		this._errorI18n = null;
		this._handlerMap = opts?.handlerMap ?? null;
		this._hasRouteTree = false;
		this._hasWsRoutes = false;
		this._logger = null;
		this._outputValidation = "off";
		this._staticRoutes = null;
		this._stripPrefix = null;
		this._trailingSlash = "ignore";
		this._wsAdapter = null;
		this._onError = null;
		this._onNotFound = null;
		this._onMethodNotAllowed = null;
		this._taps = null;
		this._telemetry = null;
		this._realtimeBus = null;
		this._realtimeRoutes = new Map();
	}

	/** @internal — used by codegen */
	private get _tree(): TreeNode {
		return this._root;
	}

	/** @internal — mark that this app has WS routes */
	_markWsRoutes(): void {
		this._hasWsRoutes = true;
	}

	/** @internal — register a static route for O(1) lookup */
	_registerStatic(key: string, handler: RouteHandler): void {
		if (this._staticRoutes === null) {
			this._staticRoutes = Object.create(null) as Record<string, RouteHandler>;
		}
		this._staticRoutes[key] = handler;
	}

	/** @internal — used by RouteBuilder for pre-filtered error factory */
	get _factory(): unknown {
		return this._errorFactory;
	}

	/** @internal — used by runtime error boundary */
	get _boundaryKey(): string | null {
		return this._defaultBoundaryKey;
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
					});
		return createErrorResponse(error, this._errorFormatter, this._customErrorFormatter);
	}

	private _createBoundaryError(errorKey: string, cause: unknown): HoneyError {
		const factory = this._errorFactory as Record<
			string,
			((opts?: { cause?: unknown }) => HoneyError) | undefined
		> | null;
		const factoryFn = factory?.[errorKey];
		if (factoryFn) {
			/* check if this is a custom schema error via ERROR_META — boundary must use standard errors only */
			const meta = (factory as Record<symbol, Record<string, { schema: unknown }>>)?.[ERROR_META];
			if (meta?.[errorKey]?.schema) {
				/* custom schema error — cannot be used as boundary, fall through to manual construction */
			} else {
				return factoryFn({ cause });
			}
		}
		return new HoneyError({
			cause,
			errorKey,
			status: SK.internal_server_error,
		});
	}

	private _createError(errorKey: string, statusKey: StatusKey): HoneyError {
		const factory = this._errorFactory as Record<
			string,
			(() => HoneyError) | undefined
		> | null;
		const factoryFn = factory?.[errorKey];
		if (factoryFn) {
			return factoryFn();
		}
		return new HoneyError({ errorKey, status: statusKey });
	}

	/** Apply error keys from a single scoped entry to every matching handler currently in the tree */
	private _applyScopedEntryErrors(entry: ScopedEntry): void {
		const errors = entry.errors;
		if (!errors || errors.length === 0) return;
		walkTreeHandlers(
			this._root,
			(h) => {
				if (scopeMatches(entry.prefix, h.rp)) {
					for (const k of errors) h.ek.add(k);
				}
			},
			(wh) => {
				if (scopeMatches(entry.prefix, wh.rp)) {
					for (const k of errors) wh.ek.add(k);
				}
			},
		);
	}

	/** Apply error keys from every scoped entry on this chain to every matching handler in the tree */
	private _applyAllScopedErrors(): void {
		for (const entry of this._scopedMiddlewares) {
			this._applyScopedEntryErrors(entry);
		}
	}

	/** Return scoped middleware functions that match the given route path */
	private _filterScopedForPath(routePath: string): RuntimeMiddleware[] {
		if (this._scopedMiddlewares.length === 0) return [];
		const out: RuntimeMiddleware[] = [];
		for (const s of this._scopedMiddlewares) {
			if (scopeMatches(s.prefix, routePath)) out.push(s.mw);
		}
		return out;
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
		if (!this._errorI18n) return;
		try {
			const locale = await this._errorI18n.resolveLocale({
				cookies: ctx.cookies,
				env,
				headers: ctx.headers,
				params: ctx.params,
				req: request,
				search: ctx.search,
			});
			const translations = this._errorI18n.errors?.[locale];
			if (translations) {
				const template = translations[honeyError.errorKey];
				if (template) {
					const { interpolate } = await import("./i18n.ts");
					honeyError.message = interpolate(template, honeyError.vars ?? {});
				}
			}

			const fieldTranslations = this._errorI18n.fieldNames?.[locale];
			if (fieldTranslations && Object.keys(honeyError.fields).length > 0) {
				for (const fieldErrors of Object.values(honeyError.fields)) {
					for (const fe of fieldErrors) {
						let candidate = fe.path;
						while (candidate) {
							const translated = fieldTranslations[candidate];
							if (translated) {
								fe.path = translated;
								break;
							}
							const dotIdx = candidate.indexOf(".");
							if (dotIdx === -1) break;
							candidate = candidate.slice(dotIdx + 1);
						}
					}
				}
			}
		} catch (e) {
			log?.warn?.("i18n resolution failed", e);
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
		const { env, log, request, startTime } = fc;
		let honeyError: HoneyError;
		const boundaryKey = handler.bek ?? this._defaultBoundaryKey;

		if (thrown instanceof HoneyError) {
			/* framework-managed errorKeys (input/output validation, content negotiation, etc.) are always allowed
			 * regardless of handler.ek — users never declare them, the framework owns them. */
			const isFrameworkEk = FRAMEWORK_EKS.has(thrown.errorKey as (typeof EK)[keyof typeof EK]);
			if (!isFrameworkEk && handler.ek.size > 0 && !handler.ek.has(thrown.errorKey)) {
				if (boundaryKey) {
					honeyError = this._createBoundaryError(boundaryKey, thrown);
				} else {
					honeyError = new HoneyError({
						cause: thrown,
						errorKey: EK.internal_server_error,
						status: SK.internal_server_error,
					});
				}
			} else {
				honeyError = thrown;
			}
		} else {
			if (boundaryKey) {
				honeyError = this._createBoundaryError(boundaryKey, thrown);
			} else {
				honeyError = new HoneyError({
					cause: thrown,
					errorKey: EK.internal_server_error,
					status: SK.internal_server_error,
				});
			}
		}

		await this._resolveI18n(honeyError, ctx, env, request, log);

		/* onError handler */
		if (this._onError) {
			try {
				const customResult = await this._onError(thrown, this._makeErrorCtx(fc));
				if (customResult instanceof HoneyError) {
					/* user-mapped boundary error — re-run i18n against new errorKey,
					 * then fall through to default response path so telemetry +
					 * jsonFromError run exactly once. */
					honeyError = customResult;
					await this._resolveI18n(honeyError, ctx, env, request, log);
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
					);
					safeFire(
						() =>
							this._telemetry?.onResponse?.({
								duration: performance.now() - startTime,
								req: request,
								status: customResult.status,
							}),
						log,
					);
					ctx._isErrorResponse = true;
					return customResult;
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
		);
		const res = this._makeErrorCtx(fc).jsonFromError(honeyError);
		safeFire(
			() =>
				this._telemetry?.onResponse?.({
					duration: performance.now() - startTime,
					req: request,
					status: res.status,
				}),
			log,
		);
		ctx._isErrorResponse = true;
		return res;
	}

	basePath<P extends string>(
		prefix: P,
	): Honey<
		TEnv,
		TCtx,
		TRoutes,
		TMeta,
		TErrorFactory,
		TDefaultErrors,
		MergePath<TBasePath, P>,
		TTaps,
		TScopedMw
	> {
		const next = new Honey<
			TEnv,
			TCtx,
			TRoutes,
			TMeta,
			TErrorFactory,
			TDefaultErrors,
			MergePath<TBasePath, P>,
			TTaps,
			TScopedMw
		>({
			chainMiddlewares: this._chainMiddlewares,
			defaultErrorKeys: this._defaultErrorKeys,
			globalMiddlewares: this._globalMiddlewares,
			handlerMap: this._handlerMap,
			root: this._root,
			scopedMiddlewares: this._scopedMiddlewares,
		});
		next._basePath = mergePath(this._basePath, prefix);
		next._defaultBoundaryKey = this._defaultBoundaryKey;
		next._errorFactory = this._errorFactory;
		next._errorSchema = this._errorSchema;
		next._customErrorFormatter = this._customErrorFormatter;
		next._customErrorSchema = this._customErrorSchema;
		next._errorFormatter = this._errorFormatter;
		next._errorI18n = this._errorI18n;
		next._logger = this._logger;
		next._outputValidation = this._outputValidation;
		next._stripPrefix = this._stripPrefix;
		next._trailingSlash = this._trailingSlash;
		next._wsAdapter = this._wsAdapter;
		next._onError = this._onError;
		next._onNotFound = this._onNotFound;
		next._onMethodNotAllowed = this._onMethodNotAllowed;
		next._chainMeta = this._chainMeta;
		next._contextValues = this._contextValues;
		next._taps = this._taps;
		next._telemetry = this._telemetry;
		next._realtimeBus = this._realtimeBus;
		next._realtimeRoutes = this._realtimeRoutes;
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
		>;
	}

	context<TAdds extends Record<string, unknown>>(
		values: TAdds,
	): Honey<
		TEnv,
		TCtx & Readonly<TAdds>,
		TRoutes,
		TMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		for (const key in values) {
			if (STATIC_CTX_RESERVED.has(key)) {
				throw new Error(`context() cannot set reserved key "${key}"`)
			}
		}
		const next = new Honey<
			TEnv,
			TCtx & Readonly<TAdds>,
			TRoutes,
			TMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>({
			chainMiddlewares: this._chainMiddlewares,
			defaultErrorKeys: this._defaultErrorKeys,
			globalMiddlewares: this._globalMiddlewares,
			handlerMap: this._handlerMap,
			root: this._root,
			scopedMiddlewares: this._scopedMiddlewares,
		});
		next._basePath = this._basePath;
		next._chainMeta = this._chainMeta;
		next._contextValues = this._contextValues
			? { ...this._contextValues, ...values }
			: { ...values };
		next._defaultBoundaryKey = this._defaultBoundaryKey;
		next._errorFactory = this._errorFactory;
		next._errorSchema = this._errorSchema;
		next._customErrorFormatter = this._customErrorFormatter;
		next._customErrorSchema = this._customErrorSchema;
		next._errorFormatter = this._errorFormatter;
		next._errorI18n = this._errorI18n;
		next._logger = this._logger;
		next._outputValidation = this._outputValidation;
		next._stripPrefix = this._stripPrefix;
		next._trailingSlash = this._trailingSlash;
		next._wsAdapter = this._wsAdapter;
		next._onError = this._onError;
		next._onNotFound = this._onNotFound;
		next._onMethodNotAllowed = this._onMethodNotAllowed;
		next._taps = this._taps;
		next._telemetry = this._telemetry;
		next._realtimeBus = this._realtimeBus;
		next._realtimeRoutes = this._realtimeRoutes;
		return next as unknown as Honey<TEnv, TCtx & Readonly<TAdds>, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>;
	}

	logger(logger: Logger): this {
		this._logger = logger;
		return this;
	}

	outputValidation(mode: "always" | "dev" | "off"): this {
		this._outputValidation = mode;
		return this;
	}

	trailingSlash(mode: "enforce" | "ignore" | "strip"): this {
		this._trailingSlash = mode;
		return this;
	}

	/** Strip a URL path prefix before route matching — boundary-safe (won't strip partial segments), paths without the prefix pass through unchanged */
	stripPrefix(prefix: string): this {
		let normalized = prefix.replace(/\/+$/, "");
		if (normalized.length > 0 && normalized.charCodeAt(0) !== 47) {
			normalized = `/${normalized}`;
		}
		this._stripPrefix = normalized === "" || normalized === "/" ? null : normalized;
		return this;
	}

	wsAdapter(adapter: WSAdapter): this {
		this._wsAdapter = adapter;
		return this;
	}

	defaultErrorFormatter<TSchema extends StandardSchemaLike>(
		schema: TSchema,
		fn: (error: HoneyError) => InferOutput<TSchema>,
	): this;
	defaultErrorFormatter(fn: ErrorFormatterFn): this;
	defaultErrorFormatter(
		schemaOrFn: ErrorFormatterFn | StandardSchemaLike,
		maybeFn?: (error: HoneyError) => unknown,
	): this {
		if (typeof schemaOrFn === "function") {
			this._errorSchema = null;
			this._errorFormatter = schemaOrFn;
		} else {
			this._errorSchema = schemaOrFn;
			const mapper = maybeFn as (error: HoneyError) => Record<string, unknown>;
			this._errorFormatter = (error) => mapper(error);
		}
		return this;
	}

	customErrorFormatter<TSchema extends StandardSchemaLike>(
		schema: TSchema,
		fn: (error: HoneyError, data: Record<string, unknown>) => InferOutput<TSchema>,
	): this;
	customErrorFormatter(fn: CustomErrorFormatter): this;
	customErrorFormatter(
		schemaOrFn: CustomErrorFormatter | StandardSchemaLike,
		maybeFn?: (error: HoneyError, data: Record<string, unknown>) => unknown,
	): this {
		if (typeof schemaOrFn === "function") {
			this._customErrorSchema = null;
			this._customErrorFormatter = schemaOrFn;
		} else {
			this._customErrorSchema = schemaOrFn;
			const mapper = maybeFn as (error: HoneyError, data: Record<string, unknown>) => Record<string, unknown>;
			this._customErrorFormatter = (error, data) => mapper(error, data);
		}
		return this;
	}

	errorI18n(config: ErrorI18nConfig<TEnv>): this {
		this._errorI18n = config;
		return this;
	}

	onError(
		handler: (
			error: unknown,
			ctx: {
				env: TEnv;
				jsonFromError: (err: HoneyError) => Response;
				req: Request;
			},
		) => HoneyError | Response | Promise<HoneyError | Response | undefined | void> | undefined | void,
	): this {
		this._onError = handler;
		return this;
	}

	onMethodNotAllowed(
		handler: (ctx: {
			allowed: string[];
			env: TEnv;
			jsonFromError: (err: HoneyError) => Response;
			req: Request;
		}) => Response | Promise<Response>,
	): this {
		this._onMethodNotAllowed = handler;
		return this;
	}

	onNotFound(
		handler: (ctx: {
			env: TEnv;
			jsonFromError: (err: HoneyError) => Response;
			req: Request;
		}) => Response | Promise<Response>,
	): this {
		this._onNotFound = handler;
		return this;
	}

	/** Register a tap handler keyed by name — fires after successful handler response */
	tap<K extends string>(
		key: K,
		handler: (
			ctx: TapContext<TEnv>,
			payload: K extends keyof TTaps ? TTaps[K] : unknown,
		) => void | Promise<void>,
	): this {
		if (this._taps === null) {
			this._taps = new Map();
		}
		this._taps.set(key, handler as (ctx: TapContext<TEnv>, payload: unknown) => void | Promise<void>);
		return this;
	}

	telemetry(adapter: TelemetryAdapter): this {
		this._telemetry = adapter;
		return this;
	}

	routeTree(tree: RouteTree): this {
		this._root = tree.root;
		this._handlerMap = tree.handlers ?? null;
		this._hasRouteTree = true;
		return this;
	}

	toRouteTree(): RouteTree {
		return { meta: {}, root: this._root };
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
		>;
		next._errorFactory = factory;
		return next;
	}

	defaultErrors<
		TKeys extends [TErrorFactory] extends [never]
			? never
			: keyof TErrorFactory & string,
	>(
		...keys: TKeys[]
	): Honey<
		TEnv,
		TCtx,
		TRoutes,
		TMeta,
		TErrorFactory,
		TDefaultErrors | TKeys,
		TBasePath,
		TTaps,
		TScopedMw
	> {
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
		>;
		for (const k of keys) {
			next._defaultErrorKeys.add(k);
		}
		return next;
	}

	defaultBoundary<
		TKey extends [TErrorFactory] extends [never]
			? never
			: keyof TErrorFactory & string,
	>(key: TKey): Honey<
		TEnv,
		TCtx,
		TRoutes,
		TMeta,
		TErrorFactory,
		TDefaultErrors | TKey,
		TBasePath,
		TTaps,
		TScopedMw
	> {
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
		>;
		next._defaultBoundaryKey = key;
		next._defaultErrorKeys.add(key);
		return next;
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
	>;
	/** Typed chain-level default meta — constrains route meta and sets runtime defaults in one call */
	meta<
		TNewMeta extends Record<string, unknown>,
		TValues extends Partial<DefaultMeta> & Partial<TNewMeta>,
	>(
		values: TValues,
	): Honey<
		TEnv,
		TCtx,
		TRoutes,
		TNewMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	>;
	/** Chain-level default meta — merged into every route registered on this chain */
	meta<
		TValues extends Partial<DefaultMeta> &
		([TMeta] extends [never] ? {} : Partial<TMeta>),
	>(
		values: TValues,
	): Honey<
		TEnv,
		TCtx,
		TRoutes,
		TMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	>;
	meta(values?: Record<string, unknown>): Honey<
		TEnv,
		TCtx,
		TRoutes,
		unknown,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		if (values === undefined) {
			/* phantom overload — type-only, no runtime effect */
			return this as Honey<TEnv, TCtx, TRoutes, unknown, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>;
		}
		/* chain-level meta — copy-on-write */
		const next = new Honey<
			TEnv,
			TCtx,
			TRoutes,
			unknown,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>({
			chainMiddlewares: this._chainMiddlewares,
			defaultErrorKeys: this._defaultErrorKeys,
			globalMiddlewares: this._globalMiddlewares,
			handlerMap: this._handlerMap,
			root: this._root,
			scopedMiddlewares: this._scopedMiddlewares,
		});
		next._basePath = this._basePath;
		next._chainMeta = this._chainMeta
			? { ...this._chainMeta, ...values }
			: { ...values };
		next._contextValues = this._contextValues;
		next._defaultBoundaryKey = this._defaultBoundaryKey;
		next._errorFactory = this._errorFactory;
		next._errorSchema = this._errorSchema;
		next._customErrorFormatter = this._customErrorFormatter;
		next._customErrorSchema = this._customErrorSchema;
		next._errorFormatter = this._errorFormatter;
		next._errorI18n = this._errorI18n;
		next._logger = this._logger;
		next._outputValidation = this._outputValidation;
		next._stripPrefix = this._stripPrefix;
		next._trailingSlash = this._trailingSlash;
		next._wsAdapter = this._wsAdapter;
		next._onError = this._onError;
		next._onNotFound = this._onNotFound;
		next._onMethodNotAllowed = this._onMethodNotAllowed;
		next._taps = this._taps;
		next._telemetry = this._telemetry;
		next._realtimeBus = this._realtimeBus;
		next._realtimeRoutes = this._realtimeRoutes;
		return next;
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
		>;
	}

	use<TAdds>(
		mw: MiddlewareFn<TCtx, TAdds>,
	): Honey<TEnv, TCtx & TAdds, TRoutes, TMeta, TErrorFactory, TDefaultErrors, TBasePath, TTaps, TScopedMw>;

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
	>;

	/* oxlint-disable-next-line typescript/no-explicit-any -- overload impl requires erased types */
	use(pathOrMw: string | MiddlewareFn<any, any>, maybeMw?: MiddlewareFn<any, any>): any {
		if (typeof pathOrMw !== "string") {
			const mw = pathOrMw as RuntimeMiddleware;
			const newChain = new Honey<TEnv>({
				chainMiddlewares: [...this._chainMiddlewares, mw],
				defaultErrorKeys: this._defaultErrorKeys,
				globalMiddlewares: this._globalMiddlewares,
				handlerMap: this._handlerMap,
				root: this._root,
				scopedMiddlewares: this._scopedMiddlewares,
			});
			newChain._basePath = this._basePath;
			newChain._chainMeta = this._chainMeta;
			newChain._contextValues = this._contextValues;
			newChain._defaultBoundaryKey = this._defaultBoundaryKey;
			newChain._errorFactory = this._errorFactory;
			newChain._errorSchema = this._errorSchema;
			newChain._customErrorFormatter = this._customErrorFormatter;
			newChain._customErrorSchema = this._customErrorSchema;
			newChain._errorFormatter = this._errorFormatter;
			newChain._errorI18n = this._errorI18n;
			newChain._logger = this._logger;
			newChain._outputValidation = this._outputValidation;
			newChain._stripPrefix = this._stripPrefix;
			newChain._trailingSlash = this._trailingSlash;
			newChain._wsAdapter = this._wsAdapter;
			newChain._onError = this._onError;
			newChain._onNotFound = this._onNotFound;
			newChain._onMethodNotAllowed = this._onMethodNotAllowed;
			newChain._taps = this._taps;
			newChain._telemetry = this._telemetry;
			newChain._realtimeBus = this._realtimeBus;
			newChain._realtimeRoutes = this._realtimeRoutes;
			return newChain;
		}

		/* scoped path */
		const normalizedPrefix = normalizeScopePath(pathOrMw);
		const fullPrefix = mergePath(this._basePath, normalizedPrefix);
		const mw = maybeMw as RuntimeMiddleware;
		const mwWithErrors = maybeMw as MiddlewareFn<unknown, unknown>;
		const entry: ScopedEntry = {
			errors: mwWithErrors.errors ? [...mwWithErrors.errors] : undefined,
			mw,
			prefix: fullPrefix,
		};
		const newChain = new Honey<TEnv>({
			chainMiddlewares: this._chainMiddlewares,
			defaultErrorKeys: this._defaultErrorKeys,
			globalMiddlewares: this._globalMiddlewares,
			handlerMap: this._handlerMap,
			root: this._root,
			scopedMiddlewares: [...this._scopedMiddlewares, entry],
		});
		newChain._basePath = this._basePath;
		newChain._chainMeta = this._chainMeta;
		newChain._contextValues = this._contextValues;
		newChain._defaultBoundaryKey = this._defaultBoundaryKey;
		newChain._errorFactory = this._errorFactory;
		newChain._errorSchema = this._errorSchema;
		newChain._customErrorFormatter = this._customErrorFormatter;
		newChain._customErrorSchema = this._customErrorSchema;
		newChain._errorFormatter = this._errorFormatter;
		newChain._errorI18n = this._errorI18n;
		newChain._logger = this._logger;
		newChain._outputValidation = this._outputValidation;
		newChain._stripPrefix = this._stripPrefix;
		newChain._trailingSlash = this._trailingSlash;
		newChain._wsAdapter = this._wsAdapter;
		newChain._onError = this._onError;
		newChain._onNotFound = this._onNotFound;
		newChain._onMethodNotAllowed = this._onMethodNotAllowed;
		newChain._taps = this._taps;
		newChain._telemetry = this._telemetry;
		newChain._realtimeBus = this._realtimeBus;
		newChain._realtimeRoutes = this._realtimeRoutes;
		newChain._applyScopedEntryErrors(entry);
		return newChain;
	}

	route<
		TSubRoutes,
		TSubMeta,
		TSubErrorFactory,
		TSubDefaultErrors extends string,
		TSubBasePath extends string,
	>(
		sub: Honey<
			TEnv,
			TCtx,
			TSubRoutes,
			TSubMeta,
			TSubErrorFactory,
			TSubDefaultErrors,
			TSubBasePath
		>,
	): Honey<
		TEnv,
		TCtx,
		TRoutes & TSubRoutes,
		TMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		/* skip self-merge: .handler() already inserted into shared _root */
		if (sub._tree !== this._root) {
			mergeInto(this._root, sub._tree);
			if (sub._hasWsRoutes) this._hasWsRoutes = true;
			/* carry sub's scoped mw entries into parent's runtime list (parent scopes run first) */
			for (const entry of sub._scopedMiddlewares) {
				this._scopedMiddlewares.push(entry);
			}
			/* walk tree and apply all scoped error keys to matching handlers */
			this._applyAllScopedErrors();
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
		>;
	}

	private _registerRoute<
		TPath extends string,
		TMethod extends HttpMethod | "ALL",
	>(
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
		TMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		const fullPath = mergePath(this._basePath, path);
		const errorKeys = new Set(this._defaultErrorKeys);
		for (const entry of this._scopedMiddlewares) {
			if (entry.errors && scopeMatches(entry.prefix, fullPath)) {
				for (const k of entry.errors) errorKeys.add(k);
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
			TMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>({
			boundaryErrorKey: this._defaultBoundaryKey,
			errorKeys,
			extraMethods: extraMethods ?? null,
			handlerMap: this._handlerMap,
			inputSchemas: null,
			meta: this._chainMeta ? { ...this._chainMeta } : null,
			method,
			middlewares: [],
			outputSchemas: null,
			parent: this,
			parentMiddlewares: this._chainMiddlewares,
			path: fullPath,
			root: this._root,
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
			TMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>;
	}

		on<
			const TPath extends string,
			const TMethods extends readonly [HttpMethod | "ALL", ...(HttpMethod | "ALL")[]],
		>(
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
		TMeta,
		TErrorFactory,
		TDefaultErrors,
		TBasePath,
		TTaps,
		TScopedMw
	> {
		const [first, ...rest] = methods;
		return this._registerRoute<TPath, TMethods[number]>(
			first,
			path,
			rest.length > 0 ? (rest as (HttpMethod | "ALL")[]) : undefined,
		);
	}

	all<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "ALL">("ALL", path);
	}
	delete<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "DELETE">("DELETE", path);
	}
	get<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "GET">("GET", path);
	}
	head<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "HEAD">("HEAD", path);
	}
	options<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "OPTIONS">("OPTIONS", path);
	}
	patch<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "PATCH">("PATCH", path);
	}
	post<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "POST">("POST", path);
	}
	put<const TPath extends string>(path: TPath) {
		return this._registerRoute<TPath, "PUT">("PUT", path);
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
			Honey<
				TEnv,
				TCtx,
				TRoutes,
				TMeta,
				TErrorFactory,
				TDefaultErrors,
				TBasePath,
				TTaps,
				TScopedMw
			>
		>({
			boundaryErrorKey: this._defaultBoundaryKey,
			errorKeys: new Set(),
			inputSchemas: null,
			meta: null,
			middlewares: [],
			parent: this,
			parentMiddlewares: this._chainMiddlewares,
			path: mergePath(this._basePath, path),
			root: this._root,
		});
	}

	realtime(path: string, opts: RealtimeRouteOpts): this {
		const fullPath = mergePath(this._basePath, path) || "/";

		if (!this._realtimeBus) {
			this._realtimeBus = createBus();
		}

		if (this._realtimeRoutes.has(fullPath)) {
			throw new Error(`Duplicate realtime route: ${fullPath}`);
		}

		this._realtimeRoutes.set(fullPath, {
			handler: opts.handler,
			middlewares: opts.use,
			reconnectBuffer: opts.reconnectBuffer,
		});

		const mw: RuntimeMiddleware[] = [];
		if (opts.use) {
			for (const fn of opts.use) {
				mw.push(fn as RuntimeMiddleware);
			}
		}

		insertWsRoute(this._root, fullPath, {
			bek: this._defaultBoundaryKey,
			ek: new Set(),
			fn: Object.create(null),
			iv: null,
			mt: null,
			mw: [...this._chainMiddlewares, ...mw],
			rp: fullPath,
		});

		this._hasWsRoutes = true;
		return this;
	}

	/* oxlint-disable-next-line require-await -- Workers runtime expects async fetch */
	async fetch(
		request: Request,
		env: TEnv,
		executionCtx?: { waitUntil?: (p: Promise<unknown>) => void },
	): Promise<Response> {
		const startTime = performance.now();

		/* fast path extraction — avoids expensive new URL() allocation */
		const rawUrl = request.url;
		const protoEnd = rawUrl.indexOf("//");
		const pathStart = protoEnd === -1 ? 0 : rawUrl.indexOf("/", protoEnd + 2);
		const searchOrHash =
			pathStart === -1 ? -1 : findSearchOrHash(rawUrl, pathStart);
		let path: string;
		if (pathStart === -1) {
			path = "/";
		} else if (searchOrHash === -1) {
			path = rawUrl.substring(pathStart);
		} else {
			path = rawUrl.substring(pathStart, searchOrHash);
		}

		/* lazily create URL only when actually needed (search params, redirects) */
		let _url: URL | undefined;
		const getUrl = (): URL => {
			if (_url === undefined) _url = new URL(rawUrl);
			return _url;
		};

		const log = this._logger ?? undefined;
		const fc: FetchCtx<TEnv> = {
			env,
			executionCtx,
			log,
			request,
			startTime,
			url: getUrl,
		};

		safeFire(() => this._telemetry?.onRequest?.({ env, req: request }), log);

		/* trailing slash handling */
		if (path.length > 1) {
			if (this._trailingSlash === "strip" && path.endsWith("/")) {
				const redirectUrl = getUrl();
				redirectUrl.pathname = path.slice(0, -1);
				return new Response(null, {
					headers: { location: redirectUrl.toString() },
					status: 308,
				});
			}
			if (this._trailingSlash === "enforce" && !path.endsWith("/")) {
				const redirectUrl = getUrl();
				redirectUrl.pathname = `${path}/`;
				return new Response(null, {
					headers: { location: redirectUrl.toString() },
					status: 308,
				});
			}
		}

		/* prefix stripping — must run AFTER trailing slash so redirects preserve the full prefixed URL */
		if (this._stripPrefix !== null) {
			if (path === this._stripPrefix) {
				path = "/";
			} else if (
				path.startsWith(this._stripPrefix) &&
				path.charCodeAt(this._stripPrefix.length) === 47
			) {
				path = path.slice(this._stripPrefix.length);
			}
		}

		/* WebSocket route check */
		const isWsUpgrade = request.headers.get("upgrade") === "websocket";
		if (isWsUpgrade) {
			const wsMatch = matchWsRoute(this._root, path);
			if (wsMatch !== null) {
				return this._handleWs(fc, wsMatch);
			}
		} else if (this._realtimeRoutes.size > 0) {
			/* Non-upgrade request hitting a realtime-only path → 426 Upgrade Required */
			const wsMatch = matchWsRoute(this._root, path);
			if (wsMatch !== null && this._realtimeRoutes.has(wsMatch.handler.rp)) {
				return new Response(null, { headers: { upgrade: "websocket" }, status: 426 });
			}
		}

		const method = request.method.toUpperCase() as HttpMethod;

		/* fn:null fallthrough — tree match sets meta, catch-all dispatches */
		let fnNullMeta: Record<string, unknown> | null = null;
		let fnNullParams: Record<string, string> | null = null;
		let fnNullHit = false;

		/* Tier 2: O(1) static route lookup — checks both precompiled and runtime maps */
		const smap = this._staticRoutes ?? this._handlerMap;
		if (smap !== null) {
			const key = `${method} ${path}`;
			const staticHandler = smap[key];
			if (staticHandler) {
				if (staticHandler.fn === null) {
					fnNullMeta = staticHandler.mt;
					fnNullParams = Object.create(null) as Record<string, string>;
					fnNullHit = true;
				} else {
					return this._handleMatched(
						fc,
						method,
						path,
						staticHandler,
						Object.create(null),
					);
				}
			}
			/* HEAD falls back to GET */
			if (!fnNullHit && method === "HEAD") {
				const getHandler = smap[`GET ${path}`];
				if (getHandler) {
					if (getHandler.fn === null) {
						fnNullMeta = getHandler.mt;
						fnNullParams = Object.create(null) as Record<string, string>;
						fnNullHit = true;
					} else {
						return this._handleMatched(
							fc,
							method,
							path,
							getHandler,
							Object.create(null),
						);
					}
				}
			}
		}

		if (!fnNullHit) {
			const result = matchRoute(this._root, method, path);

			if (result?.matched) {
				/*
				 * routeTree loaded → wildcard matches for unknown paths must 404.
				 * Only fn:null fallthroughs (known routes) should reach the catch-all.
				 * Detect wildcard: handler has no mt and fn is NOT null (builder-registered catch-all).
				 */
				const isWildcardCatchAll =
					this._hasRouteTree &&
					this._root.w !== null &&
					result.handler.fn !== null &&
					(this._root.w.m[method] === result.handler ||
						this._root.w.m["ALL"] === result.handler);

				if (isWildcardCatchAll) {
					/* path not in routeTree — 404 */
					return this._handle404(fc, method, path);
				}

				if (result.handler.fn === null) {
					fnNullMeta = result.handler.mt;
					fnNullParams = result.params;
					fnNullHit = true;
				} else {
					return this._handleMatched(
						fc,
						method,
						path,
						result.handler,
						result.params,
					);
				}
			}

			if (!fnNullHit) {
				if (result === null) {
					if (!isWsUpgrade) {
						const wsMatch = matchWsRoute(this._root, path);
						if (wsMatch !== null) {
							return new Response("Upgrade Required", {
								headers: { connection: "Upgrade", upgrade: "websocket" },
								status: 426,
							});
						}
					}
					return this._handle404(fc, method, path);
				}

				if (!result.matched) {
					return this._handle405(fc, method, path, result.allowed);
				}
			}
		}

		/* fn:null hit — find catch-all/wildcard to dispatch with stashed meta */
		const wildcardResult = matchRoute(this._root, method, "/*");
		if (wildcardResult?.matched && wildcardResult.handler.fn !== null) {
			return this._handleMatched(
				fc,
				method,
				path,
				wildcardResult.handler,
				fnNullParams ?? Object.create(null),
				fnNullMeta,
			);
		}

		return this._handle404(fc, method, path);
	}

	private _makeErrorCtx(fc: FetchCtx<TEnv>, allowed?: string[]) {
		return {
			env: fc.env,
			jsonFromError: (err: HoneyError) =>
				createErrorResponse(err, this._errorFormatter, this._customErrorFormatter),
			req: fc.request,
			...(allowed ? { allowed } : {}),
		};
	}

	private async _handleWs(
		fc: FetchCtx<TEnv>,
		wsMatch: { handler: WSRouteHandler; params: Record<string, string> },
	): Promise<Response> {
		/* Dispatch to realtime handler if this path is registered as a realtime route */
		const realtimeConfig = this._realtimeRoutes.get(wsMatch.handler.rp);
		if (realtimeConfig) {
			return this._handleRealtime(fc, wsMatch, realtimeConfig);
		}

		const isUpgrade =
			fc.request.headers.get("upgrade")?.toLowerCase() === "websocket";
		if (!isUpgrade) {
			return new Response(null, {
				headers: { upgrade: "websocket" },
				status: 426,
			});
		}

		const wsAdapter = this._wsAdapter;
		if (!wsAdapter) {
			fc.log?.warn?.("WebSocket adapter not configured — call .wsAdapter()");
			return createErrorResponse(
				this._createError(EK.internal_server_error, SK.internal_server_error),
				this._errorFormatter,
				this._customErrorFormatter,
			);
		}

		const wsCtx = new HoneyContext({
			env: fc.env,
			executionCtx: fc.executionCtx,
			params: wsMatch.params,
			req: fc.request,
			urlFn: fc.url,
		});
		if (this._contextValues) Object.assign(wsCtx, this._contextValues);

		/*
		 * WS ordering: [global → scoped → chain+handler-route-specific]
		 * WS bakes chain mw into handler.mw at registration, so scoped runs before chain.
		 * This is an unavoidable inconsistency vs HTTP (where chain runs before scoped).
		 */
		const scopedForPath = this._filterScopedForPath(wsMatch.handler.rp);
		const allWsMw: RuntimeMiddleware[] = [
			...this._globalMiddlewares,
			...scopedForPath,
			...wsMatch.handler.mw,
		];

		try {
			return await executeChain(allWsMw, wsCtx, async (finalCtx) => {
				const userHandler = wsMatch.handler.fn;
				let messageQueue: Promise<void> = Promise.resolve();

				const onOpenFn = userHandler.onOpen;
				const onMsgFn = userHandler.onMessage;
				const onCloseFn = userHandler.onClose;
				const onErrorFn = userHandler.onError;
				const onReconnectFn = userHandler.onReconnect;
				const reconnectToken = fc.url().searchParams.get("reconnect_token");

				const wrappedHandler: WSHandler<unknown> = {};

				if (reconnectToken && onReconnectFn) {
					wrappedHandler.onOpen = (_ctx, ws) => {
						onReconnectFn(finalCtx, ws, reconnectToken);
					};
				} else if (onOpenFn) {
					wrappedHandler.onOpen = (_ctx, ws) => {
						onOpenFn(finalCtx, ws);
					};
				}

				if (onMsgFn) {
					wrappedHandler.onMessage = (_ctx, ws, data) => {
						messageQueue = messageQueue
							.then(() => onMsgFn(finalCtx, ws, data))
							.catch((err: unknown) => {
								onErrorFn?.(finalCtx, ws, err);
							});
					};
				}

				if (onCloseFn) {
					wrappedHandler.onClose = (_ctx, ws, code, reason) => {
						onCloseFn(finalCtx, ws, code, reason);
					};
				}

				if (onErrorFn) {
					wrappedHandler.onError = (_ctx, ws, error) => {
						onErrorFn(finalCtx, ws, error);
					};
				}

				const upgradeResult = await wsAdapter.upgrade(
					fc.request,
					fc.env,
					wrappedHandler,
				);
				return upgradeResult.response;
			});
		} catch (thrown) {
			return this._toErrorResponse(thrown);
		}
	}

	private async _handleRealtime(
		fc: FetchCtx<TEnv>,
		wsMatch: { handler: WSRouteHandler; params: Record<string, string> },
		config: { handler: RealtimeRouteOpts["handler"]; middlewares?: RealtimeRouteOpts["use"]; reconnectBuffer?: number },
	): Promise<Response> {
		const isUpgrade =
			fc.request.headers.get("upgrade")?.toLowerCase() === "websocket";
		if (!isUpgrade) {
			return new Response(null, {
				headers: { upgrade: "websocket" },
				status: 426,
			});
		}

		const wsAdapter = this._wsAdapter;
		if (!wsAdapter) {
			fc.log?.warn?.("WebSocket adapter not configured — call .wsAdapter()");
			return createErrorResponse(
				this._createError(EK.internal_server_error, SK.internal_server_error),
				this._errorFormatter,
				this._customErrorFormatter,
			);
		}

		/* Lazily create bus if not yet initialized (happens when realtime() was called on a child chain) */
		if (!this._realtimeBus) {
			this._realtimeBus = createBus();
		}
		const bus = this._realtimeBus;

		const ctx = new HoneyContext({
			env: fc.env,
			executionCtx: fc.executionCtx,
			params: wsMatch.params,
			req: fc.request,
			urlFn: fc.url,
		});
		if (this._contextValues) Object.assign(ctx, this._contextValues);
		Object.assign(ctx, {
			realtime: { publish: (topic: string, data: unknown) => bus.publish(topic, data) },
		});

		const scopedForPath = this._filterScopedForPath(wsMatch.handler.rp);
		const allMw: RuntimeMiddleware[] = [
			...this._globalMiddlewares,
			...scopedForPath,
			...wsMatch.handler.mw,
		];

		try {
			return await executeChain(allMw, ctx, async (finalCtx) => {
				const connId = crypto.randomUUID();

				let socket: WSContext<unknown> | null = null;
				let conn: ReturnType<typeof createConnContext> | null = null;

				/*
				 * initConn creates the ConnContext and calls the user handler.
				 * Called from onOpen (for Bun where socket arrives later)
				 * or inline after upgrade (for Node/CF where socket is immediate).
				 */
				const initConn = (ws: WSContext<unknown>) => {
					socket = ws;
					conn = createConnContext({
						bus,
						closeFn: (reason) => {
							if (socket) socket.close(1000, reason);
						},
						id: connId,
						sendFn: (payload) => {
							if (socket) socket.send(typeof payload === "object" && payload !== null ? JSON.stringify(payload) : String(payload));
						},
						transport: "ws",
						userId: null,
					});

					bus.onMessage(connId, (data) => {
						if (socket) {
							socket.send(typeof data === "object" && data !== null ? JSON.stringify(data) : String(data));
						}
					});

					config.handler(finalCtx, conn);
				};

				const wrappedHandler: WSHandler<unknown> = {
					onClose: (_ctx, _ws, _code, reason) => {
						if (!conn) return;
						const handlers = conn._handlers;
						if (handlers.close) {
							handlers.close(reason || "normal");
						}
						bus.unsubscribeAll(connId);
						bus.removeHandler(connId);
					},
					onMessage: (_ctx, _ws, data) => {
						if (!conn) return;
						const handlers = conn._handlers;
						if (handlers.message && typeof data === "string") {
							try {
								const parsed: unknown = JSON.parse(data);
								if (isMsgFrame(parsed)) {
									handlers.message(parsed.data);
								}
							} catch { /* ignore malformed frames */ }
						}
					},
					onOpen: (_ctx, ws) => {
						if (!socket) initConn(ws);
					},
				};

				const upgradeResult = await wsAdapter.upgrade(fc.request, fc.env, wrappedHandler);

				/* Node/CF adapters return the socket from upgrade(); Bun returns undefined (socket comes via onOpen) */
				if (upgradeResult.socket && !socket) {
					initConn(upgradeResult.socket);
				}

				return upgradeResult.response;
			});
		} catch (thrown) {
			return this._toErrorResponse(thrown);
		}
	}

	private async _handle404(
		fc: FetchCtx<TEnv>,
		method: string,
		path: string,
	): Promise<Response> {
		safeFire(
			() => this._telemetry?.onNotFound?.({ method, path, req: fc.request }),
			fc.log,
		);
		const make404 = () => {
			if (this._onNotFound) {
				return this._onNotFound(this._makeErrorCtx(fc));
			}
			return this._makeErrorCtx(fc).jsonFromError(
				this._createError(EK.not_found, SK.not_found),
			);
		};
		try {
			const ctx404 = new HoneyContext({
				env: fc.env,
				executionCtx: fc.executionCtx,
				params: {},
				req: fc.request,
				urlFn: fc.url,
			});
			if (this._contextValues) Object.assign(ctx404, this._contextValues);
			const res =
				this._chainMiddlewares.length > 0
					? await executeChain(this._chainMiddlewares, ctx404, make404)
					: await make404();
			safeFire(
				() =>
					this._telemetry?.onResponse?.({
						duration: performance.now() - fc.startTime,
						req: fc.request,
						status: res.status,
					}),
				fc.log,
			);
			return res;
		} catch (thrown) {
			return this._toErrorResponse(thrown);
		}
	}

	private async _handle405(
		fc: FetchCtx<TEnv>,
		method: string,
		path: string,
		allowed: string[],
	): Promise<Response> {
		safeFire(
			() =>
				this._telemetry?.onMethodNotAllowed?.({
					allowed,
					method,
					path,
					req: fc.request,
				}),
			fc.log,
		);
		const make405 = async () => {
			if (this._onMethodNotAllowed) {
				const res = await this._onMethodNotAllowed(
					this._makeErrorCtx(fc, allowed) as {
						allowed: string[];
						env: TEnv;
						jsonFromError: (err: HoneyError) => Response;
						req: Request;
					},
				);
				const responseHeaders = new Headers(res.headers);
				responseHeaders.set("allow", allowed.join(", "));
				return new Response(res.body, {
					headers: responseHeaders,
					status: res.status,
				});
			}
			const err = this._createError(
				EK.method_not_allowed,
				SK.method_not_allowed,
			);
			const res = this._makeErrorCtx(fc).jsonFromError(err);
			const responseHeaders = new Headers(res.headers);
			responseHeaders.set("allow", allowed.join(", "));
			return new Response(res.body, {
				headers: responseHeaders,
				status: res.status,
			});
		};
		try {
			const ctx405 = new HoneyContext({
				env: fc.env,
				executionCtx: fc.executionCtx,
				params: {},
				req: fc.request,
				urlFn: fc.url,
			});
			if (this._contextValues) Object.assign(ctx405, this._contextValues);
			const finalRes =
				this._chainMiddlewares.length > 0
					? await executeChain(this._chainMiddlewares, ctx405, make405)
					: await make405();
			safeFire(
				() =>
					this._telemetry?.onResponse?.({
						duration: performance.now() - fc.startTime,
						req: fc.request,
						status: finalRes.status,
					}),
				fc.log,
			);
			return finalRes;
		} catch (thrown) {
			return this._toErrorResponse(thrown);
		}
	}

	private async _handleMatched(
		fc: FetchCtx<TEnv>,
		method: HttpMethod,
		path: string,
		handler: RouteHandler,
		params: Record<string, string>,
		stashedMeta?: Record<string, unknown> | null,
	): Promise<Response> {
		const { env, executionCtx, log, request, startTime } = fc;

		/* resolve error factory — pre-computed ef preferred, else build/use global */
		let errors: Record<string, (...args: never[]) => unknown> | undefined;
		if (handler.ef !== null) {
			errors = handler.ef;
		} else if (this._errorFactory !== null) {
			if (handler.ek.size > 0) {
				const factory = this._errorFactory as Record<
					string,
					(...args: never[]) => unknown
				>;
				const subset = Object.create(null) as Record<string, unknown>;
				for (const key of handler.ek) {
					if (key in factory) {
						subset[key] = factory[key];
					}
				}
				errors = Object.freeze(subset) as Record<
					string,
					(...args: never[]) => unknown
				>;
			} else {
				errors = this._errorFactory as Record<
					string,
					(...args: never[]) => unknown
				>;
			}
		}

		/* meta: stashed meta from fn:null tree match takes priority over handler meta */
		const resolvedMeta = stashedMeta ?? handler.mt;

		const ctx = new HoneyContext({
			env,
			executionCtx,
			meta: resolvedMeta ? Object.freeze(resolvedMeta) : undefined,
			params,
			path,
			req: request,
			routePattern: handler.rp,
			urlFn: fc.url,
		});
		if (this._contextValues) Object.assign(ctx, this._contextValues);
		if (this._realtimeBus) {
			const rtBus = this._realtimeBus;
			Object.assign(ctx, {
				realtime: { publish: (topic: string, data: unknown) => rtBus.publish(topic, data) },
			});
		}
		if (errors) {
			ctx._setErrors(errors);
		}

		if (this._telemetry !== null) {
			try {
				this._telemetry.onRoute?.({ method, params, path, req: request });
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
		const hasTelemetryMw = this._telemetry?.onMiddleware !== undefined;
		const hasInputValidation = handler.iv !== null;
		const scopedForPath = this._filterScopedForPath(handler.rp);

		/*
		 * Error resolver — stored on ctx so the cached handler wrapper can read it.
		 * Converts handler errors into error Responses inside the middleware chain,
		 * allowing all post-next() middleware code (headers, logging, timing) to run.
		 */
		ctx._errorToResponse = (thrown: unknown) =>
			this._resolveErrorResponse(thrown, handler, fc, method, path, ctx);

		try {
			let response: Response;

			if (!hasTelemetryMw && !hasInputValidation && scopedForPath.length === 0) {
				/* fast path: use pre-compiled chain when possible */
				const chainMw = this._chainMiddlewares;
				const handlerHasChain =
					chainMw.length > 0 && chainMw.every((mw, i) => handler.mw[i] === mw);
				const allMw = handlerHasChain
					? [...this._globalMiddlewares, ...handler.mw]
					: [...this._globalMiddlewares, ...chainMw, ...handler.mw];

				if (!handler._compiled) {
					handler._compiled = compileChain(allMw, (c) => {
						try {
							const result = handler.fn(c);
							if (result instanceof Promise) {
								return result.catch((thrown: unknown) => {
									const hCtx = c as HoneyContext<TEnv>;
									if (hCtx._errorToResponse)
										return hCtx._errorToResponse(thrown);
									throw thrown;
								});
							}
							return result;
						} catch (thrown) {
							const hCtx = c as HoneyContext<TEnv>;
							if (hCtx._errorToResponse) return hCtx._errorToResponse(thrown);
							throw thrown;
						}
					});
				}
				const result = handler._compiled(ctx);
				response = result instanceof Promise ? await result : result;
			} else {
				/* slow path: dynamic assembly for telemetry/validation/scoped-mw */
				const chainMw = this._chainMiddlewares;
				const handlerHasChain =
					chainMw.length > 0 && chainMw.every((mw, i) => handler.mw[i] === mw);
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
					: [...this._globalMiddlewares, ...chainMw, ...scopedForPath, ...handler.mw];

				if (hasTelemetryMw) {
					const onMw = this._telemetry?.onMiddleware;
					if (onMw) {
						allMiddlewares = allMiddlewares.map((mw) => {
							const name = mw.name || "anonymous";
							const wrapped: RuntimeMiddleware = async (wCtx, wNext) => {
								const mwStart = performance.now();
								try {
									const res = await mw(wCtx, wNext);
									safeFire(
										() => onMw({ duration: performance.now() - mwStart, name }),
										log,
									);
									return res;
								} catch (error) {
									safeFire(
										() =>
											onMw({
												duration: performance.now() - mwStart,
												error,
												name,
											}),
										log,
									);
									throw error;
								}
							};
							return wrapped;
						});
					}
				}

				if (hasInputValidation) {
					const schemas = handler.iv;
					if (schemas) {
						const inputMw: RuntimeMiddleware = async (inputCtx, inputNext) => {
								const validated = await validateInput(
									schemas,
									inputCtx["req"] as Request,
									params,
								);
							return inputNext({ input: validated });
						};
						allMiddlewares.push(inputMw);
					}
				}

				response = await executeChain(allMiddlewares, ctx, (finalCtx) => {
					try {
						const result = handler.fn(finalCtx);
						if (result instanceof Promise) {
							return result.catch((thrown: unknown) => {
								const hCtx = finalCtx as HoneyContext<TEnv>;
								if (hCtx._errorToResponse) return hCtx._errorToResponse(thrown);
								throw thrown;
							});
						}
						return result;
					} catch (thrown) {
						const hCtx = finalCtx as HoneyContext<TEnv>;
						if (hCtx._errorToResponse) return hCtx._errorToResponse(thrown);
						throw thrown;
					}
				});
			}

			/* output validation — skip for error responses and when no body (204, 304, etc) */
			if (
				handler.os &&
				this._outputValidation !== "off" &&
				response.body !== null &&
				!ctx._isErrorResponse
			) {
				const ct = response.headers.get("content-type");

				/* content-type mismatch check */
				if (ct) {
					const declaredTypes = Object.keys(handler.os);
					const matches = declaredTypes.some((t) => ct.startsWith(t));
					if (!matches) {
						throw new HoneyError({
							errorKey: EK.output_content_type_mismatch,
							status: SK.internal_server_error,
						});
					}
				}

				/* JSON schema validation — read original, return clone (Bun clone() drains original) */
				if (ct?.startsWith("application/json") && handler.ov) {
					const sk = codeToStatusKey[response.status];
					if (sk) {
						const forReturn = response.clone();
						const data: unknown = await response.json();
						await handler.ov(sk, data);
						response = forReturn;
					}
				}
			}

			/* taps — fire after successful handler, non-blocking */
			if (this._taps !== null && !ctx._isErrorResponse) {
				const taps = this._taps;
				const log = fc.log;

				/* meta-driven taps — fire for each registered key found in route meta */
				if (handler.mt !== null) {
					for (const [key, tapFn] of taps) {
						const metaValue = handler.mt[key];
						if (metaValue !== undefined) {
							ctx.background(
								Promise.resolve()
									.then(() => tapFn(ctx, metaValue))
									.catch((e) => log?.warn?.("tap failed", key, e)),
							);
						}
					}
				}

				/* dynamic taps — fire for each c.tap() call */
				if (ctx._pendingTaps !== null) {
					for (const pending of ctx._pendingTaps) {
						const tapFn = taps.get(pending.key);
						if (tapFn !== undefined) {
							ctx.background(
								Promise.resolve()
									.then(() => tapFn(ctx, pending.payload))
									.catch((e) => log?.warn?.("tap failed", pending.key, e)),
							);
						}
					}
					ctx._pendingTaps = null;
				}
			}

			if (this._telemetry !== null) {
				try {
					const duration = performance.now() - startTime;
					this._telemetry.onHandler?.({
						duration,
						method,
						path,
						status: response.status,
					});
					this._telemetry.onResponse?.({
						duration,
						req: request,
						status: response.status,
					});
				} catch {
					/* telemetry must never crash the response path */
				}
			}
			/* HEAD responses must have empty body — preserve headers + status */
			if (method === "HEAD") {
				return new Response(null, {
					headers: response.headers,
					status: response.status,
				});
			}
			return response;
		} catch (thrown) {
			/* safety net — middleware-level errors (input validation, middleware crash) */
			if (ctx._errorToResponse) return ctx._errorToResponse(thrown);
			return this._toErrorResponse(thrown);
		}
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
type ResolveBody<T, TBody> = TBody extends "infer"
	? T extends StandardSchemaLike
		? InferOutput<T>
		: T
	: TBody;

type NarrowMethod<
	TRes,
	TSchemas,
	Method extends string,
	CT extends string,
	TBody,
> = [TSchemas] extends [never]
	? Omit<TRes, Method>
	: TSchemas extends Record<string, unknown>
		? Omit<TRes, Method> & {
				[M in Method]: <K extends keyof TSchemas & string>(
					statusKey: K,
					body: ResolveBody<TSchemas[K], TBody>,
					opts?: ResponseOptions,
				) => TypedResponse<CT, K>;
			}
		: Omit<TRes, Method>;

/**
 * SSE uses a callback signature, not statusKey+body like other methods.
 * Gate presence on text/event-stream declaration, preserve original signature.
 */
type NarrowSSE<TOutput> = [
	ExtractSchemas<TOutput, "text/event-stream">,
] extends [never]
	? {}
	: { sse: HoneyRes["sse"] };

/** Universal methods — always available, not gated by output declaration */
type UniversalRes = Pick<HoneyRes, "noContent" | "raw" | "redirect" | "stream">;

/**
 * Constrain ctx.res when output schemas are declared.
 * Declared content types → method constrained (status keys + body type).
 * Undeclared content types → method removed.
 * Universal methods (noContent, redirect, stream, raw) always available.
 * HoneyContext has no private fields, so Omit preserves structural compatibility.
 */
type ApplyOutput<TCtx, TOutput> = [keyof TOutput] extends [never]
	? TCtx
	: TCtx & {
			readonly res: UniversalRes &
				NarrowMethod<
					{},
					ExtractSchemas<TOutput, "application/json">,
					"json",
					"application/json",
					"infer"
				> &
				NarrowMethod<
					{},
					ExtractSchemas<TOutput, "text/plain">,
					"text",
					"text/plain",
					string
				> &
				NarrowMethod<
					{},
					ExtractSchemas<TOutput, "text/html">,
					"html",
					"text/html",
					string
				> &
				NarrowMethod<
					{},
					ExtractSchemas<TOutput, "application/xml">,
					"xml",
					"application/xml",
					string
				> &
				NarrowMethod<
					{},
					ExtractSchemas<TOutput, "text/csv">,
					"csv",
					"text/csv",
					string
				> &
				NarrowMethod<
					{},
					ExtractSchemas<TOutput, "application/octet-stream">,
					"binary",
					"application/octet-stream",
					ArrayBuffer | Uint8Array<ArrayBuffer>
				> &
				NarrowSSE<TOutput>;
		};

/** Public alias for codegen — applies output schema constraints to a context type */
export type WithOutput<TCtx, TOutput> = ApplyOutput<TCtx, TOutput>;

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
type ApplyScoped<
	TScopedMw extends readonly ScopedMwEntry[],
	TFullPath extends string,
> = TScopedMw extends readonly [
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
	: TCtx;

/** Typed tap method — constrained to registered tap keys when TTaps is non-empty */
type TypedTap<TTaps extends Record<string, unknown>> =
	[keyof TTaps] extends [never]
		? { tap(key: string, payload: unknown): void }
		: { tap<K extends string & keyof TTaps>(key: K, payload: TTaps[K]): void };

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
	ApplyParams<
		[keyof TInput] extends [never] ? TCtx : TCtx & { input: TInput },
		TParams
	> & {
		readonly meta: Readonly<Omit<TAccMeta, "openApi">>;
		readonly routePattern: TPath;
	} & ([TErrorFactory] extends [never]
			? {}
			: [TErrorKeys] extends [never]
				? { readonly errors: TErrorFactory }
				: {
						readonly errors: Pick<
							TErrorFactory,
							TErrorKeys & keyof TErrorFactory
						>;
					})
	& TypedTap<TTaps>,
	TOutput
>;

/** @internal — exposes private Honey members for RouteBuilder/WSRouteBuilder access */
type HoneyInternal = {
	_factory: unknown;
	_markWsRoutes(): void;
	_registerStatic(key: string, handler: RouteHandler): void;
};

type RouteBuilderState<TParent> = {
	boundaryErrorKey: string | null;
	errorKeys: Set<string>;
	extraMethods: (HttpMethod | "ALL")[] | null;
	handlerMap: Record<string, RouteHandler> | null;
	inputSchemas: InputSchemasDef | null;
	meta: Record<string, unknown> | null;
	method: HttpMethod | "ALL";
	middlewares: RuntimeMiddleware[];
	outputSchemas: OutputSchemaDef | null;
	parent: TParent;
	parentMiddlewares: RuntimeMiddleware[];
	path: string;
	root: TreeNode;
};

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
	TAccMeta extends { internal: true }
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
>;

type OneShotKey = "boundary" | "errors" | "input" | "meta" | "output";

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
		TEnv, TCtx, TInput, TErrorKeys, TOutput, TPath, TMethod,
		TRoutes, TUsed, TBaseCtx, TMeta, TAccMeta, TErrorFactory,
		TDefaultErrors, TBasePath, TTaps, TScopedMw
	>,
	TUsed & OneShotKey
>;

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
		Honey<
			TEnv,
			TBaseCtx,
			TRoutes,
			TMeta,
			TErrorFactory,
			TDefaultErrors,
			TBasePath,
			TTaps,
			TScopedMw
		>
	>;

	constructor(
		state: RouteBuilderState<
			Honey<
				TEnv,
				TBaseCtx,
				TRoutes,
				TMeta,
				TErrorFactory,
				TDefaultErrors,
				TBasePath,
				TTaps,
				TScopedMw
			>
		>,
	) {
		this._s = state;
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
	>;
	errors<
		TKeys extends [TErrorFactory] extends [never]
			? never
			: Exclude<keyof TErrorFactory & string, TDefaultErrors>,
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
	>;
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
		const keys =
			typeof args[0] === "object" && args[0] !== null
				? (args.slice(1) as string[])
				: (args as string[]);
		for (const k of keys) {
			this._s.errorKeys.add(k);
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
		});
	}

	boundary<
		TKey extends [TErrorFactory] extends [never]
			? never
			: Exclude<keyof TErrorFactory & string, TDefaultErrors>,
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
		this._s.boundaryErrorKey = key;
		this._s.errorKeys.add(key);
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
		});
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
		let ov: OutputValidator | null = null;
		const outputSchemas = this._s.outputSchemas;
		if (outputSchemas) {
			const jsonSchemas = outputSchemas["application/json"];
			if (jsonSchemas) {
				ov = async (statusKey: string, data: unknown) => {
					const schema = jsonSchemas[statusKey as keyof typeof jsonSchemas];
					if (schema) {
						await validateOutput(schema, statusKey, data);
					}
				};
			}
		}

		const isInternal = Symbol.for("honey.internal") in fn
		if (isInternal) {
			Object.defineProperty(fn, Symbol.for("honey.app"), { value: this._s.parent })
		}

		const routeHandler: RouteHandler = {
			_skip: isInternal || undefined,
			bek: this._s.boundaryErrorKey,
			ef: null,
			ek: this._s.errorKeys,
			fn: fn as (ctx: unknown) => Response | Promise<Response>,
			iv: this._s.inputSchemas,
			mt: this._s.meta,
			mw: [...this._s.parentMiddlewares, ...this._s.middlewares],
			os: this._s.outputSchemas,
			ov,
			rp: this._s.path,
		};

		/* patch mode: if handler map has this route, patch existing handler instead of insertRoute */
		const handlerMap = this._s.handlerMap;
		if (handlerMap) {
			const key = `${this._s.method} ${this._s.path}`;
			const existing = handlerMap[key];
			if (existing) {
				existing.fn = routeHandler.fn;
				existing.mw = routeHandler.mw;
				existing.iv = routeHandler.iv;
				existing.os = routeHandler.os;
				existing.ov = routeHandler.ov;
				/* pre-compute filtered error factory */
				const factory = (this._s.parent as unknown as HoneyInternal)._factory;
				if (factory !== null && existing.ek.size > 0) {
					const ef = Object.create(null) as Record<
						string,
						(...args: never[]) => unknown
					>;
					const fac = factory as Record<string, (...args: never[]) => unknown>;
						for (const k of existing.ek) {
							const factoryFn = fac[k]
							if (factoryFn !== undefined) {
								ef[k] = factoryFn
							}
						}
					existing.ef = Object.freeze(ef);
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
				>;
			}
		}

		insertRoute(this._s.root, this._s.method, this._s.path, routeHandler);

		/* .on() extra methods — insert same handler for each additional method */
		if (this._s.extraMethods) {
			for (const m of this._s.extraMethods) {
				insertRoute(this._s.root, m, this._s.path, routeHandler);
				if (!this._s.path.includes(":") && !this._s.path.includes("*")) {
					(this._s.parent as unknown as HoneyInternal)._registerStatic(`${m} ${this._s.path}`, routeHandler);
				}
			}
		}

		/* populate static route map for O(1) lookup on non-parameterized routes */
		if (!this._s.path.includes(":") && !this._s.path.includes("*")) {
			(this._s.parent as unknown as HoneyInternal)._registerStatic(
				`${this._s.method} ${this._s.path}`,
				routeHandler,
			);
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
		>;
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
		const proxyHandler = createProxyHandler(config);
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
		);
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
		});
	}

	meta<
		TRouteMeta extends Partial<DefaultMeta> &
			([TMeta] extends [never] ? {} : TMeta),
	>(
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
		});
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
		});
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
				this._s.errorKeys.add(k);
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
		});
	}
}

type WSRouteBuilderState<TParent> = {
	boundaryErrorKey: string | null;
	errorKeys: Set<string>;
	inputSchemas: InputSchemasDef | null;
	meta: Record<string, unknown> | null;
	middlewares: RuntimeMiddleware[];
	parent: TParent;
	parentMiddlewares: RuntimeMiddleware[];
	path: string;
	root: TreeNode;
};

class WSRouteBuilder<
	TEnv,
	TCtx,
	TInput = {},
	_TErrorKeys extends string = never,
	TParent extends { _markWsRoutes(): void } = { _markWsRoutes(): void },
> {
	private _s: WSRouteBuilderState<TParent>;

	constructor(state: WSRouteBuilderState<TParent>) {
		this._s = state;
	}

	errors<TFactory extends Record<string, (...args: never[]) => unknown>>(
		factory: TFactory,
		...keys: Array<keyof TFactory & string>
	): WSRouteBuilder<
		TEnv,
		TCtx,
		TInput,
		_TErrorKeys | (keyof TFactory & string),
		TParent
	> {
		void factory;
		for (const k of keys) {
			this._s.errorKeys.add(k);
		}
		return new WSRouteBuilder<
			TEnv,
			TCtx,
			TInput,
			_TErrorKeys | (keyof TFactory & string),
			TParent
		>({
			...this._s,
			errorKeys: this._s.errorKeys,
		});
	}

	handler(wsHandler: WSHandler<TCtx>): TParent {
		const routeHandler: WSRouteHandler = {
			bek: this._s.boundaryErrorKey,
			ek: this._s.errorKeys,
			fn: wsHandler as WSHandler<unknown>,
			iv: this._s.inputSchemas,
			mt: this._s.meta,
			mw: [...this._s.parentMiddlewares, ...this._s.middlewares],
			rp: this._s.path,
		};
		insertWsRoute(this._s.root, this._s.path, routeHandler);
		;(this._s.parent as unknown as HoneyInternal)._markWsRoutes();
		return this._s.parent;
	}

	input<
		TSchemas extends Pick<InputSchemasDef, "cookies" | "headers" | "search">,
	>(
		schemas: TSchemas,
	): WSRouteBuilder<
		TEnv,
		TCtx,
		TInput & InferInputMap<TSchemas>,
		_TErrorKeys,
		TParent
	> {
		return new WSRouteBuilder<
			TEnv,
			TCtx,
			TInput & InferInputMap<TSchemas>,
			_TErrorKeys,
			TParent
		>({
			...this._s,
			inputSchemas: schemas,
		});
	}

	meta(meta: Record<string, unknown>): this {
		this._s.meta = meta;
		return this;
	}

	use<TAdds>(
		mw: MiddlewareFn<TCtx, TAdds>,
	): WSRouteBuilder<TEnv, TCtx & TAdds, TInput, _TErrorKeys, TParent> {
		if (mw.errors) {
			for (const k of mw.errors) {
				this._s.errorKeys.add(k);
			}
		}
		return new WSRouteBuilder<TEnv, TCtx & TAdds, TInput, _TErrorKeys, TParent>(
			{
				...this._s,
				middlewares: [...this._s.middlewares, mw as RuntimeMiddleware],
			},
		);
	}
}

export function honey<TEnv>(): Honey<TEnv> {
	return new Honey<TEnv>();
}
