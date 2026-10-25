/**
 * The build's watch globs: a `watch` pattern as a RegExp anchored at the project root, and the paths a watch never
 * regenerates for. `**` spans segments; `*` and `?` stay in one; `{a,b}` alternates; `[...]` is a class (`[!...]`
 * negates).
 */
import { isAbsolute, relative } from "node:path"

/** `pattern` as a RegExp over a root-relative path: anchored, so `src/**` never matches `node_modules/x/src/a.ts`. */
export function globToRegExp(pattern: string): RegExp {
	const segments = pattern
		.replaceAll("\\", "/")
		.replace(/^(\.\/)+/, "")
		.split("/")
	let re = "^"
	segments.forEach((segment, i) => {
		const last = i === segments.length - 1
		if (segment === "**") re += last ? ".*" : "(?:[^/]*/)*"
		else re += segmentToRegExp(segment) + (last ? "" : "/")
	})
	return new RegExp(`${re}$`)
}

/** One path segment's pattern as RegExp source; a character a glob gives no meaning is literal. */
function segmentToRegExp(segment: string): string {
	let out = ""
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i] as string
		if (ch === "*") {
			/* a stray `**` inside a segment means `*` */
			while (segment[i + 1] === "*") i++
			out += "[^/]*"
		} else if (ch === "?") out += "[^/]"
		else if (ch === "[" && segment.indexOf("]", i + 2) !== -1) {
			const close = segment.indexOf("]", i + 2)
			const body = segment.slice(i + 1, close)
			out += `[${(body.startsWith("!") ? `^${body.slice(1)}` : body).replaceAll("\\", "\\\\").replaceAll("/", "")}]`
			i = close
		} else if (ch === "{" && matchingBrace(segment, i) !== -1) {
			const close = matchingBrace(segment, i)
			out += `(?:${splitTopLevel(segment.slice(i + 1, close))
				.map(segmentToRegExp)
				.join("|")})`
			i = close
		} else out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
	}
	return out
}

function matchingBrace(s: string, open: number): number {
	let depth = 0
	for (let i = open; i < s.length; i++) {
		if (s[i] === "{") depth++
		else if (s[i] === "}" && --depth === 0) return i
	}
	return -1
}

/** `body`'s alternatives, split at its top-level commas. */
function splitTopLevel(body: string): string[] {
	const parts: string[] = []
	let depth = 0
	let start = 0
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "{") depth++
		else if (body[i] === "}") depth--
		else if (body[i] === "," && depth === 0) {
			parts.push(body.slice(start, i))
			start = i + 1
		}
	}
	parts.push(body.slice(start))
	return parts
}

/** A matcher for `patterns`, compiled once: whether `file` (absolute, or relative to `root`) matches; outside never. */
export function compileGlobs(patterns: readonly string[]): (file: string, root: string) => boolean {
	const regexps = patterns.map(globToRegExp)
	return (file, root) => {
		const rel = (isAbsolute(file) ? relative(root, file) : file).replaceAll("\\", "/")
		if (rel === "" || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false
		return regexps.some((re) => re.test(rel))
	}
}

/** Whether `file` (absolute, or relative to `root`) matches any of `patterns`; a file outside `root` never does. */
export function matchesGlob(file: string, patterns: readonly string[], root: string): boolean {
	return compileGlobs(patterns)(file, root)
}

/** What a watch never regenerates for: `_gen/` and `_gen` itself, `*.gen.*`, dependencies, an atomic write's `.tmp`. */
export const WATCH_IGNORE_RE = /(^|[/\\])_gen([/\\]|$)|\.gen\.(tsx?|json|ya?ml|d\.ts)$|[/\\]node_modules[/\\]|\.tmp$/
