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
			Error.captureStackTrace(this, ClientError)
		}
		this.name = "ClientError"
		this.body = init.body
		this.response = init.response
		this.status = init.status
	}
}

export function isClientError<T = unknown>(e: unknown): e is ClientError<T> {
	return e instanceof ClientError
}
