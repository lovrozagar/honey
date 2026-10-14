/**
 * `poweredBy({ name })`: `X-Powered-By: Honey`, or `name`, on every answer. A value the handler set
 * itself is kept.
 */
import { withHeaders } from "../response/with-headers.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

export type PoweredByOptions = {
	/** Default `Honey`. */
	name?: string
}

export function poweredBy(options: PoweredByOptions = {}): MiddlewareFn<{}> {
	const name = options.name ?? "Honey"
	return namedMiddleware("poweredBy", async (_ctx, next) =>
		withHeaders(await next(), (headers) => {
			if (!headers.has("x-powered-by")) headers.set("x-powered-by", name)
		}),
	)
}
