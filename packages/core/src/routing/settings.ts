/**
 * App settings: one object per app graph, shared by every handle derived from it (`use()`,
 * `basePath()`, `context()`, `meta()`), so a setter called on any handle applies to all of them.
 * A route keeps the settings of the app it was registered on, so a mounted sub-app's routes keep
 * their own error factory, default errors and boundary. Feature bits add their own fields.
 */
import type { ErrorFormat } from "../errors/problem-json.ts"
import type { MetaSpecSource } from "../meta/meta-spec-merge.ts"
import type { OutputValidationMode } from "../validation/validate-output.ts"
import type { HoneyError } from "../errors/error.ts"
import type { CustomErrorFormatter, ErrorFormatter } from "../errors/projector.ts"
import type { MaybePromise } from "../middleware/middleware.ts"
import type { RequestLogEntry } from "../telemetry/fields.ts"
import { createLogger, type Logger, SILENT } from "../telemetry/logger.ts"
import type { Telemetry } from "../telemetry/request-trace.ts"
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import type { WSAdapter } from "../ws/contract.ts"
import type { TapFn } from "./tap.ts"

/** An app's error factory (`defineErrors`), as its settings hold it. */
export type ErrorFactories = Readonly<Record<string, (...args: never[]) => unknown>>

/** What the error and miss hooks receive. */
export type ErrorCtx<TEnv> = {
	/** The environment bindings of the request. */ env: TEnv
	/** Builds the answer for a `HoneyError`: the app's format and formatters apply, `errorI18n` does not. */ jsonFromError: (
		err: HoneyError,
	) => Response
	/** The incoming request. */ req: Request
}

/** What `resolveLocale` reads the request's locale from. */
export type ResolveLocaleCtx<TEnv> = {
	/** The request's cookies by name. */
	readonly cookies: Readonly<Record<string, string>>
	/** The environment bindings of the request. */
	readonly env: TEnv
	/** The request's headers, with lowercased names. */
	readonly headers: Readonly<Record<string, string>>
	/** The matched route's path params; empty when no route matched. */
	readonly params: Readonly<Record<string, string>>
	/** The incoming request. */
	readonly req: Request
	/** The query: the first value of each key. */
	readonly search: Readonly<Record<string, string>>
}

/** `app.errorI18n`, built by `errorI18n()` from `@lovrozagar/honey/i18n`; `translate` answers a copy. */
export type ErrorI18n<TEnv = unknown> = {
	/** Picks the locale for an error answer. If it throws, the failure is logged and the error goes out untranslated. */
	readonly resolveLocale: (ctx: ResolveLocaleCtx<TEnv>) => MaybePromise<string>
	/**
	 * Returns `error` in `locale`: a copy with its message and field paths translated, or `error` itself when nothing
	 * translates. If it throws, the failure is logged and the error goes out untranslated.
	 */
	translate(error: HoneyError, locale: string): HoneyError
}

/** Map a thrown value: a HoneyError replaces the error, a Response answers, nothing falls through. */
export type OnErrorFn<TEnv> = (
	error: unknown,
	ctx: ErrorCtx<TEnv>,
) => MaybePromise<HoneyError | Response | undefined | void>

/** Answers a request whose path exists but not for its method. Honey adds `Allow` to what it returns. */
export type OnMethodNotAllowedFn<TEnv> = (
	ctx: ErrorCtx<TEnv> & {
		/** The methods the path serves. */ allowed: string[]
	},
) => MaybePromise<Response>

/** Answers a request that matches no route. */
export type OnNotFoundFn<TEnv> = (ctx: ErrorCtx<TEnv>) => MaybePromise<Response>

/** The request log's options: `skip` answers true for a line not to write. */
export type RequestLogOptions = {
	/** Returns `true` to leave a request out of the log. */ readonly skip?: (entry: RequestLogEntry) => boolean
}

