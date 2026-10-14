/**
 * Fuzz: the route-pattern grammar behind registration, the tree and scopes. Joining two patterns
 * gives what parsing their concatenation gives, and its result always parses; and a scope's static
 * coverage decision agrees with the runtime guard on every concrete path the route serves, so a
 * route finalize thinks a scope covers (or misses) is guarded (or not) on every request.
 */
import { describe, expect, it } from "vitest"
import {
	canonical,
	expandOptional,
	joinPatterns,
	normalizePattern,
	pathInScope,
	scopeCoverage,
	type Segment,
} from "../../../src/routing/pattern.ts"
import { caseLabel, type Rng, rng, runs, stringOf } from "./rng.ts"

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

/** A pattern's normalized text, or the pattern error it was refused with; any other throw escapes. */
function attempt(make: () => string): string | { refused: true } {
	try {
		return make()
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Invalid route pattern")) return { refused: true }
		throw error
	}
}

describe("fuzz: joining patterns", () => {
	// v0: 6f4fc025ea
	it("joinPatterns(a, b) is parsing a + b, and its result always parses", () => {
		const r = rng(22)
		const wrong: string[] = []
		for (let i = 0; i < runs(5000); i++) {
			const [a, b] = [stringOf(r, PATTERN_ALPHABET, 4), stringOf(r, PATTERN_ALPHABET, 4)]
			const joined = attempt(() => joinPatterns(a, b))
			const whole = attempt(() => normalizePattern(`${a}/${b}`))
			const stable = typeof joined !== "string" || normalizePattern(joined) === joined
			if (!stable || JSON.stringify(joined) !== JSON.stringify(whole)) wrong.push(caseLabel(22, i, [a, b]))
		}
		expect(wrong).toEqual([])
	})
})

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

const VALUES = ["admin", "users", "x", "%61dmin", "%75sers", "other", "Admin"]

/** One request path a variant serves: its params take scope literals, encoded literals, or other values. */
function concretePath(r: Rng, variant: readonly Segment[]): string {
	const parts: string[] = []
	for (const seg of variant) {
		if (seg.k === "static") parts.push(seg.v)
		else if (seg.k === "param") parts.push(r.pick(VALUES))
		else for (let n = r.int(3); n > 0; n--) parts.push(r.pick(VALUES))
	}
	return `/${parts.join("/")}`
}

/** `count` rounds of request paths, one per variant of the route. */
function concretePaths(r: Rng, route: Segment[], count: number): string[] {
	const out: string[] = []
	for (let c = 0; c < count; c++) for (const variant of expandOptional(route)) out.push(concretePath(r, variant))
	return out
}

/** A reference for pathInScope: the path's leading segments match the scope, compared raw or decoded. */
function inScopeReference(path: string, scope: Segment[]): boolean {
	const segs = path.split("/").filter((s) => s !== "")
	for (const [i, s] of scope.entries()) {
		if (s.k === "wildcard" || (s.k === "param" && s.o)) return true
		const seg = segs[i]
		if (seg === undefined) return false
		if (s.k === "static" && seg !== s.v && decodeURIComponent(seg) !== s.v) return false
	}
	return true
}

describe("fuzz: scope coverage", () => {
	// v0: 9227524db8
	it("a static coverage decision agrees with the runtime guard on every path the route serves", () => {
		const r = rng(23)
		const wrong: string[] = []
		for (let i = 0; i < runs(3000); i++) {
			const route = randomSegments(r, r.int(4), "p")
			const scope = randomSegments(r, r.int(3), "s")
			const coverage = scopeCoverage(route, scope)
			for (const path of concretePaths(r, route, 4)) {
				const guarded = pathInScope(path, scope)
				const decided = coverage === "some" || guarded === (coverage === "all")
				if (guarded !== inScopeReference(path, scope) || !decided)
					wrong.push(`${caseLabel(23, i, [canonical(route), canonical(scope)])} path=${path}`)
			}
		}
		expect(wrong).toEqual([])
	})
})
