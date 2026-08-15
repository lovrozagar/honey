type ParsedType = {
	q: number
	subtype: string
	type: string
}

function parseAccept(header: string): ParsedType[] {
	const types: ParsedType[] = []
	for (const part of header.split(",")) {
		const trimmed = part.trim()
		if (trimmed.length === 0) continue

		const segments = trimmed.split(";")
		const mediaType = segments[0].trim()
		const slash = mediaType.indexOf("/")
		if (slash === -1) continue

		let q = 1.0
		for (let i = 1; i < segments.length; i++) {
			const param = segments[i].trim()
			if (param.startsWith("q=")) {
				const parsed = Number.parseFloat(param.slice(2))
				if (!Number.isNaN(parsed)) q = parsed
			}
		}

		types.push({
			q,
			subtype: mediaType.slice(slash + 1).toLowerCase(),
			type: mediaType.slice(0, slash).toLowerCase(),
		})
	}
	return types.sort((a, b) => b.q - a.q)
}

function matches(accept: ParsedType, supported: string): boolean {
	const slash = supported.indexOf("/")
	if (slash === -1) return false
	const sType = supported.slice(0, slash)
	const sSub = supported.slice(slash + 1)

	if (accept.type === "*" && accept.subtype === "*") return true
	if (accept.type === sType && accept.subtype === "*") return true
	return accept.type === sType && accept.subtype === sSub
}

/**
 * Pick the best supported content type based on the request's Accept header.
 * Returns null if no match found. Returns first supported type if no Accept header.
 */
export function accepts(req: Request, supported: string[]): string | null {
	const header = req.headers.get("accept")
	if (header === null || header.length === 0) {
		return supported[0] ?? null
	}

	const parsed = parseAccept(header)
	if (parsed.length === 0) {
		return supported[0] ?? null
	}

	/* for each supported type (server preference order), find best q match */
	let bestMatch: string | null = null
	let bestQ = -1

	for (const s of supported) {
		for (const accept of parsed) {
			if (accept.q === 0) continue
			if (matches(accept, s) && accept.q > bestQ) {
				bestQ = accept.q
				bestMatch = s
				break
			}
		}
	}

	return bestMatch
}
