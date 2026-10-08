export type ClientErrorInit<TBody = unknown> = {
	body: TBody
	message: string
	response: Response
	status: number
}

export class ClientError<TBody = unknown> extends Error {
	readonly body: TBody
	readonly response: Response
	readonly status: number

	constructor(init: ClientErrorInit<TBody>) {
		super(init.message)
		if (typeof Error.captureStackTrace === "function") {
			Error.captureStackTrace(this, new.target)
		}
		this.name = "ClientError"
		this.body = init.body
		this.response = init.response
		this.status = init.status
	}
}

/* Per-status subclasses, the same set the generated TypeScript SDK exports. */
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

const STATUS_ERRORS = new Map<number, new (init: ClientErrorInit) => ClientError>([
	[400, BadRequestError],
	[401, UnauthorizedError],
	[403, ForbiddenError],
	[404, NotFoundError],
	[409, ConflictError],
	[422, UnprocessableEntityError],
	[429, RateLimitError],
	[500, InternalServerError],
	[502, BadGatewayError],
	[503, ServiceUnavailableError],
	[504, GatewayTimeoutError],
])

/** The most specific error class for a status: `UnauthorizedError` for 401, `ClientError` otherwise. */
export function clientErrorFor<TBody>(init: ClientErrorInit<TBody>): ClientError<TBody> {
	const Cls = STATUS_ERRORS.get(init.status) ?? ClientError
	return new Cls(init) as ClientError<TBody>
}

export function isClientError<T = unknown>(e: unknown): e is ClientError<T> {
	return e instanceof ClientError
}
