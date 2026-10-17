/**
 * The one string-escape layer (F2): the only way spec text becomes source in any emitted SDK.
 * Every target's string literal comes from one escaper with a per-target policy, and every
 * comment from one comment-text filter; both are fuzzed against readers written from each
 * language's grammar and cross-checked with the real compilers.
 */

export type Target = "csharp" | "go" | "python" | "rust" | "ts"

/** `text` with each unpaired UTF-16 surrogate as U+FFFD: no target can carry a lone surrogate to the wire. */
export function wellFormed(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
}

const hex = (cp: number, width: number) => cp.toString(16).padStart(width, "0")

/** How one target writes a code point inside `"…"`: an escape, or `null` to write it as it is. */
type Policy = (cp: number) => string | null

/* the escapes every target spells alike */
const NAMED: Readonly<Record<number, string>> = { 0x09: "\\t", 0x0a: "\\n", 0x0d: "\\r", 0x22: '\\"', 0x5c: "\\\\" }

const POLICIES: Readonly<Record<Target, Policy>> = {
	/* C#'s \x takes one to four hex digits, so it is never written: \uHHHH, fixed width, for every escape */
	csharp: (cp) =>
		cp < 0x20 || cp === 0x7f || cp === 0x85 || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff
			? `\\u${hex(cp, 4)}`
			: null,
	go: (cp) => {
		if (cp < 0x20 || cp === 0x7f) return `\\x${hex(cp, 2)}`
		return cp === 0xfeff ? "\\ufeff" : null
	},
	python: (cp) => {
		if (cp < 0x20 || cp === 0x7f) return `\\x${hex(cp, 2)}`
		/* line separators, NEL and the BOM read as line ends or vanish in some tools: never raw */
		return cp === 0x85 || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff ? `\\u${hex(cp, 4)}` : null
	},
	rust: (cp) => {
		if (cp === 0) return "\\0"
		return cp < 0x20 || cp === 0x7f || cp === 0xfeff ? `\\u{${hex(cp, 2)}}` : null
	},
	ts: (cp) => {
		if (cp === 0x08) return "\\b"
		if (cp === 0x0c) return "\\f"
		return cp < 0x20 || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff ? `\\u${hex(cp, 4)}` : null
	},
}

/** The body of a `"…"` literal of `text` for `target`: the single escaper every writer goes through. */
export function escapeText(text: string, target: Target): string {
	const policy = POLICIES[target]
	let out = ""
	for (const ch of wellFormed(text)) {
		const cp = ch.codePointAt(0) as number
		out += NAMED[cp] ?? policy(cp) ?? ch
	}
	return out
}

/** A double-quoted string literal of `text` in `target`'s syntax. */
export function stringLiteral(text: string, target: Target): string {
	return `"${escapeText(text, target)}"`
}

export const tsString = (text: string) => stringLiteral(text, "ts")
export const goString = (text: string) => stringLiteral(text, "go")
export const rustString = (text: string) => stringLiteral(text, "rust")
export const pyString = (text: string) => stringLiteral(text, "python")
export const csString = (text: string) => stringLiteral(text, "csharp")

/**
 * Text for a comment or docstring: well-formed, with each character a compiler refuses even in a
 * comment (Go and Python refuse NUL, Go a BOM) shown as visible `\uXXXX`. Tab and line breaks stay;
 * the comment writers split lines themselves.
 */
export function commentText(text: string): string {
	let out = ""
	for (const ch of wellFormed(text)) {
		const cp = ch.codePointAt(0) as number
		const hidden = (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0x7f || cp === 0xfeff
		out += hidden ? `\\u${hex(cp, 4)}` : ch
	}
	return out
}

/* every line break a comment writer splits at: a C# or JS lexer ends a line at U+0085, U+2028 and U+2029 too */
const LINE_BREAKS = /\r\n|\r|\n|\u2028|\u2029|\u0085/

/** Comment lines of `text` behind `marker` (`//`, `///`, `#`): each line break in it starts a new comment line. */
export function lineComment(text: string, marker: string, indent = ""): string[] {
	return commentText(text)
		.split(LINE_BREAKS)
		.map((line) => (line.trim() === "" ? `${indent}${marker}` : `${indent}${marker} ${line}`))
}

/** Text that stays inside a `/* … *\/` comment. */
export function blockCommentText(text: string): string {
	return commentText(text).replace(/\*\//g, "* /").replace(/\/\*/g, "/ *")
}

/** Docstring body lines: backslashes and quotes escaped, so `"""`, a trailing `"` and `C:\users` are inert. */
export function pyDocLines(text: string): string[] {
	return commentText(text)
		.split(LINE_BREAKS)
		.map((line) => line.replace(/\\/g, "\\\\").replace(/"/g, '\\"'))
}

/** XML doc text lines (C#'s `///`): split at every line break, `&`, `<` and `>` as entities (CS1570 otherwise). */
export function csDocLines(text: string): string[] {
	return commentText(text)
		.split(LINE_BREAKS)
		.map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
}
