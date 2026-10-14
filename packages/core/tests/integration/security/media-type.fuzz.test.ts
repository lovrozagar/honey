/**
 * Fuzz: one media-type parser decides which body parser runs. It never throws; it accepts only
 * `token/token`, lowercased, with a parameter record that has no prototype; and case, optional
 * whitespace and parameters never change the essence or the parser chosen, so `application/jsonx`
 * or `JSON` alone is never mistaken for JSON.
 */
import { describe, expect, it } from "vitest"
import { bodyParserFor, isJsonMediaType, parseMediaType } from "../../../src/response/media-type.ts"
import { caseLabel, type Rng, rng, runs, stringOf } from "./rng.ts"

const TOKENS = [
	"application",
	"text",
	"multipart",
	"json",
	"vnd.api+json",
	"problem+json",
	"jsonx",
	"plain",
	"form-data",
]
const NOISE = ["/", ";", "=", '"', "\\", " ", "\t", ",", "+", "x", "JSON", "é", "(", ")", "charset", "utf-8"]
const ESSENCE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/

/** `s` with each letter's case chosen at random. */
function vary(r: Rng, s: string): string {
	let out = ""
	for (const ch of s) out += r.bool() ? ch.toUpperCase() : ch.toLowerCase()
	return out
}

/** Zero to two parameters, token or quoted values, with optional spaces around the `;`. */
function randomParams(r: Rng): string {
	let out = ""
	for (let n = r.int(3); n > 0; n--) {
		const name = r.pick(["charset", "boundary", "q", "x-y"])
		const value = r.bool() ? r.pick(["utf-8", "abc", "1"]) : `"${r.pick(["a;b", 'q\\"x', "", "x y"])}"`
		out += `${r.bool() ? " " : ""};${r.bool() ? " " : ""}${name}=${value}`
	}
	return out
}

describe("fuzz: parseMediaType", () => {
	// v0: 5aecf2f542
	it("never throws on arbitrary input, and accepts only a lowercased token/token", () => {
		const r = rng(51)
		const wrong: string[] = []
		for (let i = 0; i < runs(5000); i++) {
			const value = stringOf(r, [...TOKENS, ...NOISE], 6)
			const mt = parseMediaType(value)
			if (mt === null) continue
			const sound =
				mt.essence === `${mt.type}/${mt.subtype}` &&
				ESSENCE.test(mt.essence) &&
				Object.getPrototypeOf(mt.params) === null
			if (!sound) wrong.push(caseLabel(51, i, value))
		}
		expect(wrong).toEqual([])
	})

	// v0: f5d0a72c5b
	it("case, whitespace and parameters never change the essence or the parser chosen", () => {
		const r = rng(52)
		const wrong: string[] = []
		for (let i = 0; i < runs(5000); i++) {
			const type = r.pick(["application", "text", "multipart"])
			const subtype = r.pick([
				"json",
				"vnd.api+json",
				"problem+json",
				"jsonx",
				"plain",
				"form-data",
				"x-www-form-urlencoded",
			])
			const plain = `${type}/${subtype}`
			const spelled = `${r.bool() ? " " : ""}${vary(r, type)}/${vary(r, subtype)}${r.bool() ? "\t" : ""}${randomParams(r)}`
			const sound =
				parseMediaType(spelled)?.essence === parseMediaType(plain)?.essence &&
				bodyParserFor(spelled) === bodyParserFor(plain) &&
				isJsonMediaType(parseMediaType(spelled)) === (plain === "application/json" || subtype.endsWith("+json"))
			if (!sound) wrong.push(caseLabel(52, i, spelled))
		}
		expect(wrong).toEqual([])
	})
})