/** The configuration one app holds, shared by every handle derived from it. */
export type AppSettings<TEnv = unknown> = {
	/** Shapes the body of an error `defineErrors` gave a payload schema; `null` sends the payload unchanged. */
	customErrorFormatter: CustomErrorFormatter | null
	/** the body schema of schema errors, for the OpenAPI document */
	customErrorSchema: StandardSchemaLike | null
	/** The error key an undeclared or unknown throw becomes on routes without a boundary; `null` for a 500. */
	defaultBoundaryKey: string | null
	/** Error keys every route of the app declares. */
	defaultErrorKeys: Set<string>
	/**
	 * Whether an encoded `/` or `\` in a request path is decoded into a param (`"allow"`) or answered with 400 (`"reject"`, the default).
	 */
	encodedSlashes: "allow" | "reject"
	/** The app's error factory; `null` until `errorFactory()` is called. */
	errorFactory: ErrorFactories | null
	/** Wire format of error answers: honey's envelope (the default) or RFC 9457 Problem Details. */
	errorFormat: ErrorFormat
	/** Shapes the body of every error without a payload schema; the default returns honey's body unchanged. */
	errorFormatter: ErrorFormatter
	/** translates the answer to an unhandled throw and to an onError HoneyError; `null`: off */
	errorI18n: ErrorI18n<TEnv> | null
	/** the body schema of standard errors, for the OpenAPI document */
	errorSchema: StandardSchemaLike | null
	/** where every server-side line goes: the default createLogger(), the app's own, or SILENT */
	logger: Logger
	/** the metaSpec policy this app declared, and each mounted sub-app's: merged when a document is built */
	readonly metaSpec: MetaSpecSource
	/** whether `.output()` routes check what they answer: resolved per route at finalize */
	outputValidation: OutputValidationMode
	/** Hook that maps a thrown value before it is answered; `null` for none. */
	onError: OnErrorFn<TEnv> | null
	/** Hook that answers a 405; `null` keeps the default answer. */
	onMethodNotAllowed: OnMethodNotAllowedFn<TEnv> | null
	/** Hook that answers a 404; `null` keeps the default answer. */
	onNotFound: OnNotFoundFn<TEnv> | null
	/** one info line per request after its body ends; `null`: off */
	requestLog: RequestLogOptions | null
	/** spans per request and the error reporter; `null`: off, at the cost of one check */
	telemetry: Telemetry | null
	/** URL path prefix removed before routing; `null` for none. */
	stripPrefix: string | null
	/** `app.tap()` handlers by key; `null` until one is registered */
	taps: Map<string, TapFn<TEnv>> | null
	/**
	 * How a trailing slash is treated: 308 redirect to the form without it (`"strip"`) or with it (`"enforce"`), or serve both (`"ignore"`, the default).
	 */
	trailingSlash: "enforce" | "ignore" | "strip"
	/** The runtime's WebSocket adapter; `null` until `app.wsAdapter()` or, on Node and Bun, `serve()` sets it. */
	wsAdapter: WSAdapter | null
}

/** The default shape, unchanged. Identity, so finalize can tell a formatter was never set. */
export function defaultErrorFormatter(
	_error: HoneyError,
	defaultShape: Record<string, unknown>,
): Record<string, unknown> {
	return defaultShape
}

export function createSettings<TEnv>(): AppSettings<TEnv> {
	return {
		outputValidation: "off",
		customErrorFormatter: null,
		customErrorSchema: null,
		defaultBoundaryKey: null,
		defaultErrorKeys: new Set(),
		encodedSlashes: "reject",
		errorFactory: null,
		errorFormat: "honey",
		errorFormatter: defaultErrorFormatter,
		errorI18n: null,
		errorSchema: null,
		logger: createLogger(),
		metaSpec: { absorbed: [], declared: null },
		onError: null,
		onMethodNotAllowed: null,
		onNotFound: null,
		requestLog: null,
		telemetry: null,
		stripPrefix: null,
		taps: null,
		trailingSlash: "ignore",
		wsAdapter: null,
	}
}

/** A path prefix as stripped: leading slash, no trailing slash; `null` for none. */
export function normalizeStripPrefix(prefix: string): string | null {
	let normalized = prefix.replace(/\/+$/, "")
	if (normalized.length > 0 && !normalized.startsWith("/")) normalized = `/${normalized}`
	return normalized === "" ? null : normalized
}

/** Settings that cannot work together, refused before the first request is served. */
export function assertSettingsAgree(s: AppSettings<unknown>): void {
	if (s.requestLog !== null && s.logger === SILENT) {
		throw new Error("honey: requestLog() is on, but logger(false) writes nothing: set a logger, or turn requestLog off")
	}
}
