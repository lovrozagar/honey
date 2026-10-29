export type ClientErrorInit<TBody = unknown> = {
	body: TBody
	message: string
	response: Response
	status: number
}

/** A non-2xx answer: its status, the parsed body (JSON when it parses, else text) and the response. */
export class ClientError<TBody = unknown> extends Error {
	readonly body: TBody
	readonly response: Response
	readonly status: number

	constructor(init: ClientErrorInit<TBody>) {
		super(init.message)
		/* V8 only, and not in every lib: read it as optional so the runtime compiles anywhere */
		;(Error as { captureStackTrace?: (target: object, ctor?: unknown) => void }).captureStackTrace?.(this, new.target)
		this.name = "ClientError"
		this.body = init.body
		this.response = init.response
		this.status = init.status
	}
}

export class BadRequestError<TBody = unknown> extends ClientError<TBody> {
	override name = "BadRequestError"
}
export class UnauthorizedError<TBody = unknown> extends ClientError<TBody> {
	override name = "UnauthorizedError"
}
export class ForbiddenError<TBody = unknown> extends ClientError<TBody> {
	override name = "ForbiddenError"
}
export class NotFoundError<TBody = unknown> extends ClientError<TBody> {
	override name = "NotFoundError"
}
export class ConflictError<TBody = unknown> extends ClientError<TBody> {
	override name = "ConflictError"
}
export class UnprocessableEntityError<TBody = unknown> extends ClientError<TBody> {
	override name = "UnprocessableEntityError"
}
export class RateLimitError<TBody = unknown> extends ClientError<TBody> {
	override name = "RateLimitError"
}
export class InternalServerError<TBody = unknown> extends ClientError<TBody> {
	override name = "InternalServerError"
}
export class BadGatewayError<TBody = unknown> extends ClientError<TBody> {
	override name = "BadGatewayError"
}
export class ServiceUnavailableError<TBody = unknown> extends ClientError<TBody> {
	override name = "ServiceUnavailableError"
}
export class GatewayTimeoutError<TBody = unknown> extends ClientError<TBody> {
	override name = "GatewayTimeoutError"
}

const STATUS_ERRORS: Readonly<Record<number, new (init: ClientErrorInit) => ClientError>> = {
	400: BadRequestError,
	401: UnauthorizedError,
	403: ForbiddenError,
	404: NotFoundError,
	409: ConflictError,
	422: UnprocessableEntityError,
	429: RateLimitError,
	500: InternalServerError,
	502: BadGatewayError,
	503: ServiceUnavailableError,
	504: GatewayTimeoutError,
}

/** The most specific error class for a status: `UnauthorizedError` for 401, `ClientError` otherwise. */
export function clientErrorFor<TBody>(init: ClientErrorInit<TBody>): ClientError<TBody> {
	const Cls = (Object.hasOwn(STATUS_ERRORS, init.status) ? STATUS_ERRORS[init.status] : undefined) ?? ClientError
	return new Cls(init) as ClientError<TBody>
}

export function isClientError<T = unknown>(e: unknown): e is ClientError<T> {
	return e instanceof ClientError
}

/** A request with no answer; the platform error is its `cause`. */
export class APIConnectionError extends Error {
	override name = "APIConnectionError"
}

/** A send or body read with no answer as APIConnectionError, its cause the platform's; an abort's as it is (f2). */
export function noAnswer(cause: unknown, url: unknown, init?: RequestInit): unknown {
	if (init?.signal?.aborted) return cause
	const { origin, pathname } = new URL(String(url))
	return new APIConnectionError(`${init?.method} ${origin}${pathname}: the connection failed`, { cause })
}

/** A fetch failure as APIConnectionError; an abort's as it is. */
export function connectionErrors(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
	if (typeof fetch !== "function") return fetch
	/* asserted, as Bun's fetch type also names `preconnect` */
	return (async (input, init) => {
		try {
			return await fetch(input, init)
		} catch (cause) {
			throw noAnswer(cause, input, init)
		}
	}) as typeof globalThis.fetch
}
