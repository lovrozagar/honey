import type { MiddlewareFn } from "./middleware.ts"

type RequestIdOptions = {
	generator?: () => string
	header?: string
}

export function requestId(
	options?: RequestIdOptions,
): MiddlewareFn<{ req: Request }, { requestId: string }> {
	const headerName = options?.header ?? "x-request-id"
	const generate = options?.generator ?? (() => crypto.randomUUID())

	const mw: MiddlewareFn<{ req: Request }, { requestId: string }> = async (ctx, next) => {
		const existing = ctx.req.headers.get(headerName)
		const id = existing ?? generate()
		const response = await next({ requestId: id })
		response.headers.set(headerName, id)
		return response
	}

	return mw
}
