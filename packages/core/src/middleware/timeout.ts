/**
 * `timeout({ duration })`: answer 504 `request_timeout` when the rest of the chain has not answered
 * within `duration` ms, and abort `ctx.signal`, so a fetch, query or stream that takes it stops
 * instead of running on after the 504. Work that ignores the signal still runs; its answer is
 * dropped. An answer or an error in time goes through untouched.
 */
import { ABORT_CONTEXT, type HoneyContext } from "../context/context.ts"
import { HoneyError } from "../errors/error.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

export type TimeoutOptions = {
	/** Milliseconds the chain below may take; 0 answers anything that waits a turn. */
	duration: number
}

export function timeout(options: TimeoutOptions): MiddlewareFn<{}, {}, "request_timeout"> {
	const { duration } = options
	if (!(Number.isFinite(duration) && duration >= 0)) {
		throw new TypeError("timeout: duration must be a finite number of ms, 0 or more")
	}
	const mw: MiddlewareFn<{}, {}, "request_timeout"> = (ctx, next) =>
		new Promise<Response>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new HoneyError({ errorKey: "request_timeout", status: "gateway_timeout" }))
				;(ctx as HoneyContext)[ABORT_CONTEXT](new DOMException("request timed out", "TimeoutError"))
			}, duration)
			/* next() never rejects: the boundary turns a throw below into its answer. Whichever comes
			 * first answers; a late answer is dropped, since the promise has settled */
			void Promise.resolve(next()).then((response) => {
				clearTimeout(timer)
				resolve(response)
			})
		})
	mw.errors = ["request_timeout"]
	return namedMiddleware("timeout", mw)
}
