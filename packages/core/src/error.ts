import type { FieldError, StatusKey } from "./types.ts"
import { EMPTY_FIELDS, statusKeyToCode } from "./types.ts"

export class HoneyError extends Error {
	readonly data?: unknown
	readonly errorKey: string
	readonly fields: Record<string, FieldError[]>
	readonly headers?: Record<string, string>
	readonly status: number
	readonly statusKey: StatusKey
	readonly vars?: Record<string, string | number>

	constructor(opts: {
		cause?: unknown
		data?: unknown
		errorKey: string
		fields?: Record<string, FieldError[]>
		headers?: Record<string, string>
		status: StatusKey
		vars?: Record<string, string | number>
	}) {
		super(opts.errorKey, opts.cause !== undefined ? { cause: opts.cause } : undefined)
		this.data = opts.data
		this.errorKey = opts.errorKey
		this.headers = opts.headers
		this.statusKey = opts.status
		this.status = statusKeyToCode[opts.status]
		this.fields = opts.fields ?? EMPTY_FIELDS
		this.vars = opts.vars
	}

	static serialize(e: unknown): Record<string, unknown> {
		if (!(e instanceof Error)) return { message: String(e) }

		const obj: Record<string, unknown> = {
			message: e.message,
			name: e.name,
			stack: e.stack,
		}

		if (e instanceof HoneyError) {
			obj["errorKey"] = e.errorKey
			obj["status"] = e.status
			obj["statusKey"] = e.statusKey
			if (Object.keys(e.fields).length > 0) obj["fields"] = e.fields
		}

		if (e.cause) obj["cause"] = HoneyError.serialize(e.cause)

		return obj
	}
}
