type ParsedType = {
	/** Position in the header, for stable tie-breaking. */
	index: number
	/** Number of media-type parameters other than q (more parameters = more specific). */
	params: number
	q: number
	subtype: string
	type: string
}

/** RFC 9110 §12.4.2: qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] ). Lenient on digit count. */
function parseQ(raw: string): number | null {
	if (!/^(?:0(?:\.\d*)?|1(?:\.0*)?|\.\d+)$/.test(raw)) return null
	const q = Number(raw)
	return q >= 0 && q <= 1 ? q : null
}

function parseAccept(header: string): ParsedType[] {
	const types: ParsedType[] = []
	const parts = header.split(",")
	for (let index = 0; index < parts.length; index++) {
		const trimmed = parts[index].trim()
		if (trimmed.length === 0) continue

		const segments = trimmed.split(";")
		const mediaType = segments[0].trim().toLowerCase()
		const slash = mediaType.indexOf("/")
		if (slash <= 0 || slash === mediaType.length - 1) continue
		const type = mediaType.slice(0, slash)
		const subtype = mediaType.slice(slash + 1)
		/* `*\/html` is not a valid range. */
		if (type === "*" && subtype !== "*") continue

		let q = 1
		let params = 0
		for (let i = 1; i < segments.length; i++) {
			const eq = segments[i].indexOf("=")
			if (eq === -1) continue
			const name = segments[i].slice(0, eq).trim().toLowerCase()
			const value = segments[i].slice(eq + 1).trim()
			if (name === "q") {
				const parsed = parseQ(value)
				/* An unparsable weight makes the whole range unusable rather than silently q=1. */
				q = parsed ?? 0
				/* Parameters after q are accept-extensions, not media-type parameters. */
				break
			}
			params++
		}

		types.push({ index, params, q, subtype, type })
	}
	return types
}

/** 0 = no match; otherwise higher is more specific. */
function specificity(range: ParsedType, sType: string, sSub: string): number {
	if (range.type === "*") return 1
	if (range.type !== sType) return 0
	if (range.subtype === "*") return 2
	if (range.subtype !== sSub) return 0
	return 3 + range.params
}

/**
 * Pick the best supported content type based on the request's Accept header.
 *
 * Each supported type takes the weight of the most specific range that matches
 * it (RFC 9110 §12.5.1), so `text/html;q=0, *\/*` excludes `text/html`. Among
 * types with equal weight, the server's order in `supported` wins.
 *
 * Returns null if no match found. Returns the first supported type if there is
 * no Accept header.
 */
export function accepts(req: Request, supported: string[]): string | null {
	const header = req.headers.get("accept")
	if (header === null || header.trim().length === 0) {
		return supported[0] ?? null
	}

	const parsed = parseAccept(header)
	if (parsed.length === 0) {
		return supported[0] ?? null
	}

	let bestMatch: string | null = null
	let bestQ = 0

	for (const s of supported) {
		const lower = s.toLowerCase()
		const slash = lower.indexOf("/")
		if (slash === -1) continue
		const sType = lower.slice(0, slash)
		const sSub = lower
			.slice(slash + 1)
			.split(";")[0]
			.trim()

		let weight = -1
		let bestSpecificity = 0
		for (const range of parsed) {
			const spec = specificity(range, sType, sSub)
			if (spec > bestSpecificity) {
				bestSpecificity = spec
				weight = range.q
			}
		}
		if (weight > bestQ) {
			bestQ = weight
			bestMatch = s
		}
	}

	return bestMatch
}
