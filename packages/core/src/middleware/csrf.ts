/**
 * `csrf(options)`: refuse cross-origin unsafe requests, whatever their content type, as Go's
 * `http.CrossOriginProtection` does.
 *
 * 1. `GET`, `HEAD` and `OPTIONS` pass.
 * 2. With `Sec-Fetch-Site` (every current browser sends it): `same-origin` and `none`
 *    (user-initiated) pass; `same-site` and `cross-site` pass only for an allow-listed `Origin`. A
 *    sibling subdomain is same-site, not trusted.
 * 3. Without it: no `Origin` passes (curl, a server); an `Origin` on the request's own host passes;
 *    an allow-listed one passes; anything else, the opaque `null` included, does not.
 *
 * A refusal is a 403 `forbidden`, declared on the middleware.
 */
import { HoneyError } from "../errors/error.ts"
import { type MiddlewareFn, namedMiddleware } from "./middleware.ts"

export type CSRFOptions = {
	/**
	 * Cross-origin callers allowed to make unsafe requests, matched exactly against the full `Origin`
	 * (`https://app.example.com`). Same-origin requests never need listing.
	 */
	origin?: ((origin: string) => boolean) | string | readonly string[]
}

function isSafe(method: string): boolean {
	return method === "GET" || method === "HEAD" || method === "OPTIONS"
}

function allowListed(origin: string, allow: CSRFOptions["origin"]): boolean {
	if (allow === undefined) return false
	if (typeof allow === "string") return allow === origin
	if (typeof allow === "function") return allow(origin)
	return allow.includes(origin)
}

/** `origin`'s host as a URL spells it, or `null` for the opaque origin or one that is no URL. */
function hostOf(origin: string): string | null {
	if (origin === "null") return null
	try {
		return new URL(origin).host
	} catch {
		/* not a URL: an Origin no host matches, which the caller refuses */
		return null
	}
}

function forbidden(): never {
	throw new HoneyError({ errorKey: "forbidden", status: "forbidden" })
}

export function csrf(options: CSRFOptions = {}): MiddlewareFn<{ req: Request }, {}, "forbidden"> {
	const allow = options.origin
	const mw: MiddlewareFn<{ req: Request }, {}, "forbidden"> = (ctx, next) => {
		const req = ctx.req
		if (isSafe(req.method)) return next()
		const origin = req.headers.get("origin")
		const site = req.headers.get("sec-fetch-site")
		if (site !== null) {
			if (site === "same-origin" || site === "none") return next()
			return origin !== null && allowListed(origin, allow) ? next() : forbidden()
		}
		if (origin === null) return next()
		/* the request URL is the canonical one the adapter built: its host is the one the client addressed */
		if (hostOf(origin) === new URL(req.url).host) return next()
		return allowListed(origin, allow) ? next() : forbidden()
	}
	mw.errors = ["forbidden"]
	return namedMiddleware("csrf", mw)
}
