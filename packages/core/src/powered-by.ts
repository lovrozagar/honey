import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"

type PoweredByOptions = {
	name?: string
}

export function poweredBy(options?: PoweredByOptions): MiddlewareFn<{}, {}> {
	const name = options?.name ?? "Honey"

	const mw: MiddlewareFn<{}, {}> = async (_ctx, next) => {
		const response = await next()
		response.headers.set("x-powered-by", name)
		return response
	}

	return namedMiddleware("poweredBy", mw)
}
