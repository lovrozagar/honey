import { describe, expect, it } from "vitest"
import { bodyParserFor, isJsonMediaType, parseMediaType } from "../../../src/media-type.ts"
import { caseLabel, rng, runs, stringOf, type Rng } from "./rng.ts"

/*
 * One media-type parser decides which body parser runs and which limits apply. Properties: it
 * never throws; case and optional whitespace never change the result; parameters never change
 * the essence; JSON is selected for exactly `application/json` and `+json` types; and a value
 * that is not `token/token` is never a media type.
 */

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

function vary(r: Rng, s: string): string {
	let out = ""
	for (const ch of s) out += r.bool() ? ch.toUpperCase() : ch.toLowerCase()
	return out
}

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
	it("never throws on arbitrary input, and only accepts token/token", () => {
		const r = rng(51)
		for (let i = 0; i < runs(5000); i++) {
			const value = stringOf(r, [...TOKENS, ...NOISE], 6)
			const label = caseLabel(51, i, value)
			const mt = parseMediaType(value)
			if (mt === null) continue
			expect(mt.essence, label).toBe(`${mt.type}/${mt.subtype}`)
			expect(mt.essence, label).toBe(mt.essence.toLowerCase())
			expect(/^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(mt.essence), label).toBe(true)
			expect(Object.getPrototypeOf(mt.params), label).toBeNull()
		}
	})

	it("case, whitespace and parameters never change the essence or the parser chosen", () => {
		const r = rng(52)
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
			const label = caseLabel(52, i, spelled)
			const a = parseMediaType(plain)
			const b = parseMediaType(spelled)
			expect(b?.essence, label).toBe(a?.essence)
			expect(bodyParserFor(spelled), label).toBe(bodyParserFor(plain))
			expect(isJsonMediaType(b), label).toBe(plain === "application/json" || subtype.endsWith("+json"))
		}
	})
})
