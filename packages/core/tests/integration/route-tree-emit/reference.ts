/**
 * Naive reference matchers for the route-tree property suites. Each encodes the documented
 * precedence directly: at each segment a static beats a param beats a wildcard, a route ending
 * here beats a wildcard matching nothing, and within one leaf the exact method beats GET-for-HEAD
 * beats ALL. `methodReference` covers methods over plain segments; `pathReference` covers paths a
 * client sends (encoded literals, dot and empty segments, encoded separators) over GET routes.
 */
import { type Honey, honey } from "../../../src/routing/app.ts"
import { expandOptional, parsePattern, type Segment } from "../../../src/routing/pattern.ts"
import { normalizePath } from "../../../src/routing/request-path.ts"
import { createNode, insertRoute } from "../../../src/routing/tree.ts"
import type { Rng } from "../security/rng.ts"

export type Fetcher = { fetch: (request: Request, env: {}) => Response | Promise<Response> }

const METHODS = ["GET", "POST", "DELETE", "ALL", "HEAD"] as const
export const REQUEST_METHODS = ["GET", "POST", "DELETE", "HEAD", "PUT"] as const
const STATICS = ["a", "b", "me", "x"]
const LITERALS = ["a", "b", "é", "a b", "x^y", "%61", "~u", "it's"]
/** Request segments: each literal raw and encoded, other values, dots, separators. */
export const REQUEST_SEGMENTS = [
	...LITERALS,
	"%C3%A9",
	"a%20b",
	"x%5Ey",
	"%7Eu",
	"A",
	"v",
	"%zz",
	"%E2%82%AC",
	".",
	"..",
	"%2e",
	"%2E%2e",
	"",
	"c%2Fd",
	"c%5cd",
]

export type RandomRoute = { readonly method: (typeof METHODS)[number]; readonly pattern: string }

/** A random pattern of up to three segments from `statics`: one param name per depth, a wildcard or optional param last. */
function randomPattern(r: Rng, statics: readonly string[]): string {
	const depth = r.int(4)
	const parts: string[] = []
	for (let d = 0; d < depth; d++) {
		const last = d === depth - 1
		const roll = r()
		if (roll < 0.55) parts.push(r.pick(statics))
		else if (roll < 0.85 || !last) parts.push(`:p${d}${last && r.bool(0.2) ? "?" : ""}`)
		else parts.push("*w")
	}
	return `/${parts.join("/")}`
}

/** A random route over plain segments and every method, `ALL` included. */
export const randomMethodRoute = (r: Rng): RandomRoute => ({
	method: r.pick(METHODS),
	pattern: randomPattern(r, STATICS),
})

/** A random GET route over literals a URL encodes. */
export const randomPathRoute = (r: Rng): RandomRoute => ({ method: "GET", pattern: randomPattern(r, LITERALS) })

/** A random request path over plain segments, sometimes with a trailing or doubled slash. */
export function randomPath(r: Rng): string {
	const parts = Array.from({ length: r.int(5) }, () => (r.bool(0.7) ? r.pick(STATICS) : `v${r.int(3)}`))
	const path = `/${parts.join("/")}${r.bool(0.1) ? "/" : ""}`
	return r.bool(0.05) ? path.replace("/", "//") : path
}

/** Distinct routes the router accepts together: a duplicate leaf is dropped. */
export function accepted(candidates: readonly RandomRoute[]): RandomRoute[] {
	const scratch = createNode()
	const seen = new Set<string>()
	return candidates.filter((route) => {
		const id = `${route.method} ${route.pattern}`
		if (seen.has(id)) return false
		try {
			insertRoute(scratch, route.method, route.pattern)
		} catch {
			return false
		}
		seen.add(id)
		return true
	})
}

/** Register `routes` on `app`: each answers with its route id and params. */
export function register(app: Honey<{}>, routes: readonly RandomRoute[]): void {
	for (const { method, pattern } of routes) {
		const id = `${method} ${pattern}`
		const start = method === "ALL" ? app.all(pattern) : app.on([method], pattern)
		start.handler((c) => c.res.json("ok", { params: { ...c.params }, route: id }, { headers: { "x-route": id } }))
	}
}

type Match = { params: Record<string, string>; rank: number[] }

const safeDecode = (s: string): string => {
	try {
		return decodeURIComponent(s)
	} catch {
		return s
	}
}

/**
 * Rank of a concrete variant against path segments (lower wins), with the params it binds. A
 * wildcard takes the rest of the path as sent, a trailing slash included (`/f/x/` → `x/`).
 */
