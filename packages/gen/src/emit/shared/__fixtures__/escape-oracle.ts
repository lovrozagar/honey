/**
 * The F2 oracle: what a target's string literal and a comment must be, judged by readers written
 * from each language's spec and never from the escaper. Shared by the escape fuzz and the emit
 * adversarial suite (the mutation harness reruns that one with the escaper's policy switched off).
 */
import { caseLabel, type Rng, rng, runs } from "./rng.ts"
import { blockCommentText, commentText, lineComment, pyDocLines, stringLiteral, wellFormed } from "../escape.ts"

export type Target = "csharp" | "go" | "python" | "rust" | "ts"
type Decoded = { value: string; end: number; escaped: number[] }

const TOKENS: readonly string[] = [
	"a",
	"Z",
	"0",
	" ",
	'"',
	"'",
	"`",
	"\\",
	"\n",
	"\r",
	"\t",
	"\0",
	"\u0001",
	"\u0008",
	"\u000b",
	"\u000c",
	"\u001f",
	"\u007f",
	"\u0085",
	" ",
	"é",
	"€",
	"\u2028",
	"\u2029",
	"\uFEFF",
	"�",
	"\uD800",
	"\uDBFF",
	"\uDC00",
	"\uDFFF",
	"\u{1F600}",
	"*/",
	"/*",
	'"""',
	"${",
	"#{",
	"\\u",
	"\\x",
	"\\0",
	"\\n",
	"%s",
	"{}",
	"</script>",
]

/** What each target forbids raw inside `"…"`, or this layer escapes there by policy: the only escapes allowed. */
const REQUIRED: Readonly<Record<Target, (cp: number) => boolean>> = {
	csharp: (cp) => cp === 0x22 || cp === 0x5c || cp < 0x20 || cp === 0x7f || [0x85, 0x2028, 0x2029, 0xfeff].includes(cp),
	go: (cp) => cp === 0x22 || cp === 0x5c || cp < 0x20 || cp === 0x7f || cp === 0xfeff,
	python: (cp) => cp === 0x22 || cp === 0x5c || cp < 0x20 || cp === 0x7f || [0x85, 0x2028, 0x2029, 0xfeff].includes(cp),
	rust: (cp) => cp === 0x22 || cp === 0x5c || cp < 0x20 || cp === 0x7f || cp === 0xfeff,
	ts: (cp) => cp === 0x22 || cp === 0x5c || cp < 0x20 || [0x2028, 0x2029, 0xfeff].includes(cp),
}

