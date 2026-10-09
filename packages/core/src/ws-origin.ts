/**
 * Which browser origins may open a WebSocket. A browser lets any page open a socket to any host
 * and sends that host's cookies with it, so a cookie-authenticated socket is open to cross-site
 * hijacking unless the server checks `Origin`.
 *
 * - `"*"`: every origin.
 * - a list: those exact origins (`https://app.example.com`), plus same-origin.
 * - a function: called with the `Origin` value; same-origin always passes.
 * - unset (the default): same-origin always passes; a cross-origin upgrade is rejected when it
 *   carries credentials (`Cookie` or `Authorization`), since that is what hijacking needs. A
 *   request without `Origin` (not a browser) passes.
 */
export type WSOriginPolicy = "*" | readonly string[] | ((origin: string) => boolean)

function originHost(origin: string): string | null {
	if (origin === "null") return null
	try {
		return new URL(origin).host.toLowerCase()
	} catch {
		return null
	}
}

export function validateOriginPolicy(policy: unknown): WSOriginPolicy {
	if (policy === "*" || typeof policy === "function") return policy as WSOriginPolicy
	if (Array.isArray(policy) && policy.every((o) => typeof o === "string")) {
		for (const o of policy as string[]) {
			if (originHost(o) === null)
				throw new TypeError(`allowedOrigins: "${o}" is not an origin like https://example.com`)
		}
		return Object.freeze([...(policy as string[])])
	}
	throw new TypeError('allowedOrigins must be "*", a list of origins, or a function')
}

/**
 * Whether an upgrade from `origin` may proceed. `host` is the host the client asked for
 * (`clientInfo(ctx).host`, which follows `trustProxy`).
 */
export function originAllowed(
	policy: WSOriginPolicy | null,
	origin: string | null,
	host: string | null,
	hasCredentials: boolean,
): boolean {
	if (policy === "*") return true
	if (origin === null) return true
	const oh = originHost(origin)
	if (oh !== null && host !== null && oh === host.toLowerCase()) return true
	if (policy === null) return !hasCredentials
	if (typeof policy === "function") return policy(origin) === true
	return policy.includes(origin)
}
