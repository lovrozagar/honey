/**
 * One media-type parser (RFC 9110 §8.3.1) for every place that reads a `Content-Type`:
 * input validation, `bodyLimit`, and the client. Type, subtype and parameter names are
 * case-insensitive, so they are lowercased; parameter values keep their case.
 *
 * Pure and dependency-free: the client entry imports it too.
 */

export type MediaType = {
	/** `type/subtype`, lowercased, without parameters */
	essence: string
	/** parameters by lowercased name; a repeated name keeps the first value */
	params: Record<string, string>
	subtype: string
	/** the structured-syntax suffix (`json` for `application/vnd.api+json`), or `null` */
	suffix: string | null
	type: string
}

/* RFC 9110 token characters */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

function isToken(s: string): boolean {
	return s.length > 0 && TOKEN.test(s)
}

/**
 * Parses a `Content-Type` (or any media type) value. Returns `null` for an absent or
 * malformed value, so a caller never mistakes `application/jsonx` or `json` for JSON.
 */
export function parseMediaType(value: string | null | undefined): MediaType | null {
	if (value === null || value === undefined) return null
	const semi = value.indexOf(";")
	const head = (semi === -1 ? value : value.slice(0, semi)).trim()
	const slash = head.indexOf("/")
	if (slash === -1) return null
	const type = head.slice(0, slash).toLowerCase()
	const subtype = head.slice(slash + 1).toLowerCase()
	if (!isToken(type) || !isToken(subtype)) return null
	const plus = subtype.lastIndexOf("+")
	const suffix = plus > 0 && plus < subtype.length - 1 ? subtype.slice(plus + 1) : null
	const params = Object.create(null) as Record<string, string>
	if (semi !== -1) parseParams(value, semi + 1, params)
	return { essence: `${type}/${subtype}`, params, subtype, suffix, type }
}

/* `; name=value` pairs; value is a token or a quoted-string. Malformed pairs are skipped,
 * as browsers and undici do, rather than rejecting the whole header. */
function parseParams(value: string, start: number, out: Record<string, string>): void {
	let i = start
	const n = value.length
	while (i < n) {
		while (i < n && (value[i] === " " || value[i] === "\t" || value[i] === ";")) i++
		const eq = value.indexOf("=", i)
		const nextSemi = value.indexOf(";", i)
		if (eq === -1 || (nextSemi !== -1 && nextSemi < eq)) {
			i = nextSemi === -1 ? n : nextSemi + 1
			continue
		}
		const name = value.slice(i, eq).trim().toLowerCase()
		i = eq + 1
		let v: string
		if (value[i] === '"') {
			i++
			let buf = ""
			while (i < n && value[i] !== '"') {
				if (value[i] === "\\" && i + 1 < n) i++
				buf += value[i]
				i++
			}
			v = buf
			i++ /* closing quote */
			const after = value.indexOf(";", i)
			i = after === -1 ? n : after + 1
		} else {
			const end = value.indexOf(";", i)
			v = (end === -1 ? value.slice(i) : value.slice(i, end)).trim()
			i = end === -1 ? n : end + 1
		}
		if (isToken(name) && !(name in out)) out[name] = v
	}
}

/** `application/json`, or any `+json` structured-syntax type (`application/problem+json`). */
export function isJsonMediaType(mt: MediaType | null): boolean {
	return mt !== null && (mt.essence === "application/json" || mt.suffix === "json")
}

/** Text-like bodies: `text/*`, `application/xml`, and any `+xml` type. */
export function isTextMediaType(mt: MediaType | null): boolean {
	return mt !== null && (mt.type === "text" || mt.essence === "application/xml" || mt.suffix === "xml")
}

export type BodyParser = "json" | "multipart" | "urlencoded"

/** Which body parser a request `Content-Type` selects, or `null` when none applies. */
export function bodyParserFor(contentType: string | null | undefined): BodyParser | null {
	const mt = parseMediaType(contentType)
	if (mt === null) return null
	if (isJsonMediaType(mt)) return "json"
	if (mt.essence === "multipart/form-data") return "multipart"
	if (mt.essence === "application/x-www-form-urlencoded") return "urlencoded"
	return null
}
