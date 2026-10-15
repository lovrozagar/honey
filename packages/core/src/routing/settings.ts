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
	/** the metaSpec policy this app declared, and each mounted sub-app's: merged when a document is built */
	readonly metaSpec: MetaSpecSource
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
