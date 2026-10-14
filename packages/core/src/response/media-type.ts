/**
 * The media-type parser (RFC 9110 §8.3.1) for every place that reads a Content-Type: request
 * body parsing, its content-type check, bodyLimit and negotiation. Type, subtype and parameter
 * names are case-insensitive, so they are lowercased; parameter values keep their case.
 */

export type MediaType = {
	/** `type/subtype`, lowercased, without parameters */
	readonly essence: string
	/** parameters by lowercased name, the first of a repeated name kept; no prototype */
	readonly params: Readonly<Record<string, string>>
	readonly subtype: string
	/** the structured-syntax suffix (`json` for `application/vnd.api+json`), or `null` */
	readonly suffix: string | null
	readonly type: string
}

/** The body parser a request's media type selects. */
export type BodyParser = "json" | "multipart" | "urlencoded"

/* RFC 9110 token characters */
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** Spaces, tabs and `;` between parameters. */
function skipSeparators(value: string, i: number): number {
	let at = i
	while (at < value.length && (value[at] === " " || value[at] === "\t" || value[at] === ";")) at++
	return at
}

/** A quoted-string starting after its opening quote: its unescaped text and where it ended. */
function quoted(value: string, start: number): { end: number; text: string } {
	let text = ""
	let i = start
	while (i < value.length && value[i] !== '"') {
		if (value[i] === "\\" && i + 1 < value.length) i++
		text += value[i]
		i++
	}
	return { end: i + 1, text }
}

/** `; name=value` pairs from `start`; a malformed pair is skipped, as browsers and undici do. */
function parseParams(value: string, start: number, out: Record<string, string>): void {
	let i = skipSeparators(value, start)
	while (i < value.length) {
		const eq = value.indexOf("=", i)
		const semi = value.indexOf(";", i)
		if (eq === -1 || (semi !== -1 && semi < eq)) {
			i = semi === -1 ? value.length : skipSeparators(value, semi + 1)
			continue
		}
		const name = value.slice(i, eq).trim().toLowerCase()
		let text: string
		let next: number
		if (value[eq + 1] === '"') {
			const q = quoted(value, eq + 2)
			text = q.text
			next = value.indexOf(";", q.end)
		} else {
			next = value.indexOf(";", eq + 1)
			text = (next === -1 ? value.slice(eq + 1) : value.slice(eq + 1, next)).trim()
		}
		if (TOKEN.test(name) && !Object.hasOwn(out, name)) out[name] = text
		i = next === -1 ? value.length : skipSeparators(value, next + 1)
	}
}

/**
 * Parse a Content-Type (or any media type). An absent or malformed value is `null`, so a caller
 * never mistakes `application/jsonx` or a bare `json` for JSON.
 */
export function parseMediaType(value: string | null | undefined): MediaType | null {
	if (value === null || value === undefined) return null
	const semi = value.indexOf(";")
	const head = (semi === -1 ? value : value.slice(0, semi)).trim()
	const slash = head.indexOf("/")
	if (slash === -1) return null
	const type = head.slice(0, slash).toLowerCase()
	const subtype = head.slice(slash + 1).toLowerCase()
	if (!TOKEN.test(type) || !TOKEN.test(subtype)) return null
	const plus = subtype.lastIndexOf("+")
	const suffix = plus > 0 && plus < subtype.length - 1 ? subtype.slice(plus + 1) : null
	const params: Record<string, string> = Object.create(null)
	if (semi !== -1) parseParams(value, semi + 1, params)
	return { essence: `${type}/${subtype}`, params, subtype, suffix, type }
}

/** `application/json`, or a `+json` structured-syntax type such as `application/problem+json`. */
export function isJsonMediaType(mt: MediaType | null): boolean {
	return mt !== null && (mt.essence === "application/json" || mt.suffix === "json")
}

/** A text-like body: `text/*`, `application/xml`, or a `+xml` type. */
export function isTextMediaType(mt: MediaType | null): boolean {
	return mt !== null && (mt.type === "text" || mt.essence === "application/xml" || mt.suffix === "xml")
}

/** The body parser a request Content-Type selects, or `null` when none applies. */
export function bodyParserFor(contentType: string | null | undefined): BodyParser | null {
	const mt = parseMediaType(contentType)
	if (mt === null) return null
	if (isJsonMediaType(mt)) return "json"
	if (mt.essence === "multipart/form-data") return "multipart"
	if (mt.essence === "application/x-www-form-urlencoded") return "urlencoded"
	return null
}
