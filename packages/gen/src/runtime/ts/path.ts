/**
 * Client-side path templates. Two spellings are accepted, segment by segment:
 *
 * - Honey route patterns: `:name` (or `:name?`) takes a whole segment, `*name` (or `*`) takes the
 *   rest of the path. Names follow the router grammar, so `:user-id` is one parameter.
 * - OpenAPI templates: `{name}` anywhere inside a segment (`/ops/{id}:cancel`).
 *
 * Values are percent-encoded. A value that would change the path's shape once a URL parser
 * normalizes it (`""`, `.`, `..`) is rejected, so `{ id: ".." }` can never retarget a request to
 * the parent resource and `{ org: "" }` can never turn `/:org/:repo` into `//repo`.
 */

/** A fresh `{name}` placeholder matcher: a global regex carries `lastIndex`, so none is shared. */
const braces = () => /\{([^{}/]+)\}/g

export class PathParamError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "PathParamError"
	}
}

function paramValue(params: Record<string, unknown>, key: string): string | undefined {
	const raw = Object.hasOwn(params, key) ? params[key] : undefined
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

/** One `:name`/`:name?` segment, `null` when an optional one is left out. */
function paramSegment(seg: string, params: Record<string, unknown>): string | null {
	const optional = seg.endsWith("?")
	const name = optional ? seg.slice(1, -1) : seg.slice(1)
	const value = paramValue(params, name)
	if (value !== undefined) return encodeSegmentValue(name, value)
	if (optional) return null
	throw new PathParamError(`Missing path param: ${name}`)
}

/** The trailing `*`/`*name` segment: an unnamed one may be left empty. */
function wildcardSegment(seg: string, params: Record<string, unknown>): string {
	const name = seg.length > 1 ? seg.slice(1) : "*"
	const value = paramValue(params, name)
	if (value !== undefined) return encodeWildcardValue(name, value)
	if (seg.length === 1) return ""
	throw new PathParamError(`Missing path param: ${name}`)
}

export function interpolatePath(path: string, params: Record<string, unknown> = {}): string {
	const segments = path.split("/")
	const out: string[] = []
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i] as string
		if (seg.length > 1 && seg.charCodeAt(0) === 58 /* : */) {
			const value = paramSegment(seg, params)
			if (value !== null) out.push(value)
		} else if (seg.charCodeAt(0) === 42 /* * */ && i === segments.length - 1) out.push(wildcardSegment(seg, params))
		else {
			out.push(
				seg.replace(braces(), (_, name: string) => {
					const value = paramValue(params, name)
					if (value === undefined) throw new PathParamError(`Missing path param: ${name}`)
					return encodeSegmentValue(name, value)
				}),
			)
		}
	}
	return out.join("/")
}

/** True when the template still has a placeholder in either spelling. */
export function hasPlaceholder(path: string): boolean {
	for (const seg of path.split("/")) {
		if (seg.length > 1 && seg.charCodeAt(0) === 58) return true
		if (seg.charCodeAt(0) === 42) return true
		if (braces().test(seg)) return true
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
				const value = paramValue(params, name)
				return value === undefined ? seg : encodeSegmentValue(name, value)
			}
			if (seg.charCodeAt(0) === 42 && i === all.length - 1) {
				const value = paramValue(params, seg.length > 1 ? seg.slice(1) : "*")
				return value === undefined ? seg : encodeWildcardValue(seg.slice(1), value)
			}
			return seg.replace(braces(), (match, name: string) => {
				const value = paramValue(params, name)
				return value === undefined ? match : encodeSegmentValue(name, value)
			})
		})
		.join("/")
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** The regex source of one literal segment, its `{name}` placeholders matching one segment's text. */
function literalSource(seg: string): string {
	let source = ""
	let last = 0
	const brace = braces()
	for (let m = brace.exec(seg); m !== null; m = brace.exec(seg)) {
		source += `${escapeRegExp(seg.slice(last, m.index))}[^/]+`
		last = m.index + m[0].length
	}
	return source + escapeRegExp(seg.slice(last))
}

/** Compile a template to a regex over concrete paths, using the same segment grammar; the caller caches it. */
export function compilePattern(pattern: string): RegExp {
	const segments = pattern.split("/")
	let source = ""
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i] as string
		const sep = i === 0 ? "" : "/"
		if (seg.length > 1 && seg.charCodeAt(0) === 58) source += seg.endsWith("?") ? `(?:${sep}[^/]+)?` : `${sep}[^/]+`
		else if (seg.charCodeAt(0) === 42 && i === segments.length - 1) source += `(?:${sep}.*)?`
		else source += sep + literalSource(seg)
	}
	return new RegExp(`^${source}$`)
}