const SIMPLE: Readonly<Record<Target, Readonly<Record<string, string>>>> = {
	/* C# 13's simple escapes (§6.4.5.5), `\e` among them */
	csharp: {
		'"': '"',
		"'": "'",
		"\\": "\\",
		"0": "\0",
		a: "\x07",
		b: "\b",
		e: "\x1b",
		f: "\f",
		n: "\n",
		r: "\r",
		t: "\t",
		v: "\v",
	},
	go: { '"': '"', "'": "'", "\\": "\\", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" },
	python: { '"': '"', "'": "'", "\\": "\\", a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" },
	rust: { '"': '"', "'": "'", "\\": "\\", "0": "\0", n: "\n", r: "\r", t: "\t" },
	ts: { '"': '"', "'": "'", "\\": "\\", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" },
}

const HEX = /^[0-9a-fA-F]+$/

function hexAt(text: string, from: number, digits: number): number {
	const run = text.slice(from, from + digits)
	if (run.length !== digits || !HEX.test(run)) throw new Error(`bad hex at ${from}`)
	return Number.parseInt(run, 16)
}

type Escape = { cp: number; next: number }

/** `\u{…}`: one to six hex digits in braces. */
function braced(text: string, at: number): Escape {
	const close = text.indexOf("}", at + 3)
	if (text[at + 2] !== "{" || close < 0 || close - at - 3 > 6) throw new Error("bad \\u{}")
	return { cp: hexAt(text, at + 3, close - at - 3), next: close + 1 }
}

/** `\xHH`; Go and Rust only below 0x80 here, where the byte is the code point. */
function byteEscape(text: string, at: number, ascii: boolean): Escape {
	const cp = hexAt(text, at + 2, 2)
	if (ascii && cp > 0x7f) throw new Error("\\x above 0x7F")
	return { cp, next: at + 4 }
}

/** C#'s `\x`: one to four hex digits, as many as follow. */
function variableHex(text: string, at: number): Escape {
	const run = /^[0-9a-fA-F]{1,4}/.exec(text.slice(at + 2))?.[0]
	if (run === undefined) throw new Error("bad \\x")
	return { cp: Number.parseInt(run, 16), next: at + 2 + run.length }
}

/** The numeric escapes each target's grammar allows, past its simple ones. */
const NUMERIC: Readonly<Record<Target, (text: string, at: number) => Escape>> = {
	csharp: (text, at) => {
		const c = text[at + 1]
		if (c === "x") return variableHex(text, at)
		if (c === "u") return { cp: hexAt(text, at + 2, 4), next: at + 6 }
		if (c === "U") return { cp: hexAt(text, at + 2, 8), next: at + 10 }
		throw new Error(`escape \\${c} is not C#`)
	},
	go: (text, at) => {
		const c = text[at + 1]
		if (c === "x") return byteEscape(text, at, true)
		if (c === "u") return { cp: hexAt(text, at + 2, 4), next: at + 6 }
		if (c === "U") return { cp: hexAt(text, at + 2, 8), next: at + 10 }
		throw new Error(`escape \\${c} is not Go`)
	},
	python: (text, at) => {
		const c = text[at + 1]
		if (c === "x") return byteEscape(text, at, false)
		if (c === "u") return { cp: hexAt(text, at + 2, 4), next: at + 6 }
		if (c === "U") return { cp: hexAt(text, at + 2, 8), next: at + 10 }
		throw new Error(`escape \\${c} is not this layer's Python`)
	},
	rust: (text, at) => {
		const c = text[at + 1]
		if (c === "x") return byteEscape(text, at, true)
		if (c === "u") return braced(text, at)
		throw new Error(`escape \\${c} is not Rust`)
	},
	ts: (text, at) => {
		const c = text[at + 1]
		if (c === "0" && !/[0-9]/.test(text[at + 2] ?? "")) return { cp: 0, next: at + 2 }
		if (c === "x") return byteEscape(text, at, false)
		if (c === "u") return text[at + 2] === "{" ? braced(text, at) : { cp: hexAt(text, at + 2, 4), next: at + 6 }
		throw new Error(`escape \\${c} is not TypeScript`)
	},
}

/** One escape after the backslash at `at`: the code point it means and where the literal goes on. */
function escapeAt(target: Target, text: string, at: number): Escape {
	const simple = SIMPLE[target][text[at + 1] as string]
	return simple === undefined ? NUMERIC[target](text, at) : { cp: simple.codePointAt(0) as number, next: at + 2 }
}

/* the raw characters that end a line, so a literal holding one is unterminated: C#'s new-line characters */
const ENDS_LINE: Readonly<Record<Target, RegExp>> = {
	csharp: /^[\n\r\u0085\u2028\u2029]$/,
	go: /^\n$/,
	python: /^\n$/,
	rust: /^$/,
	ts: /^\n$/,
}

/** Read a `"…"` literal of `target` from the start of `text`, as that language's lexer does. */
function decode(target: Target, text: string): Decoded {
	if (text[0] !== '"') throw new Error("no opening quote")
	let value = ""
	const escaped: number[] = []
	for (let at = 1; at < text.length;) {
		const ch = String.fromCodePoint(text.codePointAt(at) as number)
		if (ch === '"') return { end: at + 1, escaped, value }
		if (ENDS_LINE[target].test(ch)) throw new Error("raw newline in a string")
		if (ch !== "\\") {
			value += ch
			at += ch.length
			continue
		}
		const { cp, next } = escapeAt(target, text, at)
		escaped.push(cp)
		value += String.fromCodePoint(cp)
		at = next
	}
	throw new Error("unterminated literal")
}

/* appended, not sorted in: each target's fuzz salt is its index, so the others' inputs stay put */
export const TARGETS: readonly Target[] = ["go", "python", "rust", "ts", "csharp"]

function input(r: Rng): string {
	let out = ""
	for (let n = r.int(24); n > 0; n--) out += r.pick(TOKENS)
	return out
}

/** What is wrong with `target`'s literal of `text`, or `null`. */
export function literalProblem(target: Target, text: string): string | null {
	const literal = stringLiteral(text, target)
	let decoded: Decoded
	try {
		decoded = decode(target, `${literal}"; injected`)
	} catch (error) {
		return `unreadable: ${(error as Error).message}`
	}
	if (decoded.value !== wellFormed(text)) return "does not round-trip"
	if (decoded.end !== literal.length) return "not closed where it ends"
	if (decoded.escaped.some((cp) => !REQUIRED[target](cp))) return "escapes what it need not"
	const raw = Array.from(literal.slice(1, -1)).find(
		(ch) => ch !== "\\" && ch !== '"' && REQUIRED[target](ch.codePointAt(0) as number),
	)
	if (raw !== undefined) return `leaves ${JSON.stringify(raw)} raw`
	if (target === "ts" && new Function(`return ${literal}`)() !== wellFormed(text)) return "evaluates to other text"
	return null
}

/** C0 (bar tab and line breaks), DEL and the BOM: never raw in comment text. */
const hidden = (cp: number) => (cp < 0x20 && ![0x09, 0x0a, 0x0d].includes(cp)) || cp === 0x7f || cp === 0xfeff

/** What is wrong with the comment forms of `text`, or `null`. */
export function commentProblem(text: string): string | null {
	const shown = commentText(text)
	if ([...shown].some((ch) => hidden(ch.codePointAt(0) as number))) return "control character raw in a comment"
	if (shown !== commentText(wellFormed(text))) return "ill-formed comment text"
	const lines = lineComment(text, "//")
	if (lines.some((line) => !line.startsWith("//") || /[\r\n\u2028\u2029\u0085]/.test(line)))
		return "line comment broken"
	if (blockCommentText(text).includes("*/")) return "block comment closed early"
	if (pyDocLines(text).some((line) => /(^|[^\\])(\\\\)*"/.test(line))) return "docstring quote raw"
	return null
}

/** Every failing case of `count` random inputs from `salt` (at most ten), as labels: none is the pass. */
export function failures(
	salt: number,
	problem: (text: string) => string | null,
	count = runs(10_000, 1_000_000),
): string[] {
	const r = rng(salt)
	const out: string[] = []
	for (let i = 0; i < count && out.length < 10; i++) {
		const text = input(r)
		const found = problem(text)
		if (found !== null) out.push(`${found}: ${caseLabel(salt, i, text)}`)
	}
	return out
}
