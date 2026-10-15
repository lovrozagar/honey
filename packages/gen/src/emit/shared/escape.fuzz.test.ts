/**
 * The F2 fuzz: the one string-escape layer every emitter writes through. For random text, each
 * target's literal must (a) decode, by a reader written from that language's spec and never from
 * the escaper, back to the text (unpaired surrogates as U+FFFD); (b) be closed: the reader ends
 * exactly at the literal's last character, and no character the target forbids raw appears raw;
 * (c) escape nothing the target does not require. TypeScript is also evaluated for real.
 */
import { describe, expect, it } from "vitest"
import { caseLabel, type Rng, rng, runs } from "./__fixtures__/rng.ts"
import { blockCommentText, commentText, lineComment, pyDocLines, stringLiteral, wellFormed } from "./escape.ts"

type Target = "go" | "python" | "rust" | "ts"
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
	go: (cp) => cp === 0x22 || cp === 0x5c || cp < 0x20 || cp === 0x7f || cp === 0xfeff,
	python: (cp) => cp === 0x22 || cp === 0x5c || cp < 0x20 || cp === 0x7f || [0x85, 0x2028, 0x2029, 0xfeff].includes(cp),
	rust: (cp) => cp === 0x22 || cp === 0x5c || cp < 0x20 || cp === 0x7f || cp === 0xfeff,
	ts: (cp) => cp === 0x22 || cp === 0x5c || cp < 0x20 || [0x2028, 0x2029, 0xfeff].includes(cp),
}

const SIMPLE: Readonly<Record<Target, Readonly<Record<string, string>>>> = {
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

/** The numeric escapes each target's grammar allows, past its simple ones. */
const NUMERIC: Readonly<Record<Target, (text: string, at: number) => Escape>> = {
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

/** Read a `"…"` literal of `target` from the start of `text`, as that language's lexer does. */
function decode(target: Target, text: string): Decoded {
	if (text[0] !== '"') throw new Error("no opening quote")
	let value = ""
	const escaped: number[] = []
	for (let at = 1; at < text.length;) {
		const ch = String.fromCodePoint(text.codePointAt(at) as number)
		if (ch === '"') return { end: at + 1, escaped, value }
		if (ch === "\n" && target !== "rust") throw new Error("raw newline in a string")
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

const TARGETS: readonly Target[] = ["go", "python", "rust", "ts"]

function input(r: Rng): string {
	let out = ""
	for (let n = r.int(24); n > 0; n--) out += r.pick(TOKENS)
	return out
}

/** What is wrong with `target`'s literal of `text`, or `null`. */
function literalProblem(target: Target, text: string): string | null {
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
function commentProblem(text: string): string | null {
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

/** Every failing case of `runs` random inputs from `salt`, as labels: none is the pass. */
function failures(salt: number, problem: (text: string) => string | null): string[] {
	const r = rng(salt)
	const out: string[] = []
	for (let i = 0, n = runs(10_000, 1_000_000); i < n && out.length < 10; i++) {
		const text = input(r)
		const found = problem(text)
		if (found !== null) out.push(`${found}: ${caseLabel(salt, i, text)}`)
	}
	return out
}

/* 10⁶ inputs per target under CI take seconds */
const FUZZ_TIMEOUT = 120_000

describe("F2: every string literal round-trips, closed, escaping only what it must", () => {
	it.each(TARGETS)(
		"%s",
		(target) => {
			expect(failures(TARGETS.indexOf(target) + 1, (text) => literalProblem(target, text))).toEqual([])
		},
		FUZZ_TIMEOUT,
	)
})

describe("F2: comment text never leaves its comment", () => {
	it(
		"keeps every line one comment line, a block comment open to its end, and a docstring inert",
		() => {
			expect(failures(9, commentProblem)).toEqual([])
		},
		FUZZ_TIMEOUT,
	)
})
