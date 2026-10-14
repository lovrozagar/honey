/**
 * Fuzz: normalizePath, the one path every routing and forwarding decision reads. It never throws;
 * its output is canonical (a fixed point) with no dot segment, no empty segment and no character a
 * URL path cannot hold raw; an encoded separator is refused unless allowed; and on every target a
 * WHATWG URL parser also accepts, it agrees with that parser, so a runtime that hands the app the
 * raw target and one that parses it first route the same bytes the same way.
 */
import { describe, expect, it } from "vitest"
import { normalizePath } from "../../../src/routing/request-path.ts"
import { caseLabel, type Rng, rng, runs, stringOf } from "./rng.ts"

const ALPHABET = [
	"/",
	"/",
	"//",
	"a",
	"b",
	"admin",
	".",
	"..",
	"%2e",
	"%2E",
	"%2e%2E",
	".%2e",
	"%2f",
	"%2F",
	"%5c",
	"%5C",
	"%41",
	"%",
	"%zz",
	"\\",
	" ",
	"\t",
	"é",
	"🍯",
	"\ud800",
	'"',
	"<",
	">",
	"`",
	"{",
	"}",
	"|",
	"^",
	"'",
	"~",
	":",
	"@",
	"!",
	"$",
	"&",
	"(",
	"=",
	"+",
	";",
	",",
	"\u0000",
	"\u007f",
]

const DOT = /^(?:\.|%2e){1,2}$/i

function randomTarget(r: Rng): string {
	return `/${stringOf(r, ALPHABET, 12)}`
}

/** What a WHATWG parser makes of the target, empty segments collapsed as the policy says. */
function whatwg(target: string): string | null {
	let pathname: string
	try {
		/* WHATWG parsers disagree on `^` (newer Node encodes it); normalizePath always encodes it */
		pathname = new URL(target, "http://h").pathname.replaceAll("^", "%5E")
	} catch {
		return null
	}
	const segments = pathname.split("/").filter((s) => s !== "")
	if (segments.length === 0) return "/"
	const path = `/${segments.join("/")}`
	return pathname.endsWith("/") ? `${path}/` : path
}

function hasEncodedSlash(s: string): boolean {
	return /%2f|%5c/i.test(s)
}

/*
 * Targets a WHATWG comparison cannot speak for: a URL parser strips tabs and newlines and trims
 * trailing controls and spaces (a request target cannot hold them), and it resolves `..` against
 * empty segments where this policy collapses them first. No runtime hands the app such a target
 * raw: Node's adapter, Bun and Workers all parse it with a URL parser first.
 */
function comparable(raw: string): boolean {
	if (/[\t\n\r]/.test(raw) || raw.charCodeAt(raw.length - 1) <= 0x20) return false
	return !raw.replaceAll("\\", "/").includes("//")
}

/** Every way `path` could fail to be canonical, as a list of what is wrong; empty when it is. */
function flaws(path: string): string[] {
	const out: string[] = []
	if (!path.startsWith("/")) out.push("no leading slash")
	if (path.includes("//")) out.push("an empty segment")
	if (path.includes("\\")) out.push("a backslash")
	if (path.split("/").some((seg) => DOT.test(seg))) out.push("a dot segment")
	for (const ch of path) {
		const code = ch.charCodeAt(0)
		if (code <= 0x20 || code >= 0x7f || '"<>`{}'.includes(ch)) out.push(`raw ${JSON.stringify(ch)}`)
	}
	if (normalizePath(path) !== path) out.push("not a fixed point")
	return out
}

/** Run `check` over `runs(base)` random targets from `salt`; every label it returns is a disagreement. */
function sweep(salt: number, base: number, check: (raw: string) => boolean): string[] {
	const r = rng(salt)
	const wrong: string[] = []
	for (let i = 0; i < runs(base); i++) {
		const raw = randomTarget(r)
		if (!check(raw)) wrong.push(caseLabel(salt, i, raw))
	}
	return wrong
}

/** A target both this policy and a WHATWG parser speak for agrees with the parser. */
function agreesWithWhatwg(raw: string): boolean {
	const expected = whatwg(raw)
	return expected === null || normalizePath(raw) === expected
}

describe("fuzz: normalizePath, alone", () => {
	// v0: 90eb46f0fe
	it("never throws, and returns a canonical fixed point or null for an encoded separator", () => {
		const wrong = sweep(11, 4000, (raw) => {
			if (!hasEncodedSlash(raw)) {
				const out = normalizePath(raw)
				return out !== null && flaws(out).length === 0
			}
			const allowed = normalizePath(raw, "allow")
			return normalizePath(raw) === null && allowed !== null && normalizePath(allowed, "allow") === allowed
		})
		expect(wrong).toEqual([])
	})
})

describe("fuzz: normalizePath against a WHATWG URL parser", () => {
	// v0: 970f25e183
	it("agrees with it on every target both accept", () => {
		const skip = (raw: string) => hasEncodedSlash(raw) || raw.includes("%") || raw.includes("\\") || !comparable(raw)
		expect(sweep(12, 4000, (raw) => skip(raw) || agreesWithWhatwg(raw))).toEqual([])
	})

	// v0: 5c7ec6062c
	it("agrees with it on backslashes and percent escapes", () => {
		expect(sweep(13, 4000, (raw) => hasEncodedSlash(raw) || !comparable(raw) || agreesWithWhatwg(raw))).toEqual([])
	})

	// v0: c59db5a3e0
	it("routes a parsed target the same as the raw one", () => {
		const wrong = sweep(14, 4000, (raw) => {
			if (hasEncodedSlash(raw) || /[\t\n\r]/.test(raw)) return true
			let parsed: string
			try {
				parsed = new URL(raw, "http://h").pathname
			} catch {
				return true
			}
			const viaUrl = normalizePath(parsed)
			/* a parsed target never has empty segments before a dot segment; see comparable() */
			const same = !comparable(raw) || viaUrl === normalizePath(raw)
			return same && (viaUrl === null || normalizePath(viaUrl) === viaUrl)
		})
		expect(wrong).toEqual([])
	})
})
