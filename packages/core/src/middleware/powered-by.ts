/**
 * `poweredBy({ name })`: `X-Powered-By: Honey`, or `name`, on every answer. A value the handler set
 * itself is kept.
 */
import { withHeaders } from "../response/with-headers.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

/** The product name `poweredBy` advertises. */
export type PoweredByOptions = {
	/** Default `Honey`. */
	name?: string
}

/** Middleware that sets `X-Powered-By` on every answer passing through it that has none, except a 101 upgrade. */
export function poweredBy(options: PoweredByOptions = {}): MiddlewareFn<{}> {
	const name = options.name ?? "Honey"
	return namedMiddleware("poweredBy", async (_ctx, next) =>
		withHeaders(await next(), (headers) => {
			if (!headers.has("x-powered-by")) headers.set("x-powered-by", name)
		}),
	)
}
