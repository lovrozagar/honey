/**
 * The F2 fuzz: the one string-escape layer every emitter writes through. For random text, each
 * target's literal must (a) decode, by a reader written from that language's spec and never from
 * the escaper, back to the text (unpaired surrogates as U+FFFD); (b) be closed: the reader ends
 * exactly at the literal's last character, and no character the target forbids raw appears raw;
 * (c) escape nothing the target does not require. TypeScript is also evaluated for real.
 */
import { describe, expect, it } from "vitest"
import { commentProblem, failures, literalProblem, TARGETS } from "./__fixtures__/escape-oracle.ts"

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
