/**
 * App settings: one object per app graph, shared by every handle derived from it (`use()`,
 * `basePath()`, `context()`, `meta()`), so a setter called on any handle applies to all of them.
 * A route keeps the settings of the app it was registered on, so a mounted sub-app's routes keep
 * their own error factory, default errors and boundary. Feature bits add their own fields.
 */
import type { HoneyError } from "../errors/error.ts"
import type { CustomErrorFormatter, ErrorFormatter } from "../errors/projector.ts"
import type { MaybePromise } from "../middleware/middleware.ts"
import { requireFeature } from "../runtime/feature-slots.ts"
import { TRUST_OFF, type TrustSetting } from "../trust/client-info.ts"
import type { TrustProxy } from "../trust/trust.ts"
import type { InferOutput, StandardSchemaLike } from "../validation/standard-schema.ts"

/** An app's error factory (`defineErrors`), as its settings hold it. */
export type ErrorFactories = Readonly<Record<string, (...args: never[]) => unknown>>

/** What the error and miss hooks receive. */
export type ErrorCtx<TEnv> = { env: TEnv; jsonFromError: (err: HoneyError) => Response; req: Request }

/** Map a thrown value: a HoneyError replaces the error, a Response answers, nothing falls through. */
export type OnErrorFn<TEnv> = (
	error: unknown,
	ctx: ErrorCtx<TEnv>,
) => MaybePromise<HoneyError | Response | undefined | void>

export type OnMethodNotAllowedFn<TEnv> = (ctx: ErrorCtx<TEnv> & { allowed: string[] }) => MaybePromise<Response>

export type OnNotFoundFn<TEnv> = (ctx: ErrorCtx<TEnv>) => MaybePromise<Response>

export type AppSettings<TEnv = unknown> = {
	customErrorFormatter: CustomErrorFormatter | null
	/** the body schema of schema errors, for the OpenAPI document */
	customErrorSchema: StandardSchemaLike | null
	defaultBoundaryKey: string | null
	defaultErrorKeys: Set<string>
	encodedSlashes: "allow" | "reject"
	errorFactory: ErrorFactories | null
	errorFormatter: ErrorFormatter
	/** the body schema of standard errors, for the OpenAPI document */
	errorSchema: StandardSchemaLike | null
	onError: OnErrorFn<TEnv> | null
	onMethodNotAllowed: OnMethodNotAllowedFn<TEnv> | null
	onNotFound: OnNotFoundFn<TEnv> | null
	stripPrefix: string | null
	trailingSlash: "enforce" | "ignore" | "strip"
	/** `trustProxy()`: how far forwarding headers are believed for `ctx.ip`, scheme and host */
	trust: TrustSetting
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
		customErrorFormatter: null,
		customErrorSchema: null,
		defaultBoundaryKey: null,
		defaultErrorKeys: new Set(),
		encodedSlashes: "reject",
		errorFactory: null,
		errorFormatter: defaultErrorFormatter,
		errorSchema: null,
		onError: null,
		onMethodNotAllowed: null,
		onNotFound: null,
		stripPrefix: null,
		trailingSlash: "ignore",
		trust: TRUST_OFF,
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

	/** `"strip"` redirects `/a/` to `/a`, `"enforce"` redirects `/a` to `/a/` (308); `"ignore"` serves both. */
	trailingSlash(mode: "enforce" | "ignore" | "strip"): this {
		this.settings.trailingSlash = mode
		return this
	}

	/**
	 * Request paths containing an encoded `/` or `\` (`%2F`, `%5C`) answer 400 by default. `"allow"`
	 * keeps them encoded in the path, so they decode into a param value. Only allow them when nothing
	 * downstream treats a decoded slash as a separator.
	 */
	encodedSlashes(mode: "allow" | "reject"): this {
		this.settings.encodedSlashes = mode
		return this
	}

	/** Strip a URL path prefix before matching: whole segments only; a path without it passes through. */
	stripPrefix(prefix: string): this {
		this.settings.stripPrefix = normalizeStripPrefix(prefix)
		return this
	}

	/**
	 * How far `X-Forwarded-*` is believed for `ctx.ip`, the scheme and the host: off (the
	 * default, the peer is the client), a hop count, or the addresses and CIDR ranges of trusted
	 * proxies. Anything but off needs `import "@lovrozagar/honey/trust"`; an invalid value throws here.
	 */
	trustProxy(value: TrustProxy): this {
		this.settings.trust =
			value === false || value === 0 ? TRUST_OFF : requireFeature("trust", "app.trustProxy()").compileTrust(value)
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
