import { isAbsolute, relative } from "node:path"

/**
 * Glob → RegExp for `watch` patterns, matched against a path relative to the project root.
 * Supports `**` (any number of segments), `*` and `?` (within a segment), `{a,b}` alternation and
 * `[...]` classes (`[!...]` negates). A pattern is anchored at the root, so `src/**` never matches
 * `node_modules/x/src/a.ts`.
 */
export function globToRegExp(pattern: string): RegExp {
	const normalized = pattern.replaceAll("\\", "/").replace(/^(\.\/)+/, "")
	const segments = normalized.split("/")
	let re = "^"
	segments.forEach((segment, i) => {
		const last = i === segments.length - 1
		if (segment === "**") {
			re += last ? ".*" : "(?:[^/]*/)*"
			return
		}
		re += segmentToRegExp(segment)
		if (!last) re += "/"
	})
	return new RegExp(`${re}$`)
}

function segmentToRegExp(segment: string): string {
	let out = ""
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i] as string
		if (ch === "*") {
			/* a stray `**` inside a segment means the same as `*` */
			while (segment[i + 1] === "*") i++
			out += "[^/]*"
		} else if (ch === "?") {
			out += "[^/]"
		} else if (ch === "[") {
			const close = segment.indexOf("]", i + 2)
			if (close === -1) {
				out += "\\["
				continue
			}
			let body = segment.slice(i + 1, close)
			if (body.startsWith("!")) body = `^${body.slice(1)}`
			out += `[${body.replaceAll("\\", "\\\\").replaceAll("/", "")}]`
			i = close
		} else if (ch === "{") {
			const close = matchingBrace(segment, i)
			if (close === -1) {
				out += "\\{"
				continue
			}
			const alternatives = splitTopLevel(segment.slice(i + 1, close))
			out += `(?:${alternatives.map(segmentToRegExp).join("|")})`
			i = close
		} else {
			out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		}
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

/** True when `file` (absolute, or relative to `root`) matches any pattern. Files outside `root` never match. */
export function matchesGlob(file: string, patterns: readonly string[], root: string): boolean {
	const rel = (isAbsolute(file) ? relative(root, file) : file).replaceAll("\\", "/")
	if (rel === "" || rel.startsWith("../") || rel === ".." || isAbsolute(rel)) return false
	return patterns.some((pattern) => globToRegExp(pattern).test(rel))
}
