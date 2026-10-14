/**
 * The cookie codec: parse a `Cookie` request header and serialize one `Set-Cookie` value. Values
 * are percent-encoded outside the RFC 6265 cookie-octet range so they always decode back to what
 * was set; names, domains and paths are validated so no input can inject an attribute.
 */

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

const validCookieNameRe = /^[\w!#$%&'*.^`|~+-]+$/
/* a host name or IP literal, optionally with a leading dot */
const validDomainRe = /^\.?(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+$|^\[[0-9A-Fa-f:.]+\]$/
/* av-value: any CHAR except CTLs or ";" (RFC 6265 §4.1.1) */
const invalidPathRe = /[^\x20-\x3a\x3c-\x7e]/

/** Cookie-octets: 0x21, 0x23-0x2B, 0x2D-0x3A, 0x3C-0x5B, 0x5D-0x7E; `%` is encoded so it round-trips. */
function isCookieOctet(c: number): boolean {
	if (c === 0x25) return false
	return (
		c === 0x21 ||
		(c >= 0x23 && c <= 0x2b) ||
		(c >= 0x2d && c <= 0x3a) ||
		(c >= 0x3c && c <= 0x5b) ||
		(c >= 0x5d && c <= 0x7e)
	)
}

function encodeCookieValue(value: string): string {
	let encoded = ""
	for (const ch of value) {
		const c = ch.charCodeAt(0)
		if (isCookieOctet(c)) encoded += ch
		/* an astral character is two units; a single unit in the surrogate range is a lone surrogate */ else if (
			ch.length === 1 &&
			c >= 0xd800 &&
			c <= 0xdfff
		)
			throw new TypeError("Cookie value contains a lone surrogate and cannot be encoded")
		else encoded += encodeURIComponent(ch)
	}
	return encoded
}

/**
 * Decode `%XX` sequences that form valid UTF-8 and keep every other byte as sent: a stray `%` in a
 * foreign cookie does not disable decoding for the whole value.
 */
export function decodeCookieValue(value: string): string {
	if (!value.includes("%")) return value
	try {
		return decodeURIComponent(value)
	} catch {
		/* a malformed escape is client data, not a failure: every run that decodes is decoded, the rest kept */
		return value.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
			try {
				return decodeURIComponent(run)
			} catch {
				/* this run is not UTF-8: kept as written */
				return run
			}
		})
	}
}

/**
 * Parse a `Cookie` request header. When a name repeats, the first value wins: browsers send the
 * cookie with the most specific path first (RFC 6265 §5.4). Names are trimmed and empty names
 * skipped. The record has no prototype, so a cookie named like an Object.prototype member is a
 * plain key and nothing else answers to such a name.
 */
export function parseCookieHeader(header: string): Record<string, string> {
	const result: Record<string, string> = Object.create(null)
	if (header.length === 0) return result
	for (const pair of header.split(";")) {
		const eqIdx = pair.indexOf("=")
		if (eqIdx === -1) continue
		const name = pair.slice(0, eqIdx).trim()
		if (name.length === 0 || Object.hasOwn(result, name)) continue
		let value = pair.slice(eqIdx + 1).trim()
		/* RFC 6265: strip surrounding double quotes before decoding, so an encoded quote survives */
		if (value.length >= 2 && value.charCodeAt(0) === 34 && value.charCodeAt(value.length - 1) === 34)
			value = value.slice(1, -1)
		result[name] = decodeCookieValue(value)
	}
	return result
}

/** Apply the `__Host-`/`__Secure-` prefix rules; browsers match them case-insensitively (RFC 6265bis §4.1.3). */
function prefixRules(name: string, opts: CookieOptions): { path: string | undefined; secure: boolean } {
	const lower = name.toLowerCase()
	if (lower.startsWith("__host-")) {
		if (!opts.secure) throw new Error("__Host- cookies require secure: true")
		if (opts.domain) throw new Error("__Host- cookies must not set domain")
		if (opts.path !== "/" && opts.path !== undefined) throw new Error("__Host- cookies must have path: '/'")
		return { path: "/", secure: true }
	}
	if (lower.startsWith("__secure-") && !opts.secure) throw new Error("__Secure- cookies require secure: true")
	return { path: opts.path, secure: opts.secure === true }
}

function validate(opts: CookieOptions, path: string | undefined, secure: boolean): void {
	if (opts.sameSite === "none" && !secure) throw new Error("SameSite=None cookies require secure: true")
	if (opts.domain && !validDomainRe.test(opts.domain)) throw new Error("Cookie domain contains invalid characters")
	if (path && invalidPathRe.test(path)) throw new Error("Cookie path contains invalid characters")
}

/** The Max-Age and Expires attributes, validated. */
function lifetime(opts: CookieOptions): string {
	let out = ""
	if (opts.maxAge !== undefined) {
		if (!Number.isFinite(opts.maxAge) || opts.maxAge < 0) throw new Error(`Invalid cookie Max-Age: ${opts.maxAge}`)
		/* clamp so the value prints as digits; browsers cap Max-Age at 400 days anyway */
		out += `; Max-Age=${Math.min(Math.floor(opts.maxAge), Number.MAX_SAFE_INTEGER)}`
	}
	if (opts.expires) {
		if (Number.isNaN(opts.expires.getTime())) throw new Error("Invalid cookie Expires: date is invalid")
		out += `; Expires=${opts.expires.toUTCString()}`
	}
	return out
}

export function serializeCookie(name: string, opts: CookieOptions): string {
	if (!validCookieNameRe.test(name)) throw new Error(`Invalid cookie name: ${JSON.stringify(name)}`)
	const { path, secure } = prefixRules(name, opts)
	validate(opts, path, secure)
	let cookie = `${name}=${encodeCookieValue(opts.value)}`
	if (opts.domain) cookie += `; Domain=${opts.domain}`
	if (path) cookie += `; Path=${path}`
	cookie += lifetime(opts)
	if (opts.httpOnly) cookie += "; HttpOnly"
	if (secure) cookie += "; Secure"
	if (opts.sameSite) cookie += `; SameSite=${opts.sameSite.charAt(0).toUpperCase()}${opts.sameSite.slice(1)}`
	return cookie
}
