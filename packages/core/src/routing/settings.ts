/**
 * App settings: one object per app graph, shared by every handle derived from it (`use()`,
 * `basePath()`, `context()`, `meta()`), so a setter called on any handle applies to all of them.
 * A route keeps the settings of the app it was registered on, so a mounted sub-app's routes keep
 * their own error factory, default errors and boundary. Feature bits add their own fields.
 */
import type { ErrorFormat } from "../errors/problem-json.ts"
import type { OutputValidationMode } from "../validation/validate-output.ts"
import type { HoneyError } from "../errors/error.ts"
import type { CustomErrorFormatter, ErrorFormatter } from "../errors/projector.ts"
import type { MaybePromise } from "../middleware/middleware.ts"
import type { RequestLogEntry } from "../telemetry/fields.ts"
import { createLogger, type Logger, SILENT } from "../telemetry/logger.ts"
import type { Telemetry } from "../telemetry/request-trace.ts"
import type { InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"
import type { WSAdapter } from "../ws/contract.ts"
import type { WithTaps } from "./app-types.ts"
import type { TapFn, TapHandler } from "./tap.ts"

/** An app's error factory (`defineErrors`), as its settings hold it. */
export type ErrorFactories = Readonly<Record<string, (...args: never[]) => unknown>>

/** What the error and miss hooks receive. */
export type ErrorCtx<TEnv> = { env: TEnv; jsonFromError: (err: HoneyError) => Response; req: Request }

/** What `resolveLocale` reads the request's locale from. */
export type ResolveLocaleCtx<TEnv> = {
	readonly cookies: Readonly<Record<string, string>>
	readonly env: TEnv
	readonly headers: Readonly<Record<string, string>>
	readonly params: Readonly<Record<string, string>>
	readonly req: Request
	readonly search: Readonly<Record<string, string>>
}

/** `app.errorI18n`, built by `errorI18n()` from `@lovrozagar/honey/i18n`; `translate` answers a copy. */
export type ErrorI18n<TEnv = unknown> = {
	readonly resolveLocale: (ctx: ResolveLocaleCtx<TEnv>) => MaybePromise<string>
	translate(error: HoneyError, locale: string): HoneyError
}

/** Map a thrown value: a HoneyError replaces the error, a Response answers, nothing falls through. */
export type OnErrorFn<TEnv> = (
	error: unknown,
	ctx: ErrorCtx<TEnv>,
) => MaybePromise<HoneyError | Response | undefined | void>

export type OnMethodNotAllowedFn<TEnv> = (ctx: ErrorCtx<TEnv> & { allowed: string[] }) => MaybePromise<Response>

export type OnNotFoundFn<TEnv> = (ctx: ErrorCtx<TEnv>) => MaybePromise<Response>

/** The request log's options: `skip` answers true for a line not to write. */
export type RequestLogOptions = { readonly skip?: (entry: RequestLogEntry) => boolean }

export type AppSettings<TEnv = unknown> = {
	customErrorFormatter: CustomErrorFormatter | null
	/** the body schema of schema errors, for the OpenAPI document */
	customErrorSchema: StandardSchemaLike | null
	defaultBoundaryKey: string | null
	defaultErrorKeys: Set<string>
	encodedSlashes: "allow" | "reject"
	errorFactory: ErrorFactories | null
	errorFormat: ErrorFormat
	errorFormatter: ErrorFormatter
	/** translates the answer to an unhandled throw and to an onError HoneyError; `null`: off */
	errorI18n: ErrorI18n<TEnv> | null
	/** the body schema of standard errors, for the OpenAPI document */
	errorSchema: StandardSchemaLike | null
	/** where every server-side line goes: the default createLogger(), the app's own, or SILENT */
	logger: Logger
	/** whether `.output()` routes check what they answer: resolved per route at finalize */
	outputValidation: OutputValidationMode
	onError: OnErrorFn<TEnv> | null
	onMethodNotAllowed: OnMethodNotAllowedFn<TEnv> | null
	onNotFound: OnNotFoundFn<TEnv> | null
	/** one info line per request after its body ends; `null`: off */
	requestLog: RequestLogOptions | null
	/** spans per request and the error reporter; `null`: off, at the cost of one check */
	telemetry: Telemetry | null
	stripPrefix: string | null
	/** `app.tap()` handlers by key; `null` until one is registered */
	taps: Map<string, TapFn<TEnv>> | null
	trailingSlash: "enforce" | "ignore" | "strip"
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

/** The settings surface every handle shares: each setter applies to the whole app and returns the handle. */
export abstract class SettingsChain<TEnv> {
	protected readonly settings: AppSettings<TEnv>

	constructor(settings: AppSettings<TEnv>) {
		this.settings = settings
	}

	/** Recompile what the app serves on its next request: a setting finalize reads changed. */
	protected abstract invalidate(): void

	/** A tap fired after a route's handler answered, in the background (see routing/tap.ts). */
	tap<const TKey extends string>(
		key: TKey,
		handler: TapHandler<TEnv, this extends { readonly $taps: infer T } ? T : {}, TKey>,
	): this {
		;(this.settings.taps ??= new Map()).set(key, handler as TapFn<TEnv>)
		this.invalidate()
		return this
	}

	/** Type only: each tap key's payload, for `ctx.tap()`, tap handlers and route meta. */
	taps<TNewTaps extends Record<string, unknown>>(): WithTaps<this, TNewTaps> {
		return this as never
	}

	/** Check `.output()` answers: `"off"` (default), `"always"`, or `"dev"` (not production; never without a process). */
	outputValidation(mode: OutputValidationMode): this {
		this.settings.outputValidation = mode
		this.invalidate()
		return this
	}

	/** `"strip"` redirects `/a/` to `/a`, `"enforce"` redirects `/a` to `/a/` (308); `"ignore"` serves both. */
	trailingSlash(mode: "enforce" | "ignore" | "strip"): this {
		this.settings.trailingSlash = mode
		return this
	}

	/** An encoded `/` or `\` in the path is a 400 by default; `"allow"` decodes it into a param value. */
	encodedSlashes(mode: "allow" | "reject"): this {
		this.settings.encodedSlashes = mode
		return this
	}

	/** Strip a URL path prefix before matching: whole segments only; a path without it passes through. */
	stripPrefix(prefix: string): this {
		this.settings.stripPrefix = normalizeStripPrefix(prefix)
		return this
	}

	/** Where every server-side line goes; default `createLogger()` (by NODE_ENV), `false` for none. */
	logger(logger: Logger | false): this {
		this.settings.logger = logger === false ? SILENT : logger
		return this
	}

	/** One `info` line per request once its body ends (or is aborted); off by default, `skip` drops a line. */
	requestLog(options: boolean | RequestLogOptions): this {
		this.settings.requestLog = options === false ? null : options === true ? {} : options
		return this
	}

	/**
	 * Trace every request (a root span, the middleware and the handler under it) and report thrown
	 * errors in the background. Pass `otelAdapter(api, options)` from `@lovrozagar/honey/telemetry`.
	 */
	telemetry(value: Telemetry): this {
		if (typeof (value as Partial<Telemetry> | null)?.tracer?.startSpan !== "function") {
			throw new TypeError(
				"app.telemetry(): pass otelAdapter(api) from @lovrozagar/honey/telemetry, or a value with a tracer",
			)
		}
		this.settings.telemetry = value
		this.invalidate()
		return this
	}

	/**
	 * Translate error answers per request: the message from the locale's template, field paths to
	 * display names. Pass `errorI18n({ errors, fieldNames, resolveLocale })` from
	 * `@lovrozagar/honey/i18n`; a raw config object is refused here, at startup.
	 */
	errorI18n(value: ErrorI18n<TEnv>): this {
		const candidate = value as Partial<ErrorI18n<TEnv>> | null
		if (typeof candidate?.translate !== "function" || typeof candidate.resolveLocale !== "function") {
			throw new TypeError("app.errorI18n(): pass errorI18n({ ... }) from @lovrozagar/honey/i18n, not its config")
		}
		this.settings.errorI18n = value
		return this
	}

	onError(handler: OnErrorFn<TEnv>): this {
		this.settings.onError = handler
		return this
	}

	onMethodNotAllowed(handler: OnMethodNotAllowedFn<TEnv>): this {
		this.settings.onMethodNotAllowed = handler
		return this
	}

	onNotFound(handler: OnNotFoundFn<TEnv>): this {
		this.settings.onNotFound = handler
		return this
	}

	/**
	 * The runtime's WebSocket adapter, which ws routes upgrade through: `cfWebSocket()` on
	 * Workers. `serve(app)` sets the runtime's own on Node and Bun when none is set; on Bun, set
	 * it before `serve()`.
	 */
	wsAdapter(adapter: WSAdapter): this {
		this.settings.wsAdapter = adapter
		return this
	}

	/** Answer errors as honey's envelope (the default) or RFC 9457 Problem Details; schema errors keep their body. */
	errorFormat(format: ErrorFormat): this {
		this.settings.errorFormat = format
		return this
	}

	/** Shape every standard error body; with a schema, the body type is the schema's output. */
	defaultErrorFormatter<TSchema extends StandardSchemaLike>(
		schema: TSchema,
		fn: (error: HoneyError) => InferOutput<TSchema>,
	): this
	defaultErrorFormatter(fn: ErrorFormatter): this
	defaultErrorFormatter(schemaOrFn: ErrorFormatter | StandardSchemaLike, fn?: (error: HoneyError) => unknown): this {
		if (typeof schemaOrFn === "function") {
			this.settings.errorSchema = null
			this.settings.errorFormatter = schemaOrFn
		} else {
			const mapper = fn as (error: HoneyError) => Record<string, unknown>
			this.settings.errorSchema = schemaOrFn
			this.settings.errorFormatter = (error) => mapper(error)
		}
		return this
	}

	/** Shape every schema error body; with a schema, the body type is the schema's output. */
	customErrorFormatter<TSchema extends StandardSchemaLike>(
		schema: TSchema,
		fn: (error: HoneyError, data: Record<string, unknown>) => InferOutput<TSchema>,
	): this
	customErrorFormatter(fn: CustomErrorFormatter): this
	customErrorFormatter(
		schemaOrFn: CustomErrorFormatter | StandardSchemaLike,
		fn?: (error: HoneyError, data: Record<string, unknown>) => unknown,
	): this {
		if (typeof schemaOrFn === "function") {
			this.settings.customErrorSchema = null
			this.settings.customErrorFormatter = schemaOrFn
		} else {
			const mapper = fn as (error: HoneyError, data: Record<string, unknown>) => Record<string, unknown>
			this.settings.customErrorSchema = schemaOrFn
			this.settings.customErrorFormatter = (error, data) => mapper(error, data)
		}
		return this
	}
}

/** Settings that cannot work together, refused before the first request is served. */
export function assertSettingsAgree(s: AppSettings<unknown>): void {
	if (s.requestLog !== null && s.logger === SILENT) {
		throw new Error("honey: requestLog() is on, but logger(false) writes nothing: set a logger, or turn requestLog off")
	}
}
