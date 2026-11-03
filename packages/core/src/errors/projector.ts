/**
 * The thrown-value projector: what a handler or middleware threw becomes the `HoneyError` the
 * route's error boundary allows, and that error becomes a JSON response through the app's
 * formatters. Pure: dispatch wraps it with onError, i18n and telemetry.
 */
import { createHoneyResponse, withRawBody } from "../response/builder.ts"
import { EK, HoneyError, hasUnknownStatus, isFrameworkErrorKey } from "./error.ts"
import { ERROR_META, type ErrorMetaEntry } from "./errors.ts"
import { type ErrorFormat, PROBLEM_JSON, problemDetails } from "./problem-json.ts"

/** Shapes a standard error's default body. */
export type ErrorFormatter = (error: HoneyError, defaultShape: Record<string, unknown>) => Record<string, unknown>

/** Shapes a schema error's `data` body. */
export type CustomErrorFormatter = (error: HoneyError, data: Record<string, unknown>) => Record<string, unknown>

/** A `defineErrors` result, as the projector reads it. */
export type ErrorFactoryRecord = {
	/** The error factories, by error key. */
	readonly [key: string]: unknown
	readonly [ERROR_META]?: Readonly<Record<string, ErrorMetaEntry>>
}

/** What a route allows to reach the client. */
export type ErrorPolicy = {
	/** The error an undeclared or unknown throw becomes; `null`: a 500. */
	boundaryKey: string | null
	/** The keys the route declared via `.errors()`; `null`: the route does not enforce them. */
	declared: ReadonlySet<string> | null
	/** The app's error factories, used to build the boundary error; `null` when it has none. */
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

/** Hears a formatter that crashed; the answer still falls back to a well-formed body. */
export type FormatterReport = (failure: unknown) => void

/**
 * How an error answer is built: who hears a crashed formatter, whether honey's Node adapter sends
 * it, its format, its digest, and the request id a Problem Details document names as its instance.
 */
export type ErrorAnswer = {
	/** A 5xx answer's digest: the same value is on the operator's log line. */
	readonly digest?: string | undefined
	/** Body format: honey's envelope by default, or `problem+json`. */
	readonly format?: ErrorFormat
	/** The request id a Problem Details document names as its `instance`. */
	readonly instance?: string | null
	/** Build the answer for honey's Node adapter, as a `HoneyResponse` rather than a `Response`. Default false. */
	readonly nodeOut?: boolean
	/** Called with the failure when a formatter throws. */
	readonly report?: FormatterReport | undefined
}

/** A JSON answer built the way the bridge it goes out over writes it fastest. */
export function jsonAnswer(
	payload: string,
	headers: Record<string, string>,
	status: number,
	nodeOut: boolean,
): Response {
	if (nodeOut) return createHoneyResponse({ headers, raw: payload, status })
	return withRawBody(new Response(payload, { headers, status }), payload)
}

/** The default shape of a standard error: honey's envelope, or a Problem Details document. */
function defaultShapeOf(error: HoneyError, answer: ErrorAnswer): Record<string, unknown> {
	if (answer.format === "problem+json") return problemDetails(error, answer.instance ?? null)
	const shape: Record<string, unknown> = {
		error_key: error.errorKey,
		fields: error.fields,
		message: error.message,
		status: error.status,
		status_key: error.statusKey,
		success: false,
	}
	/* vars already reach the client inside a translated message: the structured copy exposes nothing new */
	if (error.vars !== undefined) shape.vars = error.vars
	return shape
}

function errorBody(
	error: HoneyError,
	defaultFormatter: ErrorFormatter,
	customFormatter: CustomErrorFormatter | null | undefined,
	answer: ErrorAnswer,
) {
	const report = answer.report
	if (error.data !== undefined) {
		const data = error.data as Record<string, unknown>
		if (!customFormatter) return data
		try {
			return customFormatter(error, data)
		} catch (failure) {
			/* a crashed custom formatter: reported, and the client still gets the error's data */
			report?.(failure)
			return data
		}
	}
	const defaultShape = defaultShapeOf(error, answer)
	if (answer.digest !== undefined) defaultShape.digest = answer.digest
	try {
		return defaultFormatter(error, defaultShape)
	} catch (failure) {
		/* a crashed formatter: reported, and the client still gets the default shape */
		report?.(failure)
		return defaultShape
	}
}

/** The JSON response for an error: a schema error's data, or the formatted default shape. */
export function createErrorResponse(
	error: HoneyError,
	defaultFormatter: ErrorFormatter,
	customFormatter?: CustomErrorFormatter | null,
	answer: ErrorAnswer = {},
): Response {
	const payload = JSON.stringify(errorBody(error, defaultFormatter, customFormatter, answer))
	/* a schema error keeps its declared body, and so its type */
	const type = answer.format === "problem+json" && error.data === undefined ? PROBLEM_JSON : "application/json"
	const headers: Record<string, string> = { "content-type": type, ...error.headers }
	return jsonAnswer(payload, headers, error.status, answer.nodeOut === true)
}

/**
 * The last resort when the error path itself failed: the HoneyError's own response, a 500 for
 * anything else, and a fixed 500 when even that cannot be serialized.
 */
export function safeErrorResponse(
	thrown: unknown,
	defaultFormatter: ErrorFormatter,
	customFormatter: CustomErrorFormatter | null,
	answer: ErrorAnswer = {},
): Response {
	try {
		return createErrorResponse(
			thrown instanceof HoneyError ? thrown : internalError(undefined),
			defaultFormatter,
			customFormatter,
			answer,
		)
	} catch {
		/* the last resort: the boundary logs what failed (on-error.ts); this only keeps the answer well-formed */
		return new Response(JSON.stringify({ error: { errorKey: EK.internal_server_error } }), {
			headers: { "content-type": "application/json" },
			status: 500,
		})
	}
}
