/**
 * The one route-pattern grammar. Registration, the router tree, scope matching, codegen selectors
 * and OpenAPI paths all consume the parsed form; nothing re-derives params from a pattern string
 * with its own regex.
 *
 *     pattern  = "/" | ("/" segment)+ ["/"]
 *     segment  = static | param | wildcard
 *     param    = ":" name ["?"]        optional only as the last segment
 *     wildcard = "*" [name]            last segment only; unnamed is called "*"
 *     name     = [A-Za-z_$][A-Za-z0-9_$-]*
 *
 * Empty segments are dropped (`//a` is `/a`), a trailing slash is not significant, and a pattern
 * without a leading slash gets one. `.` and `..` segments are rejected.
 */
import { encodeSegment } from "./request-path.ts"

export type StaticSegment = { readonly k: "static"; readonly v: string }
export type ParamSegment = { readonly k: "param"; readonly n: string; readonly o: boolean }
export type WildcardSegment = { readonly k: "wildcard"; readonly n: string }
export type Segment = ParamSegment | StaticSegment | WildcardSegment

/** `METHOD /canonical/pattern`: the stable identity of a route across apps, trees and codegen. */
export type RouteId = string

/** How much of a route a scope covers: every path it serves, none, or only some. */
export type ScopeCoverage = "all" | "none" | "some"

const NAME = /^[A-Za-z_$][A-Za-z0-9_$-]*$/
/* `%2e` is a dot to every URL parser, so `/%2e%2e` can never be requested either */
const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i

/** Name given to a `*` wildcard without a name. */
export const UNNAMED_WILDCARD = "*"

function invalid(path: string, why: string): never {
	throw new Error(`Invalid route pattern "${path}": ${why}`)
}

function paramSegment(path: string, seg: string, names: Set<string>): ParamSegment {
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
	return { k: "param", n: name, o: optional }
}

function wildcardSegment(path: string, seg: string, names: Set<string>): WildcardSegment {
	const name = seg.length > 1 ? seg.slice(1) : UNNAMED_WILDCARD
	if (name !== UNNAMED_WILDCARD && !NAME.test(name)) invalid(path, `wildcard "*${name}" is not a valid name`)
	if (names.has(name)) invalid(path, `"${name}" appears twice`)
	names.add(name)
	return { k: "wildcard", n: name }
}

function segmentOf(path: string, seg: string, names: Set<string>): Segment {
	if (DOT_SEGMENT.test(seg)) invalid(path, `"${seg}" segments are not allowed`)
	if (seg.startsWith(":")) return paramSegment(path, seg, names)
	if (seg.startsWith("*")) return wildcardSegment(path, seg, names)
	if (seg.includes("?")) invalid(path, "query strings are not part of a route pattern")
	/* the request path is percent-encoded the way URL parsing encodes it; so is a literal */
	return { k: "static", v: encodeSegment(seg) }
}

/** A wildcard or an optional param: it matches everything at and below its depth. */
function isOpenEnded(seg: Segment): boolean {
	return seg.k === "wildcard" || (seg.k === "param" && seg.o)
}

