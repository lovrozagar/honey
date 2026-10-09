import { namedMiddleware } from "./middleware.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { withHeaders } from "./with-headers.ts"

type PoweredByOptions = {
	name?: string
}

export function poweredBy(options?: PoweredByOptions): MiddlewareFn<{}, {}> {
	const name = options?.name ?? "Honey"

	const mw: MiddlewareFn<{}, {}> = async (_ctx, next) => {
		const response = await next()
		return withHeaders(response, (headers) => headers.set("x-powered-by", name))
	}

	return namedMiddleware("poweredBy", mw)
}
