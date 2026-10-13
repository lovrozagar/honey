import { describe, expect, it } from "vitest"
import { normalizePath } from "../../../src/request-path.ts"
import { caseLabel, rng, runs, stringOf } from "./rng.ts"

/*
 * normalizePath is the one path every routing and forwarding decision reads. Properties:
 * it never throws, its output is canonical (and so a fixed point), it never contains a dot
 * segment, an empty segment or a character a URL path cannot hold raw, and on every input a
 * WHATWG URL parser also accepts it agrees with that parser — so a runtime that hands the app
 * the raw target and one that parses it first route the same bytes the same way.
 */

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

function randomTarget(r: ReturnType<typeof rng>): string {
	return `/${stringOf(r, ALPHABET, 12)}`
}

/** What a WHATWG parser makes of the target, with empty segments collapsed as the policy says. */
function whatwg(target: string): string | null {
	let pathname: string
	try {
		/* WHATWG parsers disagree on `^` (Node 26 encodes it, Node 22 and Deno leave it raw);
		 * normalizePath always encodes it, so the oracle applies the same rule */
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
 * Inputs a WHATWG comparison cannot speak for: a URL parser strips tabs and newlines and trims
 * trailing controls and spaces (an HTTP request target cannot hold any of them), and it
 * resolves `..` against empty segments where this policy collapses them first. No runtime
 * hands the app such a target raw — Node's adapter, Bun, Deno and Workers all parse the target
 * with a URL parser before `fetch` — so the router only ever sees the parsed form, whose dot
 * segments are already resolved.
 */
function comparable(raw: string): boolean {
	if (/[\t\n\r]/.test(raw) || raw.charCodeAt(raw.length - 1) <= 0x20) return false
	return !raw.replaceAll("\\", "/").includes("//")
}

describe("fuzz: normalizePath", () => {
	it("never throws, and returns a canonical fixed point or null for an encoded separator", () => {
		const r = rng(11)
		for (let i = 0; i < runs(4000); i++) {
			const raw = randomTarget(r)
			const label = caseLabel(11, i, raw)
			const out = normalizePath(raw)
			if (hasEncodedSlash(raw)) {
				expect(out, label).toBeNull()
				const allowed = normalizePath(raw, "allow")
				expect(allowed, label).not.toBeNull()
				expect(normalizePath(allowed as string, "allow"), label).toBe(allowed)
				continue
			}
			expect(out, label).not.toBeNull()
			const path = out as string
			expect(path.startsWith("/"), label).toBe(true)
			expect(path.includes("//"), label).toBe(false)
			expect(path.includes("\\"), label).toBe(false)
			for (const seg of path.split("/")) expect(DOT.test(seg), label).toBe(false)
			for (let c = 0; c < path.length; c++) {
				const code = path.charCodeAt(c)
				expect(code > 0x20 && code < 0x7f && !'"<>`{}'.includes(path[c]), label).toBe(true)
			}
			expect(normalizePath(path), label).toBe(path)
		}
	})

	it("agrees with a WHATWG URL parser on every target both accept", () => {
		const r = rng(12)
		for (let i = 0; i < runs(4000); i++) {
			const raw = randomTarget(r)
			if (hasEncodedSlash(raw) || raw.includes("%") || raw.includes("\\") || !comparable(raw)) continue
			const expected = whatwg(raw)
			if (expected === null) continue
			expect(normalizePath(raw), caseLabel(12, i, raw)).toBe(expected)
		}
	})

	it("routes a parsed target the same as the raw one", () => {
		const r = rng(14)
		for (let i = 0; i < runs(4000); i++) {
			const raw = randomTarget(r)
			if (hasEncodedSlash(raw) || /[\t\n\r]/.test(raw)) continue
			let parsed: string
			try {
				parsed = new URL(raw, "http://h").pathname
			} catch {
				continue
			}
			const direct = normalizePath(raw)
			const viaUrl = normalizePath(parsed)
			/* a parsed target never has empty segments before a dot segment; see comparable() */
			if (comparable(raw)) expect(viaUrl, caseLabel(14, i, raw)).toBe(direct)
			expect(viaUrl === null || normalizePath(viaUrl) === viaUrl, caseLabel(14, i, raw)).toBe(true)
		}
	})

	it("agrees with a WHATWG URL parser on backslashes and percent escapes", () => {
		const r = rng(13)
		for (let i = 0; i < runs(4000); i++) {
			const raw = randomTarget(r)
			if (hasEncodedSlash(raw) || !comparable(raw)) continue
			const expected = whatwg(raw)
			if (expected === null) continue
			expect(normalizePath(raw), caseLabel(13, i, raw)).toBe(expected)
		}
	})
})
