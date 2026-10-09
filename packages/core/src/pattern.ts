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

import { encodeSegment } from "./request-path.ts"

export type StaticSegment = { readonly k: "static"; readonly v: string }
export type ParamSegment = { readonly k: "param"; readonly n: string; readonly o: boolean }
export type WildcardSegment = { readonly k: "wildcard"; readonly n: string }
export type Segment = StaticSegment | ParamSegment | WildcardSegment

/** `METHOD /canonical/pattern` — stable identity of a route across apps, trees and codegen. */
export type RouteId = string

const NAME = /^[A-Za-z_$][A-Za-z0-9_$-]*$/
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i

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
		/* `%2e` is a dot to every URL parser, so `/%2e%2e` can never be requested either */
		if (DOT_SEGMENT.test(seg)) invalid(path, `"${seg}" segments are not allowed`)
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
		/* the request path is percent-encoded the way URL parsing encodes it; so is a literal */
		segments.push({ k: "static", v: encodeSegment(seg) })
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
	/* re-parse: a name used on both sides (`/:id` + `/:id`) is only caught on the whole pattern */
	return normalizePattern(canonical([...b, ...p]))
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

/*
 * Scopes. `app.use("/admin", mw)` guards request paths: a path is inside the scope when its
 * leading segments match the scope pattern — static segments literally, `:param` any one
 * segment, `*` and an optional last param everything below. The scope uses the route
 * grammar, so `/orgs/:id` and `/admin/*` mean what they mean in a route.
 */

/** How much of a route a scope covers: every path it serves, none, or only some. */
export type ScopeCoverage = "all" | "none" | "some"

function coverVariant(route: readonly Segment[], scope: readonly Segment[]): ScopeCoverage {
	let uncertain = false
	for (let i = 0; i < scope.length; i++) {
		const s = scope[i] as Segment
		/* a wildcard or optional last param covers everything at and below this depth */
		if (s.k === "wildcard" || (s.k === "param" && s.o)) return uncertain ? "some" : "all"
		const r = route[i]
		/* the route's paths end before the scope's do */
		if (r === undefined) return "none"
		/* a route wildcard serves paths both inside and outside the rest of the scope */
		if (r.k === "wildcard") return "some"
		if (r.k === "static") {
			if (s.k === "static" && s.v !== r.v && safeDecode(r.v) !== s.v) return "none"
			continue
		}
		/* route param against a scope literal: inside the scope only when the value matches */
		if (s.k === "static") uncertain = true
	}
	return uncertain ? "some" : "all"
}

function combine(a: ScopeCoverage, b: ScopeCoverage): ScopeCoverage {
	return a === b ? a : "some"
}

/**
 * Decide at registration time whether a scope covers a route. `"some"` means the answer
 * depends on the request path (a route param or wildcard can land inside the scope), so the
 * scope's middleware is guarded by {@link pathInScope} at request time.
 */
export function scopeCoverage(route: readonly Segment[], scope: readonly Segment[]): ScopeCoverage {
	let out: ScopeCoverage | undefined
	for (const rv of expandOptional(route)) {
		const c = coverVariant(rv, scope)
		out = out === undefined ? c : combine(out, c)
	}
	return out ?? "none"
}

function safeDecode(s: string): string {
	if (s.indexOf("%") === -1) return s
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}

/**
 * Is a request path inside a scope? Splits the path the way the router does (empty segments
 * dropped) and compares each segment both as sent and percent-decoded, so a route param that
 * decodes to a scoped literal is guarded exactly like the literal.
 */
export function pathInScope(path: string, scope: readonly Segment[]): boolean {
	let pos = 0
	const len = path.length
	for (let i = 0; i < scope.length; i++) {
		const s = scope[i] as Segment
		if (s.k === "wildcard" || (s.k === "param" && s.o)) return true
		while (pos < len && path.charCodeAt(pos) === 47) pos++
		if (pos >= len) return false
		let end = path.indexOf("/", pos)
		if (end === -1) end = len
		if (s.k === "static") {
			const seg = path.substring(pos, end)
			if (seg !== s.v && safeDecode(seg) !== s.v) return false
		}
		pos = end
	}
	return true
}