export function parsePattern(path: string): Segment[] {
	if (typeof path !== "string") invalid(String(path), "must be a string")
	if (path.includes("#")) invalid(path, "fragments are not part of a route pattern")
	const names = new Set<string>()
	const segments = path
		.split("/")
		.filter((seg) => seg !== "")
		.map((seg) => segmentOf(path, seg, names))
	for (const seg of segments.slice(0, -1)) {
		if (seg.k === "wildcard") invalid(path, "a wildcard must be the last segment")
		if (isOpenEnded(seg)) invalid(path, "an optional parameter must be the last segment")
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
	return segments.length === 0 ? "/" : segments.map((seg) => `/${formatSegment(seg)}`).join("")
}

/** Parse and re-print; throws on anything the grammar cannot express. */
export function normalizePattern(path: string): string {
	return canonical(parsePattern(path))
}

/** Join two patterns: `joinPatterns("/api/", "users")` is `/api/users`. */
export function joinPatterns(base: string, path: string): string {
	const head = parsePattern(base)
	const tail = parsePattern(path)
	const last = head.at(-1)
	if (last !== undefined && isOpenEnded(last) && tail.length > 0) {
		invalid(`${base}${path}`, "cannot append to a wildcard or optional parameter")
	}
	/* re-parse: a name used on both sides (`/:id` + `/:id`) is only caught on the whole pattern */
	return normalizePattern(canonical([...head, ...tail]))
}

/** Concrete variants: an optional last param yields the pattern with and without it. */
export function expandOptional(segments: readonly Segment[]): Segment[][] {
	const last = segments.at(-1)
	if (last?.k !== "param" || !last.o) return [[...segments]]
	const head = segments.slice(0, -1)
	return [head, [...head, { k: "param", n: last.n, o: false }]]
}

export function isStaticPattern(segments: readonly Segment[]): boolean {
	return segments.every((seg) => seg.k === "static")
}

/** Parameter and wildcard names, in order. */
export function patternParams(segments: readonly Segment[]): string[] {
	return segments.flatMap((seg) => (seg.k === "static" ? [] : [seg.n]))
}

export function routeId(method: string, pattern: string): RouteId {
	return `${method} ${pattern}`
}

/** Split a RouteId back into method and canonical pattern. */
export function splitRouteId(id: RouteId): { method: string; pattern: string } {
	const space = id.indexOf(" ")
	return { method: id.slice(0, space), pattern: id.slice(space + 1) }
}

/** OpenAPI path template: `:id` and named wildcards become `{name}`. */
export function toOpenApiTemplate(segments: readonly Segment[]): string {
	if (segments.length === 0) return "/"
	return segments
		.map((seg) => {
			if (seg.k === "static") return `/${seg.v}`
			return seg.n === UNNAMED_WILDCARD ? "/{wildcard}" : `/{${seg.n}}`
		})
		.join("")
}

/*
 * Scopes. `app.use("/admin", mw)` guards request paths: a path is inside the scope when its leading
 * segments match the scope pattern: static segments literally, `:param` any one segment, `*` and
 * an optional last param everything below. The scope uses the route grammar, so `/orgs/:id` and
 * `/admin/*` mean what they mean in a route.
 */

function safeDecode(s: string): string {
	if (!s.includes("%")) return s
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}

/* both sides decoded: a literal is stored encoded (`%C3%A9`), and a request may spell the same
 * bytes with lowercase escapes (`%c3%a9`) or raw */
function sameLiteral(a: string, b: string): boolean {
	return a === b || safeDecode(a) === safeDecode(b)
}

function coverVariant(route: readonly Segment[], scope: readonly Segment[]): ScopeCoverage {
	let uncertain = false
	for (let i = 0; i < scope.length; i++) {
		const s = scope[i] as Segment
		if (isOpenEnded(s)) return uncertain ? "some" : "all"
		const r = route[i]
		/* the route's paths end before the scope's do */
		if (r === undefined) return "none"
		/* a route wildcard serves paths both inside and outside the rest of the scope */
		if (r.k === "wildcard") return "some"
		if (r.k === "static" && s.k === "static" && !sameLiteral(r.v, s.v)) return "none"
		/* a route param against a scope literal: inside the scope only when the value matches */
		if (r.k === "param" && s.k === "static") uncertain = true
	}
	return uncertain ? "some" : "all"
}

/**
 * Decide at registration whether a scope covers a route. `"some"` means the answer depends on the
 * request path (a route param or wildcard can land inside the scope), so the scope's middleware is
 * guarded by {@link pathInScope} at request time.
 */
export function scopeCoverage(route: readonly Segment[], scope: readonly Segment[]): ScopeCoverage {
	return variantsCoverage(expandOptional(route), scope)
}

/** {@link scopeCoverage} for a route already expanded into its optional-param variants, so finalize expands each route once, not once per scope. */
export function variantsCoverage(variants: readonly (readonly Segment[])[], scope: readonly Segment[]): ScopeCoverage {
	const first = coverVariant(variants[0] as readonly Segment[], scope)
	for (let i = 1; i < variants.length; i++)
		if (coverVariant(variants[i] as readonly Segment[], scope) !== first) return "some"
	return first
}

/**
 * Is a request path inside a scope? Splits the path the way the router does (empty segments
 * dropped) and compares each segment both as sent and percent-decoded, so a route param that
 * decodes to a scoped literal is guarded exactly like the literal.
 */
export function pathInScope(path: string, scope: readonly Segment[]): boolean {
	let pos = 0
	for (const s of scope) {
		if (isOpenEnded(s)) return true
		while (path.charCodeAt(pos) === 47) pos++
		if (pos >= path.length) return false
		const slash = path.indexOf("/", pos)
		const end = slash === -1 ? path.length : slash
		if (s.k === "static" && !sameLiteral(path.substring(pos, end), s.v)) return false
		pos = end
	}
	return true
}
