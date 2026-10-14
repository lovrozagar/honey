/**
 * `HoneyError`: the one error shape honey answers with. It names its error key and status by the
 * snake_case vocabulary, carries per-field errors, and keeps what the operator log needs (cause,
 * vars) apart from what the client sees.
 */
import { type StatusKey, statusKeyToCode } from "../response/status.ts"

/** One problem with one input field: what the client reads under `fields`. */
export type FieldError = {
	error_key: string
	message: string
	path: string
}

const EMPTY_FIELDS: Readonly<Record<string, FieldError[]>> = /* @__PURE__ */ Object.freeze(
	/* @__PURE__ */ Object.create(null),
)

export type HoneyErrorOptions = {
	cause?: unknown
	data?: unknown
	errorKey: string
	fields?: Record<string, FieldError[]>
	headers?: Record<string, string>
	status: StatusKey
	vars?: Record<string, number | string>
}

export class HoneyError extends Error {
	readonly data?: unknown
	readonly errorKey: string
	readonly fields: Readonly<Record<string, FieldError[]>>
	readonly headers?: Record<string, string>
	readonly status: number
	readonly statusKey: StatusKey
	readonly vars?: Record<string, number | string>

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
		this.fields = options.fields ?? EMPTY_FIELDS
		this.vars = options.vars
	}

	/** A thrown value as a plain object for the operator log: message, name, stack, the error's keys and its cause chain. */
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
