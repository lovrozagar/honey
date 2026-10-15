/** A `Content-Type`, read as far as the client needs it: its essence, type and structured suffix. */
export type MediaType = {
	/** `type/subtype`, lowercased, without parameters */
	essence: string
	/** the structured-syntax suffix (`json` for `application/vnd.api+json`), or `null` */
	suffix: string | null
	type: string
}

/* RFC 9110 token characters */
const MEDIA_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** `value` as a media type; `null` when it is missing or not `token/token`. */
export function parseMediaType(value: string | null | undefined): MediaType | null {
	if (value === null || value === undefined) return null
	const semi = value.indexOf(";")
	const head = (semi === -1 ? value : value.slice(0, semi)).trim()
	const slash = head.indexOf("/")
	if (slash === -1) return null
	const type = head.slice(0, slash).toLowerCase()
	const subtype = head.slice(slash + 1).toLowerCase()
	if (!MEDIA_TOKEN.test(type) || !MEDIA_TOKEN.test(subtype)) return null
	const plus = subtype.lastIndexOf("+")
	const suffix = plus > 0 && plus < subtype.length - 1 ? subtype.slice(plus + 1) : null
	return { essence: `${type}/${subtype}`, suffix, type }
}

/** JSON bodies: `application/json` and any `+json` type. */
export function isJsonMediaType(mt: MediaType | null): boolean {
	return mt !== null && (mt.essence === "application/json" || mt.suffix === "json")
}

/** Text-like bodies: `text/*`, `application/xml`, and any `+xml` type. */
export function isTextMediaType(mt: MediaType | null): boolean {
	return mt !== null && (mt.type === "text" || mt.essence === "application/xml" || mt.suffix === "xml")
}
