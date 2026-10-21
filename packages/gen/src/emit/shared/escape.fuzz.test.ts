/**
 * The F2 fuzz: the one string-escape layer every emitter writes through. For random text, each
 * target's literal must (a) decode, by a reader written from that language's spec and never from
 * the escaper, back to the text (unpaired surrogates as U+FFFD); (b) be closed: the reader ends
 * exactly at the literal's last character, and no character the target forbids raw appears raw;
 * (c) escape nothing the target does not require. TypeScript is also evaluated for real.
 */
import { describe, expect, it } from "vitest"
import { commentProblem, failures, literalProblem, TARGETS } from "./__fixtures__/escape-oracle.ts"
import { caseLabel, rng, runs } from "./__fixtures__/rng.ts"
import { commentText, csDocLines, javaDocLines, javaLineComment } from "./escape.ts"

/* 10⁶ inputs per target under CI take seconds */
const FUZZ_TIMEOUT = 120_000

describe("F2: every string literal round-trips, closed, escaping only what it must", () => {
	it("reads C# by its own lexer's rules", () => {
		expect(TARGETS).toContain("csharp")
	})

	it("reads Java by its own lexer's rules", () => {
		expect(TARGETS).toContain("java")
	})

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

/* what a C# lexer ends a `///` line at, and the only markup an XML doc text may hold */
const CS_LINE_END = /[\r\n\u0085\u2028\u2029]/
const XML_TEXT = /^(?:[^<>&]|&(?:amp|lt|gt);)*$/
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", gt: ">", lt: "<" }

/** What is wrong with the C# doc lines of `text`, or `null`. */
function csDocProblem(text: string): string | null {
	const lines: readonly string[] = csDocLines(text)
	if (lines.some((line) => CS_LINE_END.test(line))) return "line break inside a /// line"
	if (lines.some((line) => !XML_TEXT.test(line))) return "markup raw in XML doc text"
	const read = lines.map((line) => line.replace(/&(amp|gt|lt);/g, (_, name: string) => ENTITIES[name] as string))
	const lineSplit = commentText(text).split(/\r\n|\r|\n|\u2028|\u2029|\u0085/)
	return read.join("\n") === lineSplit.join("\n") ? null : "doc text changed"
}

describe("F2: C# doc text never leaves its /// line or its XML", () => {
	it(
		"keeps every line one /// line of XML text that reads back as the comment text",
		() => {
			expect(failures(10, csDocProblem)).toEqual([])
		},
		FUZZ_TIMEOUT,
	)
})

/* Java's comment hazards: a `\` run of odd length before `u` is a unicode escape javac translates, so only a hidden control's own `\uHHHH` may be one */
const UNICODE_RUN = /(\\+)(u+)/g
const HEX4 = /^[0-9a-fA-F]{4}/

/* the Java comment fuzz's own tokens: the oracle's have no `@`, and a Javadoc tag is what this checks */
const JAVA_TOKENS: readonly string[] = [
	"a",
	" ",
	"@",
	"{@",
	"{",
	"}",
	"*",
	"/",
	"*/",
	"/*",
	"\\",
	"\\u",
	"\\\\u",
	"\\u0041",
	"\\uZZZZ",
	"u",
	"0041",
	"\n",
	"\r",
	"\t",
	"\0",
	"\u0001",
	"\u007f",
	"\u2028",
	"\u0085",
	"\uFEFF",
	'"',
	"\u{1F600}",
	"\uD800",
]

/** C0 but tab and line breaks, DEL and the BOM: never raw in a comment. */
const hidden = (cp: number) => (cp < 0x20 && ![0x09, 0x0a, 0x0d].includes(cp)) || cp === 0x7f || cp === 0xfeff

/** The first `\` run before `u` that javac reads as a unicode escape without four hex digits after it, or `null`. */
function unicodeProblem(source: string): string | null {
	for (const match of source.matchAll(UNICODE_RUN)) {
		const after = source.slice((match.index as number) + match[0].length)
		if ((match[1] as string).length % 2 === 1 && !HEX4.test(after)) return "bare \\u reaches the source"
	}
	return null
}

/** What is wrong with the Java comment forms of `text`, read as javac reads them, or `null`. */
function javaCommentProblem(text: string): string | null {
	const lines = javaLineComment(text)
	const doc = javaDocLines(text)
	if (lines.some((line) => !line.startsWith("//") || /[\r\n\u2028\u2029\u0085]/.test(line)))
		return "line comment broken"
	if (doc.some((line) => /[\r\n]/.test(line))) return "line break inside a Javadoc line"
	if (doc.join("\n").includes("*/")) return "Javadoc closed early"
	if (doc.some((line) => /^\s*@/.test(line)) || doc.some((line) => line.includes("{@"))) return "Javadoc tag raw"
	const source = [...lines, ...doc].join("\n")
	if ([...source].some((ch) => hidden(ch.codePointAt(0) as number))) return "control character raw in a comment"
	return unicodeProblem(source)
}

/** Every failing case of `count` random inputs from `salt` over the Java tokens (at most ten), as labels. */
function javaFailures(
	salt: number,
	problem: (text: string) => string | null,
	count = runs(10_000, 1_000_000),
): string[] {
	const r = rng(salt)
	const out: string[] = []
	for (let i = 0; i < count && out.length < 10; i++) {
		let text = ""
		for (let n = r.int(24); n > 0; n--) text += r.pick(JAVA_TOKENS)
		const found = problem(text)
		if (found !== null) out.push(`${found}: ${caseLabel(salt, i, text)}`)
	}
	return out
}

describe("F2: Java comment text never leaves its comment, and no \\u reaches javac raw", () => {
	it(
		"keeps every line one comment line, Javadoc closed, no tag raw, and every \\u javac reads a hex escape",
		() => {
			expect(javaFailures(11, javaCommentProblem)).toEqual([])
		},
		FUZZ_TIMEOUT,
	)
})