function match(variant: readonly Segment[], path: readonly string[], trailing: boolean): Match | null {
	const rank: number[] = []
	const params: Record<string, string> = {}
	for (const [i, seg] of variant.entries()) {
		if (seg.k === "wildcard") {
			const rest = path.slice(i).join("/")
			params[seg.n] = safeDecode(trailing && path.length > i ? `${rest}/` : rest)
			return { params, rank: [...rank, 2] }
		}
		if (i >= path.length) return null
		if (seg.k === "static" && seg.v !== path[i]) return null
		if (seg.k === "param") params[seg.n] = safeDecode(path[i] as string)
		rank.push(seg.k === "static" ? 0 : 1)
	}
	return variant.length === path.length ? { params, rank: [...rank, 0] } : null
}

function compareRank(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return (a[i] as number) - (b[i] as number)
	return a.length - b.length
}

function methodScore(routeMethod: string, method: string): number | null {
	if (routeMethod === method) return 0
	if (method === "HEAD" && routeMethod === "GET") return 1
	return routeMethod === "ALL" ? 2 : null
}

export type MethodOutcome = { allow?: string[]; route?: string; status: number }

/** Which route answers `method` `rawPath`, or 404, or 405 with its Allow set. */
export function methodReference(routes: readonly RandomRoute[], method: string, rawPath: string): MethodOutcome {
	const path = rawPath.split("/").filter((s) => s.length > 0)
	let best: { rank: number[]; route: string; score: number } | null = null
	const allowed = new Set<string>()
	for (const route of routes) {
		for (const variant of expandOptional(parsePattern(route.pattern))) {
			const m = match(variant, path, false)
			if (m === null) continue
			const score = methodScore(route.method, method)
			if (score === null) {
				if (route.method !== "ALL") allowed.add(route.method)
				continue
			}
			const c = best === null ? -1 : compareRank(m.rank, best.rank)
			if (best === null || c < 0 || (c === 0 && score < best.score))
				best = { rank: m.rank, route: `${route.method} ${route.pattern}`, score }
		}
	}
	if (best !== null) return { route: best.route, status: 200 }
	return allowed.size > 0 ? { allow: [...allowed].sort(), status: 405 } : { status: 404 }
}

/** What `app` answers `method` `path`: the route, or the status and Allow set. */
export async function observeMethod(app: Fetcher, method: string, path: string): Promise<MethodOutcome> {
	const res = await app.fetch(new Request(`http://x${path}`, { method }), {})
	const out: MethodOutcome = { status: res.status }
	if (res.status === 200) out.route = res.headers.get("x-route") ?? undefined
	if (res.status === 405) {
		const allow = (res.headers.get("allow") ?? "").split(",").map((s) => s.trim())
		out.allow = allow.filter(Boolean).sort()
	}
	return out
}

export type PathOutcome = { params?: Record<string, string>; route?: string; status: number }

/** Which GET route answers `target` as a client sends it, and its decoded params; 400 on an encoded separator. */
export function pathReference(routes: readonly RandomRoute[], target: string): PathOutcome {
	const normalized = normalizePath(new URL(`http://x${target}`).pathname)
	if (normalized === null) return { status: 400 }
	const path = normalized.split("/").filter((s) => s !== "")
	const trailing = normalized.length > 1 && normalized.endsWith("/")
	let best: (Match & { route: string }) | null = null
	for (const route of routes) {
		for (const variant of expandOptional(parsePattern(route.pattern))) {
			const m = match(variant, path, trailing)
			if (m !== null && (best === null || compareRank(m.rank, best.rank) < 0))
				best = { ...m, route: `${route.method} ${route.pattern}` }
		}
	}
	return best === null ? { status: 404 } : { params: best.params, route: best.route, status: 200 }
}

/** What `app` answers a GET of `target`: the route and its params, or the status. */
export async function observePath(app: Fetcher, target: string): Promise<PathOutcome> {
	const res = await app.fetch(new Request(`http://x${target}`), {})
	if (res.status !== 200) return { status: res.status }
	const body = (await res.json()) as { params: Record<string, string>; route: string }
	return { params: { ...body.params }, route: body.route, status: 200 }
}

/** A fresh app serving `routes`. */
export function runtimeApp(routes: readonly RandomRoute[]): Honey<{}> {
	const app = honey<{}>()
	register(app, routes)
	return app
}
