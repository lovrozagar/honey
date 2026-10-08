/**
 * The one route-pattern grammar. Registration, the router tree, scope matching, codegen
 * selectors and OpenAPI paths all consume the parsed form; nothing re-derives params from
 * a pattern string with its own regex.
 *
 *     pattern  = "/" | ("/" segment)+ ["/"]
 *     segment  = static | param | wildcard
 *     param    = ":" name ["?"]        optional only as the last segment
 *     wildcard = "*" [name]            last segment only; unnamed is called "*"
 *     name     = [A-Za-z_$][A-Za-z0-9_$-]*
 *
 * Empty segments are dropped (`//a` is `/a`), a trailing slash is not significant, and a
 * pattern without a leading slash gets one. `.` and `..` segments are rejected.
 */

export type StaticSegment = { readonly k: "static"; readonly v: string }
export type ParamSegment = { readonly k: "param"; readonly n: string; readonly o: boolean }
export type WildcardSegment = { readonly k: "wildcard"; readonly n: string }
export type Segment = StaticSegment | ParamSegment | WildcardSegment

/** `METHOD /canonical/pattern` — stable identity of a route across apps, trees and codegen. */
export type RouteId = string

const NAME = /^[A-Za-z_$][A-Za-z0-9_$-]*$/

/** Name given to a `*` wildcard without a name. */
export const UNNAMED_WILDCARD = "*"

function invalid(path: string, why: string): never {
	throw new Error(`Invalid route pattern "${path}": ${why}`)
}

export function parsePattern(path: string): Segment[] {
	if (typeof path !== "string") invalid(String(path), "must be a string")
	if (path.includes("#")) invalid(path, "fragments are not part of a route pattern")
	const raw = path.split("/")
	const segments: Segment[] = []
	const names = new Set<string>()
	for (let i = 0; i < raw.length; i++) {
		const seg = raw[i]
		if (seg === "") continue
		if (seg === "." || seg === "..") invalid(path, `"${seg}" segments are not allowed`)
		const c = seg.charCodeAt(0)
		if (c === 58 /* : */) {
			const optional = seg.endsWith("?")
			const name = optional ? seg.slice(1, -1) : seg.slice(1)
			if (!NAME.test(name)) {
				invalid(
					path,
					`parameter ":${name}" is not a valid name (letters, digits, "_", "$" and "-"; it takes the whole segment)`,
				)
			}
			if (names.has(name)) invalid(path, `parameter ":${name}" appears twice`)
			names.add(name)
			segments.push({ k: "param", n: name, o: optional })
			continue
		}
		if (c === 42 /* * */) {
			const name = seg.length > 1 ? seg.slice(1) : UNNAMED_WILDCARD
			if (name !== UNNAMED_WILDCARD && !NAME.test(name)) {
				invalid(path, `wildcard "*${name}" is not a valid name`)
			}
			if (names.has(name)) invalid(path, `"${name}" appears twice`)
			names.add(name)
			segments.push({ k: "wildcard", n: name })
			continue
		}
		if (seg.includes("?")) invalid(path, "query strings are not part of a route pattern")
		segments.push({ k: "static", v: seg })
	}
	for (let i = 0; i < segments.length - 1; i++) {
		const s = segments[i]
		if (s.k === "wildcard") invalid(path, "a wildcard must be the last segment")
		if (s.k === "param" && s.o) invalid(path, "an optional parameter must be the last segment")
	}
	return segments
}

export function formatSegment(seg: Segment): string {
	if (seg.k === "static") return seg.v
	if (seg.k === "param") return `:${seg.n}${seg.o ? "?" : ""}`
	return seg.n === UNNAMED_WILDCARD ? "*" : `*${seg.n}`
}

/** Canonical pattern string: leading slash, no empty segments, no trailing slash. */
export function canonical(segments: readonly Segment[]): string {
	if (segments.length === 0) return "/"
	let out = ""
	for (const seg of segments) out += `/${formatSegment(seg)}`
	return out
}

/** Parse and re-print — throws on anything the grammar cannot express. */
export function normalizePattern(path: string): string {
	return canonical(parsePattern(path))
}

/** Join two patterns: `joinPatterns("/api/", "users")` is `/api/users`. */
export function joinPatterns(base: string, path: string): string {
	const b = parsePattern(base)
	const p = parsePattern(path)
	if (b.length > 0) {
		const last = b[b.length - 1]
		if (last.k === "wildcard" || (last.k === "param" && last.o)) {
			if (p.length > 0) invalid(`${base}${path}`, "cannot append to a wildcard or optional parameter")
		}
	}
	return canonical([...b, ...p])
}

/**
 * Concrete variants of a pattern: an optional last parameter yields the pattern with and
 * without it. Every other pattern is its own single variant.
 */
export function expandOptional(segments: readonly Segment[]): Segment[][] {
	const last = segments[segments.length - 1]
	if (last !== undefined && last.k === "param" && last.o) {
		return [segments.slice(0, -1), [...segments.slice(0, -1), { k: "param", n: last.n, o: false }]]
	}
	return [[...segments]]
}

export function isStaticPattern(segments: readonly Segment[]): boolean {
	for (const s of segments) if (s.k !== "static") return false
	return true
}

/** Parameter and wildcard names, in order. */
export function patternParams(segments: readonly Segment[]): string[] {
	const out: string[] = []
	for (const s of segments) if (s.k !== "static") out.push(s.n)
	return out
}

export function routeId(method: string, pattern: string): RouteId {
	return `${method} ${pattern}`
}

/** Split a RouteId back into method and canonical pattern. */
export function splitRouteId(id: RouteId): { method: string; pattern: string } {
	const sp = id.indexOf(" ")
	return { method: id.slice(0, sp), pattern: id.slice(sp + 1) }
}

/** OpenAPI path template: `:id` and named wildcards become `{name}`. */
export function toOpenApiTemplate(segments: readonly Segment[]): string {
	if (segments.length === 0) return "/"
	let out = ""
	for (const s of segments) {
		if (s.k === "static") out += `/${s.v}`
		else if (s.k === "param") out += `/{${s.n}}`
		else out += s.n === UNNAMED_WILDCARD ? "/{wildcard}" : `/{${s.n}}`
	}
	return out
}
