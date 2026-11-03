/**
 * `HoneyError`: the one error shape honey answers with. It names its error key and status by the
 * snake_case vocabulary, carries per-field errors, and keeps what the operator log needs (cause,
 * vars) apart from what the client sees.
 */
import { type StatusKey, statusKeyToCode } from "../response/status.ts"

/** One problem with one input field: what the client reads under `fields`. */
export type FieldError = {
	/** Machine-readable key of the problem; clients branch on it. */
	error_key: string
	/** Human-readable description of the problem. */
	message: string
	/** The dotted path of the field, for example `json.email`; its display name when error messages are translated. */
	path: string
}

const EMPTY_FIELDS: Readonly<Record<string, FieldError[]>> = /* @__PURE__ */ Object.freeze(
	/* @__PURE__ */ Object.create(null),
)

/** honey's own error keys, each with the status honey answers it with: what every `defineErrors` factory starts from. */
export type FrameworkErrors = {
	/** an upstream answered badly: 502 */
	readonly bad_gateway: "bad_gateway"
	/** a request path honey rejects: 400 */
	readonly bad_request: "bad_request"
	/** a body over the size limit: 413 */
	readonly content_too_large: "content_too_large"
	/** a request `csrf()` or `ipRestrict()` refused: 403 */
	readonly forbidden: "forbidden"
	/** an upstream did not answer in time: 504 */
	readonly gateway_timeout: "gateway_timeout"
	/** an unknown throw: 500 */
	readonly internal_server_error: "internal_server_error"
	/** a request body the declared parser cannot read (bad JSON, broken multipart): 400 */
	readonly malformed_body: "bad_request"
	/** a path served under other methods: 405 */
	readonly method_not_allowed: "method_not_allowed"
	/** no route matched: 404 */
	readonly not_found: "not_found"
	/** an answer whose content type the route's output does not declare: 500 */
	readonly output_content_type_mismatch: "internal_server_error"
	/** an answer its output schema rejects: 500 */
	readonly output_validation_failed: "internal_server_error"
	/** a handler over its `timeout()`: 504, the gateway status, since the client sent its request in time */
	readonly request_timeout: "gateway_timeout"
	/** a client over its rate limit: 429 */
	readonly too_many_requests: "too_many_requests"
	/** a body in a content type the route does not take: 415 */
	readonly unsupported_media_type: "unsupported_media_type"
	/** input its schema rejects: 400 */
	readonly validation_failed: "bad_request"
}

/** The error keys the framework throws on its own behalf. */
export const EK: { readonly [K in keyof FrameworkErrors]: K } = /* @__PURE__ */ Object.freeze({
	bad_gateway: "bad_gateway",
	bad_request: "bad_request",
	content_too_large: "content_too_large",
	forbidden: "forbidden",
	gateway_timeout: "gateway_timeout",
	internal_server_error: "internal_server_error",
	malformed_body: "malformed_body",
	method_not_allowed: "method_not_allowed",
	not_found: "not_found",
	output_content_type_mismatch: "output_content_type_mismatch",
	output_validation_failed: "output_validation_failed",
	request_timeout: "request_timeout",
	too_many_requests: "too_many_requests",
	unsupported_media_type: "unsupported_media_type",
	validation_failed: "validation_failed",
})

/** The status honey answers each of its own keys with. */
export const FRAMEWORK_ERRORS: FrameworkErrors = /* @__PURE__ */ Object.freeze({
	bad_gateway: "bad_gateway",
	bad_request: "bad_request",
	content_too_large: "content_too_large",
	forbidden: "forbidden",
	gateway_timeout: "gateway_timeout",
	internal_server_error: "internal_server_error",
	malformed_body: "bad_request",
	method_not_allowed: "method_not_allowed",
	not_found: "not_found",
	output_content_type_mismatch: "internal_server_error",
	output_validation_failed: "internal_server_error",
	request_timeout: "gateway_timeout",
	too_many_requests: "too_many_requests",
	unsupported_media_type: "unsupported_media_type",
	validation_failed: "bad_request",
})

/**
 * A key the framework owns (validation, negotiation, routing, the shipped middleware): it always
 * passes a route's declared-error check, since users never declare it via `.errors()`. A plain
 * `internal_server_error` is not one: an undeclared throw of it still goes through the boundary.
 */
