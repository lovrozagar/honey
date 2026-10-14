/**
 * Which browser origins may open a WebSocket. A browser lets any page open a socket to any host
 * and sends that host's cookies with it, so a cookie-authenticated socket is open to cross-site
 * hijacking unless the server checks `Origin`.
 *
 * - `"*"`: every origin.
 * - a list: those exact origins (scheme, host and port), plus same-origin.
 * - a function: called with the `Origin` value; same-origin always passes.
 * - unset (the default): same-origin passes; a cross-origin upgrade carrying credentials (`Cookie`
 *   or `Authorization`, what hijacking needs) is rejected. A request without `Origin` (not a
 *   browser) passes.
 *
 * Same-origin is the full origin (H18.12): an `http://` page is not same-origin to an `https`
 * server. Behind a TLS terminator the server sees plain http, so the shortcut fails closed there:
 * such an app lists its origins.
 */
export type WSOriginPolicy = "*" | readonly string[] | ((origin: string) => boolean)

/** `URL.parse` without it: Node 20 lacks it. */
function parseUrl(text: string): URL | null {
	try {
		return new URL(text)
	} catch {
		/* not a URL: an Origin no policy can match, which the caller refuses */
		return null
	}
}

/** An origin's canonical spelling (lowercase, default port dropped), or `null` for `"null"` or a non-URL. */
function canonicalOrigin(text: string): string | null {
	const origin = parseUrl(text)?.origin
	return origin === undefined || origin === "null" ? null : origin
}

/** A list entry: exactly an origin, normalized. A path, query or fragment means it is not one. */
function listedOrigin(entry: string): string {
	const url = parseUrl(entry)
	const origin = url === null || url.origin === "null" ? null : url.origin
	if (origin === null || url?.pathname !== "/" || url.search !== "" || url.hash !== "") {
		throw new TypeError(`allowedOrigins: "${entry}" is not an origin like https://example.com`)
	}
	return origin
}

export function validateOriginPolicy(policy: unknown): WSOriginPolicy {
	if (policy === "*" || typeof policy === "function") return policy as WSOriginPolicy
	if (Array.isArray(policy) && policy.every((entry) => typeof entry === "string")) {
		return Object.freeze(policy.map(listedOrigin))
	}
	throw new TypeError('allowedOrigins must be "*", a list of origins, or a function')
}

/**
 * Whether an upgrade from `origin` (the `Origin` header, `null` when absent) may proceed against a
 * server whose own origin is `serverOrigin` (`new URL(req.url).origin`).
 */
export function originAllowed(
	policy: WSOriginPolicy | null,
	origin: string | null,
	serverOrigin: string,
	hasCredentials: boolean,
): boolean {
	if (policy === "*" || origin === null) return true
	const canonical = canonicalOrigin(origin)
	if (canonical === serverOrigin) return true
	if (policy === null) return !hasCredentials
	if (typeof policy === "function") return policy(origin) === true
	return canonical !== null && policy.includes(canonical)
}
