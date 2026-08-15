export type CookieOptions = {
	domain?: string
	expires?: Date
	httpOnly?: boolean
	maxAge?: number
	path?: string
	sameSite?: "lax" | "none" | "strict"
	secure?: boolean
	value: string
}

/**
 * Percent-encode characters outside the RFC 6265 cookie-octet range.
 * Cookie-octets: 0x21, 0x23-0x2B, 0x2D-0x3A, 0x3C-0x5B, 0x5D-0x7E
 */
function encodeCookieValue(value: string): string {
	let encoded = ""
	for (const ch of value) {
		const c = ch.codePointAt(0) ?? 0
		if (
			c === 0x21 ||
			(c >= 0x23 && c <= 0x2b) ||
			(c >= 0x2d && c <= 0x3a) ||
			(c >= 0x3c && c <= 0x5b) ||
			(c >= 0x5d && c <= 0x7e)
		) {
			encoded += ch
		} else {
			encoded += encodeURIComponent(ch)
		}
	}
	return encoded
}

const validCookieNameRe = /^[\w!#$%&'*.^`|~+-]+$/

export function serializeCookie(name: string, opts: CookieOptions): string {
	if (!validCookieNameRe.test(name)) {
		throw new Error(`Invalid cookie name: ${JSON.stringify(name)}`)
	}

	let secure = opts.secure
	let path = opts.path

	if (name.startsWith("__Host-")) {
		if (!opts.secure) throw new Error("__Host- cookies require secure: true")
		if (opts.domain) throw new Error("__Host- cookies must not set domain")
		if (opts.path !== "/" && opts.path !== undefined) {
			throw new Error("__Host- cookies must have path: '/'")
		}
		secure = true
		path = path ?? "/"
	} else if (name.startsWith("__Secure-")) {
		if (!opts.secure) throw new Error("__Secure- cookies require secure: true")
		secure = true
	}

	if (opts.sameSite === "none" && !secure) {
		throw new Error("SameSite=None cookies require secure: true")
	}

	if (opts.domain && /[;\r\n]/.test(opts.domain)) {
		throw new Error("Cookie domain contains invalid characters")
	}
	if (path && /[;\r\n]/.test(path)) {
		throw new Error("Cookie path contains invalid characters")
	}

	let cookie = `${name}=${encodeCookieValue(opts.value)}`
	if (opts.domain) cookie += `; Domain=${opts.domain}`
	if (path) cookie += `; Path=${path}`
	if (opts.maxAge !== undefined) {
		if (!Number.isFinite(opts.maxAge) || opts.maxAge < 0) {
			throw new Error(`Invalid cookie Max-Age: ${opts.maxAge}`)
		}
		cookie += `; Max-Age=${Math.floor(opts.maxAge)}`
	}
	if (opts.expires) {
		if (Number.isNaN(opts.expires.getTime())) {
			throw new Error("Invalid cookie Expires: date is invalid")
		}
		cookie += `; Expires=${opts.expires.toUTCString()}`
	}
	if (opts.httpOnly) cookie += "; HttpOnly"
	if (secure) cookie += "; Secure"
	if (opts.sameSite)
		cookie += `; SameSite=${opts.sameSite.charAt(0).toUpperCase()}${opts.sameSite.slice(1)}`
	return cookie
}
