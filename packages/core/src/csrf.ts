import { namedMiddleware } from "./middleware.ts"
import { HoneyError } from "./error.ts"
import type { MiddlewareFn } from "./middleware.ts"
import { EK, SK } from "./types.ts"

type CSRFOptions = {
	/**
	 * Cross-origin callers allowed to make unsafe requests, matched against the
	 * full `Origin` (`https://app.example.com`). Same-origin requests never need
	 * to be listed.
	 */
	origin?: ((origin: string) => boolean) | string | string[]
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function matchOrigin(origin: string, config: CSRFOptions["origin"]): boolean {
	if (config === undefined) return false
	if (typeof config === "string") return config === origin
	if (Array.isArray(config)) return config.includes(origin)
	return config(origin)
}

/** Host of the request as the client addressed it: `Host`, else the URL's host. */
function requestHost(req: Request): string | null {
	const host = req.headers.get("host")
	if (host !== null && host !== "") return host.toLowerCase()
	try {
		return new URL(req.url).host.toLowerCase()
	} catch {
		return null
	}
}

function originHost(origin: string): string | null {
	if (origin === "null") return null
	try {
		return new URL(origin).host.toLowerCase()
	} catch {
		return null
	}
}

function reject(): never {
	throw new HoneyError({ errorKey: EK.forbidden, status: SK.forbidden })
}

/**
 * Rejects cross-origin unsafe requests, whatever their content type.
 *
 * 1. `GET`, `HEAD` and `OPTIONS` pass.
 * 2. With `Sec-Fetch-Site` (every current browser sends it): `same-origin` and
 *    `none` (user-initiated) pass. `same-site` and `cross-site` pass only for an
 *    allow-listed `Origin`. A sibling subdomain is same-site but not trusted.
 * 3. Without it: no `Origin` passes (curl, server-to-server, old clients that
 *    cannot be driven cross-site), an `Origin` whose host equals `Host` passes,
 *    an allow-listed `Origin` passes, anything else is rejected.
 *
 * Failure is 403 `forbidden`. This is the algorithm of Go's
 * `http.CrossOriginProtection`.
 */
export function csrf(options?: CSRFOptions): MiddlewareFn<{ req: Request }, {}> {
	const allow = options?.origin

	const mw: MiddlewareFn<{ req: Request }, {}> = (ctx, next) => {
		const req = ctx.req
		if (SAFE_METHODS.has(req.method)) return next()

		const origin = req.headers.get("origin")
		const site = req.headers.get("sec-fetch-site")

		if (site !== null) {
			if (site === "same-origin" || site === "none") return next()
			if (origin !== null && matchOrigin(origin, allow)) return next()
			return reject()
		}

		if (origin === null) return next()
		const host = originHost(origin)
		if (host !== null && host === requestHost(req)) return next()
		if (matchOrigin(origin, allow)) return next()
		return reject()
	}

	return namedMiddleware("csrf", mw)
}
