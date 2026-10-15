import { describe, expect, it } from "vitest"
import {
	blockCommentText,
	commentText,
	goString,
	lineComment,
	pyDocLines,
	pyString,
	rustString,
	stringLiteral,
	tsString,
	wellFormed,
} from "./escape.ts"

const LONE_HIGH = "\uD800"
const LONE_LOW = "\uDC00"
const PAIR = "\u{1F600}"

describe("wellFormed: text every target can encode", () => {
	it("replaces each unpaired surrogate with U+FFFD and keeps pairs", () => {
		expect([
			wellFormed(`a${LONE_HIGH}b`),
			wellFormed(`${LONE_LOW}x`),
			wellFormed(`${LONE_LOW}${LONE_HIGH}`),
			wellFormed(PAIR),
			wellFormed(`${LONE_HIGH}${PAIR}`),
		]).toEqual(["a\uFFFDb", "\uFFFDx", "\uFFFD\uFFFD", PAIR, `\uFFFD${PAIR}`])
	})
})

describe("string literals: one escaper, one policy per target", () => {
	const nasty = `q"b\\n\nr\rt\tz\0d\u007f e\u0001 ${LONE_HIGH} \u2028\u2029\u0085\uFEFF ${PAIR}`

	it("TypeScript: JSON-style escapes, U+2028, U+2029 and the BOM visible", () => {
		expect(tsString(nasty)).toBe(
			'"q\\"b\\\\n\\nr\\rt\\tz\\u0000d\u007f e\\u0001 \uFFFD \\u2028\\u2029\u0085\\ufeff \u{1F600}"',
		)
	})

	it("Go: named escapes, \\xHH for control bytes, the BOM as \\ufeff", () => {
		expect(goString(nasty)).toBe(
			'"q\\"b\\\\n\\nr\\rt\\tz\\x00d\\x7f e\\x01 \uFFFD \u2028\u2029\u0085\\ufeff \u{1F600}"',
		)
	})

	it("Rust: named escapes and \\0, \\u{H} for other control code points and the BOM", () => {
		expect(rustString(nasty)).toBe(
			'"q\\"b\\\\n\\nr\\rt\\tz\\0d\\u{7f} e\\u{01} \uFFFD \u2028\u2029\u0085\\u{feff} \u{1F600}"',
		)
	})

	it("Python: \\xHH for control bytes, and line separators, NEL and the BOM as \\uHHHH", () => {
		expect(pyString(nasty)).toBe(
			'"q\\"b\\\\n\\nr\\rt\\tz\\x00d\\x7f e\\x01 \uFFFD \\u2028\\u2029\\u0085\\ufeff \u{1F600}"',
		)
	})

	it("routes every target through the one writer", () => {
		expect((["go", "python", "rust", "ts"] as const).map((target) => stringLiteral("a\nb", target))).toEqual([
			'"a\\nb"',
			'"a\\nb"',
			'"a\\nb"',
			'"a\\nb"',
		])
	})
})

describe("comments: text that can never become code", () => {
	it("shows control characters, DEL and the BOM as visible \\uXXXX, keeping tab and line breaks", () => {
		expect(commentText(`a\u0000b\u007fc\uFEFFd\te\nf${LONE_LOW}`)).toBe("a\\u0000b\\u007fc\\ufeffd\te\nf\uFFFD")
	})

	it("starts a new comment line at every line break, blank lines bare", () => {
		expect([
			lineComment("one\r\ntwo\u2028three\n\nfour", "//"),
			lineComment("doc", "///", "\t"),
			lineComment("  ", "#", "  "),
		]).toEqual([["// one", "// two", "// three", "//", "// four"], ["\t/// doc"], ["  #"]])
	})

	it("keeps a block comment closed and a docstring inert", () => {
		expect(blockCommentText("end */ start /* x")).toBe("end * / start / * x")
		expect(pyDocLines('say """hi""" at C:\\users\nnext"')).toEqual([
			'say \\"\\"\\"hi\\"\\"\\" at C:\\\\users',
			'next\\"',
		])
	})
})
