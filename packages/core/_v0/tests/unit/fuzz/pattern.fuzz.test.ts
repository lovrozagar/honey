import { describe, expect, it } from "vitest"
import {
	canonical,
	expandOptional,
	joinPatterns,
	normalizePattern,
	parsePattern,
	pathInScope,
	scopeCoverage,
	type Segment,
} from "../../../src/pattern.ts"
import { caseLabel, rng, runs, stringOf, type Rng } from "./rng.ts"

/*
 * The route-pattern grammar is the one parser behind registration, the tree, scopes, codegen
 * selectors and OpenAPI paths. Properties: it accepts or rejects with its own error and nothing
 * else; canonical text re-parses to the same segments; joining two patterns gives what parsing
 * their concatenation gives; and a scope's static coverage decision agrees with the runtime
 * guard on every concrete path the route can serve.
 */

const PATTERN_ALPHABET = [
	"/",
	"//",
	"a",
	"admin",
	":id",
	":id?",
	":x-y",
	":1bad",
	":",
	"*",
	"*rest",
	"*1",
	"?",
	".",
	"..",
	"#",
	"%61",
	"é",
	" ",
	"-",
	"_",
	"$",
]

function patternError(e: unknown): boolean {
	return e instanceof Error && e.message.startsWith("Invalid route pattern")
}

describe("fuzz: parsePattern", () => {
	it("accepts or rejects with a pattern error, and canonical text re-parses to the same segments", () => {
		const r = rng(21)
		for (let i = 0; i < runs(5000); i++) {
			const raw = stringOf(r, PATTERN_ALPHABET, 8)
			const label = caseLabel(21, i, raw)
			let segs: Segment[]
			try {
				segs = parsePattern(raw)
			} catch (e) {
				expect(patternError(e), `${label} threw ${String(e)}`).toBe(true)
				continue
			}
			const text = canonical(segs)
			expect(parsePattern(text), label).toEqual(segs)
			expect(normalizePattern(text), label).toBe(text)
			expect(text.startsWith("/"), label).toBe(true)
			expect(text === "/" || !text.endsWith("/"), label).toBe(true)
			expect(text.includes("//"), label).toBe(false)
			for (const v of expandOptional(segs)) {
				for (const s of v) expect(s.k === "param" && s.o, label).toBe(false)
			}
		}
	})

	it("joinPatterns(a, b) is parsing a + b, and its result always parses", () => {
		const r = rng(22)
		for (let i = 0; i < runs(5000); i++) {
			const a = stringOf(r, PATTERN_ALPHABET, 4)
			const b = stringOf(r, PATTERN_ALPHABET, 4)
			const label = caseLabel(22, i, [a, b])
			let joined: string | Error
			try {
				joined = joinPatterns(a, b)
			} catch (e) {
				expect(patternError(e), `${label} threw ${String(e)}`).toBe(true)
				joined = e as Error
			}
			let whole: string | Error
			try {
				whole = normalizePattern(`${a}/${b}`)
			} catch (e) {
				whole = e as Error
			}
			if (typeof joined === "string") {
				expect(normalizePattern(joined), label).toBe(joined)
				expect(whole, label).toBe(joined)
			} else {
				expect(typeof whole === "string" ? `accepted ${whole}` : "rejected", label).toBe("rejected")
			}
		}
	})
})

/* ---------------------------------------------------------------- scope coverage vs guard */

const STATICS = ["admin", "users", "x"]

function randomSegments(r: Rng, depth: number, names: string): Segment[] {
	const segs: Segment[] = []
	for (let d = 0; d < depth; d++) {
		const last = d === depth - 1
		const roll = r()
		if (roll < 0.5) segs.push({ k: "static", v: r.pick(STATICS) })
		else if (roll < 0.85 || !last) segs.push({ k: "param", n: `${names}${d}`, o: last && r.bool(0.25) })
		else segs.push({ k: "wildcard", n: `${names}w` })
	}
	return segs
}

/** Concrete request paths a route serves: params take scope literals, encoded literals, or other values. */
function concretePaths(r: Rng, route: Segment[], count: number): string[] {
	const VALUES = ["admin", "users", "x", "%61dmin", "%75sers", "other", "Admin"]
	const out: string[] = []
	for (let c = 0; c < count; c++) {
		for (const variant of expandOptional(route)) {
			const parts: string[] = []
			for (const seg of variant) {
				if (seg.k === "static") parts.push(seg.v)
				else if (seg.k === "param") parts.push(r.pick(VALUES))
				else for (let n = r.int(3); n > 0; n--) parts.push(r.pick(VALUES))
			}
			out.push(`/${parts.join("/")}`)
		}
	}
	return out
}

/** Reference for pathInScope: the path's leading segments match the scope, compared raw or decoded. */
function inScopeReference(path: string, scope: Segment[]): boolean {
	const segs = path.split("/").filter((s) => s !== "")
	for (let i = 0; i < scope.length; i++) {
		const s = scope[i]
		if (s.k === "wildcard" || (s.k === "param" && s.o)) return true
		const seg = segs[i]
		if (seg === undefined) return false
		if (s.k === "static" && seg !== s.v && decodeURIComponent(seg) !== s.v) return false
	}
	return true
}

describe("fuzz: scope coverage", () => {
	it("a static coverage decision agrees with the runtime guard on every path the route serves", () => {
		const r = rng(23)
		for (let i = 0; i < runs(3000); i++) {
			const route = randomSegments(r, r.int(4), "p")
			const scope = randomSegments(r, r.int(3), "s")
			const label = caseLabel(23, i, [canonical(route), canonical(scope)])
			const coverage = scopeCoverage(route, scope)
			for (const path of concretePaths(r, route, 4)) {
				const guarded = pathInScope(path, scope)
				expect(guarded, `${label} path=${path}`).toBe(inScopeReference(path, scope))
				if (coverage === "all") expect(guarded, `${label} all, path=${path}`).toBe(true)
				if (coverage === "none") expect(guarded, `${label} none, path=${path}`).toBe(false)
			}
		}
	})
})
