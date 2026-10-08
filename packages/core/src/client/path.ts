/**
 * Client-side path templates. Two spellings are accepted, segment by segment:
 *
 * - Honey route patterns: `:name` (or `:name?`) takes a whole segment, `*name` (or `*`)
 *   takes the rest of the path. Names follow the router grammar, so `:user-id` is one
 *   parameter.
 * - OpenAPI templates: `{name}` anywhere inside a segment (`/ops/{id}:cancel`).
 *
 * Values are percent-encoded. A value that would change the path's shape once a URL parser
 * normalizes it (`""`, `.`, `..`) is rejected, so `{ id: ".." }` can never retarget a request
 * to the parent resource and `{ org: "" }` can never turn `/:org/:repo` into `//repo`.
 */

const BRACE_RE = /\{([^{}/]+)\}/g

export class PathParamError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "PathParamError"
	}
}

function own(params: Record<string, unknown>, key: string): unknown {
	return Object.hasOwn(params, key) ? params[key] : undefined
}

function toValue(params: Record<string, unknown>, key: string): string | undefined {
	const raw = own(params, key)
	if (raw === undefined || raw === null) return undefined
	return typeof raw === "string" ? raw : String(raw)
}

function encodeSegmentValue(key: string, value: string): string {
	if (value === "" || value === "." || value === "..") {
		throw new PathParamError(
			`Invalid path param ${JSON.stringify(key)}: ${JSON.stringify(value)} is not a path segment`,
		)
	}
	return encodeURIComponent(value)
}

/** A wildcard value may span segments; each one is encoded and validated on its own. */
function encodeWildcardValue(key: string, value: string): string {
	if (value === "") return ""
	return value
		.split("/")
		.map((part) => encodeSegmentValue(key, part))
		.join("/")
}

export function interpolatePath(path: string, params: Record<string, unknown> = {}): string {
	const segments = path.split("/")
	const out: string[] = []
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]
		if (seg.length > 1 && seg.charCodeAt(0) === 58 /* : */) {
			const optional = seg.endsWith("?")
			const name = optional ? seg.slice(1, -1) : seg.slice(1)
			const value = toValue(params, name)
			if (value === undefined) {
				if (optional) continue
				throw new PathParamError(`Missing path param: ${name}`)
			}
			out.push(encodeSegmentValue(name, value))
			continue
		}
		if (seg.charCodeAt(0) === 42 /* * */ && i === segments.length - 1) {
			const name = seg.length > 1 ? seg.slice(1) : "*"
			const value = toValue(params, name)
			if (value === undefined) {
				if (seg.length === 1) {
					out.push("")
					continue
				}
				throw new PathParamError(`Missing path param: ${name}`)
			}
			out.push(encodeWildcardValue(name, value))
			continue
		}
		out.push(
			seg.replace(BRACE_RE, (_, name: string) => {
				const value = toValue(params, name)
				if (value === undefined) throw new PathParamError(`Missing path param: ${name}`)
				return encodeSegmentValue(name, value)
			}),
		)
	}
	return out.join("/")
}

/** True when the template still has a placeholder in either spelling. */
export function hasPlaceholder(path: string): boolean {
	for (const seg of path.split("/")) {
		if (seg.length > 1 && seg.charCodeAt(0) === 58) return true
		if (seg.charCodeAt(0) === 42) return true
		BRACE_RE.lastIndex = 0
		if (BRACE_RE.test(seg)) return true
	}
	return false
}

/**
 * Substitute the params that are present and leave the others as placeholders. Used for
 * invalidation targets, where a partially resolved target is still a narrower pattern.
 */
export function interpolatePartial(path: string, params: Record<string, unknown>): string {
	return path
		.split("/")
		.map((seg, i, all) => {
			if (seg.length > 1 && seg.charCodeAt(0) === 58) {
				const optional = seg.endsWith("?")
				const name = optional ? seg.slice(1, -1) : seg.slice(1)
				const value = toValue(params, name)
				return value === undefined ? seg : encodeSegmentValue(name, value)
			}
			if (seg.charCodeAt(0) === 42 && i === all.length - 1) {
				const value = toValue(params, seg.length > 1 ? seg.slice(1) : "*")
				return value === undefined ? seg : encodeWildcardValue(seg.slice(1), value)
			}
			return seg.replace(BRACE_RE, (match, name: string) => {
				const value = toValue(params, name)
				return value === undefined ? match : encodeSegmentValue(name, value)
			})
		})
		.join("/")
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const MAX_CACHED_PATTERNS = 1024
const patternCache = new Map<string, RegExp>()

/** Compile a template to a regex over concrete paths, using the same segment grammar. */
export function compilePattern(pattern: string): RegExp {
	let re = patternCache.get(pattern)
	if (re !== undefined) return re
	const segments = pattern.split("/")
	let source = ""
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]
		const sep = i === 0 ? "" : "/"
		if (seg.length > 1 && seg.charCodeAt(0) === 58) {
			source += seg.endsWith("?") ? `(?:${sep}[^/]+)?` : `${sep}[^/]+`
			continue
		}
		if (seg.charCodeAt(0) === 42 && i === segments.length - 1) {
			source += `(?:${sep}.*)?`
			continue
		}
		let segSource = ""
		let last = 0
		BRACE_RE.lastIndex = 0
		for (let m = BRACE_RE.exec(seg); m !== null; m = BRACE_RE.exec(seg)) {
			segSource += `${escapeRegExp(seg.slice(last, m.index))}[^/]+`
			last = m.index + m[0].length
		}
		segSource += escapeRegExp(seg.slice(last))
		source += sep + segSource
	}
	re = new RegExp(`^${source}$`)
	if (patternCache.size >= MAX_CACHED_PATTERNS) {
		const oldest = patternCache.keys().next().value
		if (oldest !== undefined) patternCache.delete(oldest)
	}
	patternCache.set(pattern, re)
	return re
}
