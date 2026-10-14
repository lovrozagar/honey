/**
 * Content negotiation over the Accept header (RFC 9110 §12.5.1): which of the types a handler can
 * answer with the client prefers. Each supported type takes the weight of the most specific range
 * that matches it, so `text/html;q=0, *\/*` excludes `text/html`; equal weights go to the server's
 * order. A plain function: nothing is registered, nothing is cached.
 */
import { parseMediaType } from "../response/media-type.ts"

/** One media range of an Accept header. */
type Range = {
	/** media-type parameters before `q`, names lowercased; a range with any matches only types carrying them all */
	readonly params: ReadonlyMap<string, string>
	readonly q: number
	readonly subtype: string
	readonly type: string
}

/* RFC 9110 §12.4.2 qvalue, lenient on the digit count and a missing leading zero */
const QVALUE = /^(?:0(?:\.\d*)?|1(?:\.0*)?|\.\d+)$/

/** A weight, or 0 for one out of range or malformed: such a range is unusable, never q=1. */
function weight(raw: string): number {
	return QVALUE.test(raw) ? Number(raw) : 0
}

function unquote(value: string): string {
	return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
}

/** One comma-separated part of the header, or `null` when it is no media range (`*\/html` included). */
function parseRange(part: string): Range | null {
	const segments = part.split(";")
	const head = (segments[0] as string).trim().toLowerCase()
	const slash = head.indexOf("/")
	if (slash <= 0 || slash === head.length - 1) return null
	const type = head.slice(0, slash)
	const subtype = head.slice(slash + 1)
	if (type === "*" && subtype !== "*") return null
	const params = new Map<string, string>()
	let q = 1
	for (const segment of segments.slice(1)) {
		const eq = segment.indexOf("=")
		if (eq === -1) continue
		const name = segment.slice(0, eq).trim().toLowerCase()
		const value = segment.slice(eq + 1).trim()
		/* what follows q is an accept extension, never a media-type parameter */
		if (name === "q") {
			q = weight(value)
			break
		}
		params.set(name, unquote(value))
	}
	return { params, q, subtype, type }
}

function parseAccept(header: string): Range[] {
	const ranges: Range[] = []
	for (const part of header.split(",")) {
		const range = part.trim().length === 0 ? null : parseRange(part)
		if (range !== null) ranges.push(range)
	}
	return ranges
}

/** How specifically `range` matches the supported type: 0 not at all, higher the more specific. */
function specificity(range: Range, type: string, subtype: string, params: Readonly<Record<string, string>>): number {
	if (range.type === "*") return 1
	if (range.type !== type) return 0
	if (range.subtype === "*") return 2
	if (range.subtype !== subtype) return 0
	for (const [name, value] of range.params) {
		if (params[name] !== value) return 0
	}
	return 3 + range.params.size
}

/** The weight the client gives `supported`: that of its most specific matching range, or -1 for none. */
function weightOf(ranges: readonly Range[], supported: string): number {
	const media = parseMediaType(supported)
	if (media === null) return -1
	let best = 0
	let q = -1
	for (const range of ranges) {
		const spec = specificity(range, media.type, media.subtype, media.params)
		if (spec > best) {
			best = spec
			q = range.q
		}
	}
	return q
}

/**
 * The supported type the request's Accept header prefers, as `supported` spells it; `null` when
 * the client accepts none of them. No Accept header, or one with no usable range, takes the first.
 */
export function accepts<const T extends string>(req: Request, supported: readonly T[]): T | null {
	const header = req.headers.get("accept")
	const ranges = header === null ? [] : parseAccept(header)
	if (ranges.length === 0) return supported[0] ?? null
	let match: T | null = null
	let top = 0
	for (const type of supported) {
		const q = weightOf(ranges, type)
		if (q > top) {
			top = q
			match = type
		}
	}
	return match
}