export function isFrameworkErrorKey(key: string): boolean {
	return key !== EK.internal_server_error && Object.hasOwn(EK, key)
}

/** What a `HoneyError` is built from. Only `errorKey` and `status` are required. */
export type HoneyErrorOptions = {
	/**
	 * The underlying failure, kept on the error's `cause`. Not sent to the client; `HoneyError.serialize()` includes
	 * it.
	 */
	cause?: unknown
	/**
	 * The payload of an error declared with a schema. When set, it is the response body, or what the app's custom error
	 * formatter makes of it, in place of the standard shape.
	 */
	data?: unknown
	/**
	 * The error's key, for example `not_found`: the `error_key` the client reads, and the `message` until translated.
	 */
	errorKey: string
	/** Per-field problems, keyed by field name, that the client reads under `fields`. Default none. */
	fields?: Record<string, FieldError[]>
	/** Headers added to the error response. */
	headers?: Record<string, string>
	/** The response status, by key such as `not_found`. A key that names no status makes the error a 500. */
	status: StatusKey
	/** Named values that fill the translated message's template. `HoneyError.serialize()` includes them. */
	vars?: Record<string, number | string>
}

/** Marks an error built with a status key that names no status: not representable to a client. */
const UNKNOWN_STATUS = /* @__PURE__ */ Symbol("honey.unknownStatus")

/** Whether `error` was built with a status key that names no status. */
export function hasUnknownStatus(error: HoneyError): boolean {
	return Object.hasOwn(error, UNKNOWN_STATUS)
}

/**
 * The error honey throws and answers with: an error key, a status, optional per-field problems and a payload.
 * The client sees the key, status, message and fields, or only `data` for a schema error. The cause stays on the
 * server, and `vars` reach the client only through a translated message.
 */
export class HoneyError extends Error {
	/** Payload of an error declared with a schema; `undefined` otherwise. */
	readonly data?: unknown
	/** The error's key, for example `not_found`. */
	readonly errorKey: string
	/** Per-field problems, keyed by field name. Empty when there are none. */
	readonly fields: Readonly<Record<string, FieldError[]>>
	/** Headers added to the error response. */
	readonly headers?: Record<string, string>
	/** The numeric response status. A status key that named no status gives 500. */
	readonly status: number
	/** The status by key, for example `not_found`. An unknown key becomes `internal_server_error`. */
	readonly statusKey: StatusKey
	/** Named values that fill the translated message's template. */
	readonly vars?: Record<string, number | string>

	/** Builds the error from `options`; the message is the error key. */
	constructor(options: HoneyErrorOptions) {
		/* no cause given: no own `cause` property, as with a plain Error */
		super(options.errorKey, options.cause === undefined ? undefined : { cause: options.cause })
		this.data = options.data
		this.errorKey = options.errorKey
		this.headers = options.headers
		/* an unknown status key must not turn an error into a 200: it is a 500 */
		const known = Object.hasOwn(statusKeyToCode, options.status)
		this.statusKey = known ? options.status : "internal_server_error"
		this.status = known ? statusKeyToCode[options.status] : 500
		if (!known) Object.defineProperty(this, UNKNOWN_STATUS, { value: true })
		this.fields = options.fields ?? EMPTY_FIELDS
		this.vars = options.vars
	}

	/**
	 * A thrown value as a plain object for the operator log: message, name, stack, the error's keys and its cause
	 * chain.
	 */
	static serialize(error: unknown): Record<string, unknown> {
		if (!(error instanceof Error)) return { message: String(error) }
		const out: Record<string, unknown> = { message: error.message, name: error.name, stack: error.stack }
		if (error instanceof HoneyError) {
			out.errorKey = error.errorKey
			out.status = error.status
			out.statusKey = error.statusKey
			if (Object.keys(error.fields).length > 0) out.fields = error.fields
			if (error.vars !== undefined) out.vars = error.vars
		}
		/* v0 parity: a falsy cause (null, 0, "") is not logged */
		if (error.cause) out.cause = HoneyError.serialize(error.cause)
		return out
	}
}
