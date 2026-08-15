import { namedMiddleware } from "./middleware.ts"
import { HoneyError } from "./error.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { EK, SK } from "./types.ts"

type CSRFOptions = {
	origin?: ((origin: string) => boolean) | string | string[]
}

const safeMethodRe = /^(GET|HEAD|OPTIONS)$/
const formContentTypeRe = /^\b(application\/x-www-form-urlencoded|multipart\/form-data|text\/plain)\b/i

function matchOrigin(origin: string, config: CSRFOptions["origin"]): boolean {
	if (config === undefined) return false
	if (typeof config === "string") return config === origin
	if (Array.isArray(config)) return config.includes(origin)
	return config(origin)
}

export function csrf(options?: CSRFOptions): MiddlewareFn<{ req: Request }, {}> {
	const opts = options ?? {}

	const mw: MiddlewareFn<{ req: Request }, {}> = (ctx, next) => {
		const req = ctx.req

		if (safeMethodRe.test(req.method)) {
			return next()
		}

		const contentType = req.headers.get("content-type")
		if (contentType === null || !formContentTypeRe.test(contentType)) {
			return next()
		}

		/* check Sec-Fetch-Site first (modern browsers, unforgeable) */
		const secFetchSite = req.headers.get("sec-fetch-site")
		if (secFetchSite === "same-origin") {
			return next()
		}

		/* fall back to Origin header */
		const origin = req.headers.get("origin")
		if (origin !== null && matchOrigin(origin, opts.origin)) {
			return next()
		}

		throw new HoneyError({
			errorKey: EK.forbidden,
			status: SK.forbidden,
		})
	}

	return namedMiddleware("csrf", mw)
}
