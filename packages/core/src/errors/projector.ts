/**
 * The thrown-value projector: what a handler or middleware threw becomes the `HoneyError` the
 * route's error boundary allows, and that error becomes a JSON response through the app's
 * formatters. Pure: dispatch wraps it with onError, i18n and telemetry.
 */
import { withRawBody } from "../response/builder.ts"
import { EK, HoneyError, hasUnknownStatus, isFrameworkErrorKey } from "./error.ts"
import { ERROR_META, type ErrorMetaEntry } from "./errors.ts"

/** Shapes a standard error's default body. */
export type ErrorFormatter = (error: HoneyError, defaultShape: Record<string, unknown>) => Record<string, unknown>

/** Shapes a schema error's `data` body. */
export type CustomErrorFormatter = (error: HoneyError, data: Record<string, unknown>) => Record<string, unknown>

/** A `defineErrors` result, as the projector reads it. */
export type ErrorFactoryRecord = {
	readonly [key: string]: unknown
	readonly [ERROR_META]?: Readonly<Record<string, ErrorMetaEntry>>
}

/** The digest an unknown error's 500 carries: the same value is on the operator's log line. */
export const DIGEST: unique symbol = /* @__PURE__ */ Symbol("honey.digest")

/** What a route allows to reach the client. */
export type ErrorPolicy = {
	/** The error an undeclared or unknown throw becomes; `null`: a 500. */
	boundaryKey: string | null
	/** The keys the route declared via `.errors()`; `null`: the route does not enforce them. */
	declared: ReadonlySet<string> | null
	factory: ErrorFactoryRecord | null
}

function internalError(cause: unknown): HoneyError {
	return new HoneyError({ cause, errorKey: EK.internal_server_error, status: "internal_server_error" })
}

/** What `ctx.error` holds for a throw: the HoneyError itself, or the 500 it became. */
export function asHoneyError(thrown: unknown): HoneyError {
	return thrown instanceof HoneyError ? thrown : internalError(thrown)
}

/** The boundary error for `errorKey`: the factory's standard error, else a 500 under that key. */
export function boundaryError(errorKey: string, cause: unknown, factory: ErrorFactoryRecord | null): HoneyError {
	const make = factory?.[errorKey]
	/* a schema error needs its payload: it cannot serve as the boundary */
	if (typeof make === "function" && !factory?.[ERROR_META]?.[errorKey]?.schema) {
		return (make as (opts: { cause: unknown }) => HoneyError)({ cause })
	}
	return new HoneyError({ cause, errorKey, status: "internal_server_error" })
}

/** The error a throw becomes under the route's policy. */
export function projectThrown(thrown: unknown, policy: ErrorPolicy): HoneyError {
	if (thrown instanceof HoneyError && !hasUnknownStatus(thrown)) {
		const allowed =
			policy.declared === null || isFrameworkErrorKey(thrown.errorKey) || policy.declared.has(thrown.errorKey)
		if (allowed) return thrown
	}
	return policy.boundaryKey === null ? internalError(thrown) : boundaryError(policy.boundaryKey, thrown, policy.factory)
}

function errorBody(error: HoneyError, defaultFormatter: ErrorFormatter, customFormatter?: CustomErrorFormatter | null) {
	if (error.data !== undefined) {
		const data = error.data as Record<string, unknown>
		if (!customFormatter) return data
		try {
			return customFormatter(error, data)
		} catch {
			return data
		}
	}
	const defaultShape: Record<string, unknown> = {
		error_key: error.errorKey,
		fields: error.fields,
		message: error.message,
		status: error.status,
		status_key: error.statusKey,
		success: false,
	}
	const digest = (error as { [DIGEST]?: string })[DIGEST]
	if (digest !== undefined) defaultShape.digest = digest
	try {
		return defaultFormatter(error, defaultShape)
	} catch {
		/* a crashed formatter falls back to the default shape */
		return defaultShape
	}
}

/** The JSON response for an error: a schema error's data, or the formatted default shape. */
export function createErrorResponse(
	error: HoneyError,
	defaultFormatter: ErrorFormatter,
	customFormatter?: CustomErrorFormatter | null,
): Response {
	const payload = JSON.stringify(errorBody(error, defaultFormatter, customFormatter))
	const headers: Record<string, string> = { "content-type": "application/json", ...error.headers }
	return withRawBody(new Response(payload, { headers, status: error.status }), payload)
}

/**
 * The last resort when the error path itself failed: the HoneyError's own response, a 500 for
 * anything else, and a fixed 500 when even that cannot be serialized.
 */
export function safeErrorResponse(
	thrown: unknown,
	defaultFormatter: ErrorFormatter,
	customFormatter: CustomErrorFormatter | null,
): Response {
	try {
		return createErrorResponse(
			thrown instanceof HoneyError ? thrown : internalError(undefined),
			defaultFormatter,
			customFormatter,
		)
	} catch {
		return new Response(JSON.stringify({ error: { errorKey: EK.internal_server_error } }), {
			headers: { "content-type": "application/json" },
			status: 500,
		})
	}
}
