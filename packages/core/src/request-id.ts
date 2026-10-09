import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { withHeaders } from "./with-headers.ts"

type RequestIdOptions = {
	generator?: () => string
	header?: string
	/**
	 * Decides whether an inbound id is reused. Default: 1–128 characters of
	 * `A-Z a-z 0-9 . _ : + / = -` (UUIDs, ULIDs, base64, W3C trace ids).
	 * Anything else is replaced with a generated id, so a client cannot put
	 * arbitrary text into logs or response headers.
	 */
	validate?: (id: string) => boolean
}

const SAFE_ID_RE = /^[\w.:+/=-]{1,128}$/

export function requestId(options?: RequestIdOptions): MiddlewareFn<{ req: Request }, { requestId: string }> {
	const headerName = options?.header ?? "x-request-id"
	const generate = options?.generator ?? (() => crypto.randomUUID())
	const validate = options?.validate ?? ((id: string) => SAFE_ID_RE.test(id))

	const mw: MiddlewareFn<{ req: Request }, { requestId: string }> = async (ctx, next) => {
		const existing = ctx.req.headers.get(headerName)
		const id = existing !== null && validate(existing) ? existing : generate()
		const response = await next({ requestId: id })
		return withHeaders(response, (headers) => headers.set(headerName, id))
	}

	return namedMiddleware("requestId", mw)
}
