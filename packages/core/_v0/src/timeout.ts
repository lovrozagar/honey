import { abortRequest } from "./context.ts"
import type { HoneyContext } from "./context.ts"
import { namedMiddleware } from "./middleware.ts"
import { HoneyError } from "./error.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { EK, SK } from "./types.ts"

type TimeoutOptions = {
	duration: number
}

/**
 * Answer 504 when the rest of the chain has not produced a response within `duration` ms, and
 * abort `ctx.signal` so the handler's work stops: a `fetch()`, query or stream that takes the
 * signal ends instead of running on after the 504. Work that ignores the signal still runs to
 * completion; its response is discarded.
 */
export function timeout(opts: TimeoutOptions): MiddlewareFn<{}, {}> {
	const { duration } = opts

	const mw: MiddlewareFn<{}, {}> = (ctx, next) => {
		return new Promise<Response>((resolve, reject) => {
			const timer = setTimeout(() => {
				const error = new HoneyError({
					errorKey: EK.request_timeout,
					status: SK.gateway_timeout,
				})
				reject(error)
				abortRequest(ctx as unknown as HoneyContext, new DOMException("request timed out", "TimeoutError"))
			}, duration)

			Promise.resolve(next())
				.then((res) => {
					clearTimeout(timer)
					resolve(res)
				})
				.catch((err) => {
					clearTimeout(timer)
					reject(err)
				})
		})
	}

	return namedMiddleware("timeout", mw)
}
