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

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Percent-encode characters outside the RFC 6265 cookie-octet range, plus `%`
 * itself so the value always decodes back to what was set.
 * Cookie-octets: 0x21, 0x23-0x2B, 0x2D-0x3A, 0x3C-0x5B, 0x5D-0x7E
 */
function encodeCookieValue(value: string): string {
	let encoded = ""
	for (const ch of value) {
		const c = ch.codePointAt(0) ?? 0
		if (
			c !== 0x25 &&
			(c === 0x21 ||
				(c >= 0x23 && c <= 0x2b) ||
				(c >= 0x2d && c <= 0x3a) ||
				(c >= 0x3c && c <= 0x5b) ||
				(c >= 0x5d && c <= 0x7e))
		) {
			encoded += ch
		} else if (c >= 0xd800 && c <= 0xdfff) {
			throw new TypeError("Cookie value contains a lone surrogate and cannot be encoded")
		} else {
			encoded += encodeURIComponent(ch)
		}
	}
	return encoded
}

/**
 * Decode `%XX` sequences that form valid UTF-8 and keep every other byte as
 * sent. A stray `%` in a foreign cookie no longer disables decoding for the
 * whole value.
 */
export function decodeCookieValue(value: string): string {
	if (value.indexOf("%") === -1) return value
	try {
		return decodeURIComponent(value)
	} catch {
		return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
			try {
				return decodeURIComponent(run)
			} catch {
				return run
			}
		})
	}
}

/**
 * Parse a `Cookie` request header. When a name repeats, the first value wins:
 * browsers send the cookie with the most specific path first (RFC 6265 §5.4).
 * Names are trimmed on both sides; empty names and prototype keys are skipped.
 */
export function parseCookieHeader(header: string): Record<string, string> {
	const result: Record<string, string> = {}
	if (header.length === 0) return result
	for (const pair of header.split(";")) {
		const eqIdx = pair.indexOf("=")
		if (eqIdx === -1) continue
		const name = pair.slice(0, eqIdx).trim()
		if (name.length === 0 || UNSAFE_KEYS.has(name) || Object.hasOwn(result, name)) continue
		let value = pair.slice(eqIdx + 1).trim()
		/* RFC 6265: strip surrounding double quotes before decoding, so an encoded quote survives. */
		if (value.length >= 2 && value.charCodeAt(0) === 34 && value.charCodeAt(value.length - 1) === 34) {
			value = value.slice(1, -1)
		}
		result[name] = decodeCookieValue(value)
	}
	return result
}

const validCookieNameRe = /^[\w!#$%&'*.^`|~+-]+$/
/* A host name or IP literal, optionally with a leading dot. */
const validDomainRe = /^\.?(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+$|^\[[0-9A-Fa-f:.]+\]$/

export function serializeCookie(name: string, opts: CookieOptions): string {
	if (!validCookieNameRe.test(name)) {
		throw new Error(`Invalid cookie name: ${JSON.stringify(name)}`)
	}

	let secure = opts.secure
	let path = opts.path

	/* Browsers match the prefixes case-insensitively (RFC 6265bis §4.1.3). */
	const lower = name.toLowerCase()
	if (lower.startsWith("__host-")) {
		if (!opts.secure) throw new Error("__Host- cookies require secure: true")
		if (opts.domain) throw new Error("__Host- cookies must not set domain")
		if (opts.path !== "/" && opts.path !== undefined) {
			throw new Error("__Host- cookies must have path: '/'")
		}
		secure = true
		path = path ?? "/"
	} else if (lower.startsWith("__secure-")) {
		if (!opts.secure) throw new Error("__Secure- cookies require secure: true")
		secure = true
	}

	if (opts.sameSite === "none" && !secure) {
		throw new Error("SameSite=None cookies require secure: true")
	}

	if (opts.domain && !validDomainRe.test(opts.domain)) {
		throw new Error("Cookie domain contains invalid characters")
	}
	/* av-value: any CHAR except CTLs or ";" (RFC 6265 §4.1.1). */
	if (path && /[^\x20-\x3a\x3c-\x7e]/.test(path)) {
		throw new Error("Cookie path contains invalid characters")
	}

	let cookie = `${name}=${encodeCookieValue(opts.value)}`
	if (opts.domain) cookie += `; Domain=${opts.domain}`
	if (path) cookie += `; Path=${path}`
	if (opts.maxAge !== undefined) {
		if (!Number.isFinite(opts.maxAge) || opts.maxAge < 0) {
			throw new Error(`Invalid cookie Max-Age: ${opts.maxAge}`)
		}
		/* Clamp so the value prints as digits; browsers cap Max-Age at 400 days anyway. */
		cookie += `; Max-Age=${Math.min(Math.floor(opts.maxAge), Number.MAX_SAFE_INTEGER)}`
	}
	if (opts.expires) {
		if (Number.isNaN(opts.expires.getTime())) {
			throw new Error("Invalid cookie Expires: date is invalid")
		}
		cookie += `; Expires=${opts.expires.toUTCString()}`
	}
	if (opts.httpOnly) cookie += "; HttpOnly"
	if (secure) cookie += "; Secure"
	if (opts.sameSite) cookie += `; SameSite=${opts.sameSite.charAt(0).toUpperCase()}${opts.sameSite.slice(1)}`
	return cookie
}
