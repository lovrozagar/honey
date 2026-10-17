/**
 * The F2 fuzz: the one string-escape layer every emitter writes through. For random text, each
 * target's literal must (a) decode, by a reader written from that language's spec and never from
 * the escaper, back to the text (unpaired surrogates as U+FFFD); (b) be closed: the reader ends
 * exactly at the literal's last character, and no character the target forbids raw appears raw;
 * (c) escape nothing the target does not require. TypeScript is also evaluated for real.
 */
import { describe, expect, it } from "vitest"
import { commentProblem, failures, literalProblem, TARGETS } from "./__fixtures__/escape-oracle.ts"
import { commentText, csDocLines } from "./escape.ts"

/* 10⁶ inputs per target under CI take seconds */
const FUZZ_TIMEOUT = 120_000

describe("F2: every string literal round-trips, closed, escaping only what it must", () => {
	it("reads C# by its own lexer's rules", () => {
		expect(TARGETS).toContain("csharp")
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
