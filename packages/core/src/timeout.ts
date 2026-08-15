import { HoneyError } from "./error.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { EK, SK } from "./types.ts"

type TimeoutOptions = {
	duration: number
}

export function timeout(opts: TimeoutOptions): MiddlewareFn<{}, {}> {
	const { duration } = opts

	const mw: MiddlewareFn<{}, {}> = (_ctx, next) => {
		return new Promise<Response>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(
					new HoneyError({
						errorKey: EK.request_timeout,
						status: SK.gateway_timeout,
					}),
				)
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

	return mw
}
