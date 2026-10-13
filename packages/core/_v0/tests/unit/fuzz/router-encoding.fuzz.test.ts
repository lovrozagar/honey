import { describe, expect, it } from "vitest"
import { generateRouteTreeFromApp } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import { expandOptional, parsePattern, type Segment } from "../../../src/pattern.ts"
import { normalizePath } from "../../../src/request-path.ts"
import type { RouteTree } from "../../../src/tree.ts"
import { caseLabel, rng, runs, type Rng } from "./rng.ts"

/*
 * The router against a naive reference on paths a client can actually send: literals with
 * characters a URL encodes, existing escapes, dot segments (plain and `%2e`), empty segments,
 * trailing slashes and encoded separators. The reference reads the normalized path the way the
 * policy documents it — a literal matches its percent-encoded form, a param or wildcard value
 * is decoded (raw when it is not valid UTF-8 escapes), an encoded separator is 400 — and picks
 * the route by the documented precedence. Runtime, snapshot and generated-tree apps must all
 * agree with it. Method handling is covered by tests/unit/tree/router-property.test.ts.
 */

const LITERALS = ["a", "b", "é", "a b", "x^y", "%61", "~u", "it's"]
/* request segments: each literal raw and encoded, other values, dots, separators */
const REQUEST_SEGMENTS = [
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

type Route = { pattern: string; segs: Segment[] }

function randomRoute(r: Rng): Route {
	const depth = r.int(4)
	const parts: string[] = []
	for (let d = 0; d < depth; d++) {
		const last = d === depth - 1
		const roll = r()
		if (roll < 0.6) parts.push(r.pick(LITERALS))
		else if (roll < 0.85 || !last) parts.push(`:p${d}${last && r.bool(0.2) ? "?" : ""}`)
		else parts.push("*w")
	}
	const pattern = `/${parts.join("/")}`
	return { pattern, segs: parsePattern(pattern) }
}

function safeDecode(s: string): string {
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
function match(
	variant: Segment[],
	path: string[],
	trailing: boolean,
): { rank: number[]; params: Record<string, string> } | null {
	const rank: number[] = []
	const params: Record<string, string> = {}
	for (let i = 0; i < variant.length; i++) {
		const seg = variant[i]
		if (seg.k === "wildcard") {
			rank.push(2)
			const rest = path.slice(i).join("/")
			params[seg.n] = safeDecode(trailing && path.length > i ? `${rest}/` : rest)
			return { params, rank }
		}
		if (i >= path.length) return null
		if (seg.k === "static") {
			if (seg.v !== path[i]) return null
			rank.push(0)
		} else {
			rank.push(1)
			params[seg.n] = safeDecode(path[i])
		}
	}
	if (variant.length !== path.length) return null
	rank.push(0)
	return { params, rank }
}

function compareRank(a: number[], b: number[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
	return a.length - b.length
}

type Outcome = { status: number; route?: string; params?: Record<string, string> }

function reference(routes: Route[], target: string): Outcome {
	const parsed = new URL(`http://x${target}`).pathname
	const normalized = normalizePath(parsed)
	if (normalized === null) return { status: 400 }
	const path = normalized.split("/").filter((s) => s !== "")
	const trailing = normalized.length > 1 && normalized.endsWith("/")
	let best: { route: string; rank: number[]; params: Record<string, string> } | null = null
	for (const route of routes) {
		for (const variant of expandOptional(route.segs)) {
			const m = match(variant, path, trailing)
			if (m === null) continue
			if (best === null || compareRank(m.rank, best.rank) < 0) best = { ...m, route: route.pattern }
		}
	}
	return best === null ? { status: 404 } : { params: best.params, route: best.route, status: 200 }
}

/** Distinct routes the router accepts together (same-shape patterns would be a duplicate). */
function accepted(candidates: Route[]): Route[] {
	const out: Route[] = []
	for (const route of candidates) {
		const probe = honey()
		try {
			for (const r of [...out, route]) probe.get(r.pattern).handler((c) => c.res.text("ok", ""))
			probe.toRouteTree()
		} catch {
			continue
		}
		out.push(route)
	}
	return out
}

function register(app: ReturnType<typeof honey>, routes: Route[]): void {
	for (const route of routes) {
		app.get(route.pattern).handler((c) => c.res.json("ok", { params: c.params, route: route.pattern }))
	}
}

async function loadGenerated(code: string): Promise<RouteTree> {
	const { transform } = await import("esbuild")
	const { code: js } = await transform(code, { format: "esm", loader: "ts", target: "esnext" })
	const mod = (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as {
		routeTree: RouteTree
	}
	return mod.routeTree
}

async function observe(app: { fetch(r: Request, e: object): Response | Promise<Response> }, target: string) {
	const res = await app.fetch(new Request(`http://x${target}`), {})
	if (res.status !== 200) return { status: res.status }
	const body = (await res.json()) as { params: Record<string, string>; route: string }
	return { params: { ...body.params }, route: body.route, status: 200 }
}

describe("fuzz: router on encoded, dotted and empty segments", () => {
	it("runtime, snapshot and generated trees agree with the reference", async () => {
		const r = rng(31)
		for (let round = 0; round < runs(60); round++) {
			const routes = accepted(Array.from({ length: 2 + r.int(7) }, () => randomRoute(r)))
			const runtime = honey()
			register(runtime, routes)
			const snapshot = honey().routeTree(runtime.toRouteTree())
			const apps: Array<[string, { fetch(r: Request, e: object): Response | Promise<Response> }]> = [
				["runtime", runtime],
				["snapshot", snapshot],
			]
			if (round % 4 === 0) {
				const hydrated = honey().routeTree(await loadGenerated(generateRouteTreeFromApp(runtime)))
				register(hydrated, routes)
				apps.push(["generated", hydrated])
			}
			for (let q = 0; q < 20; q++) {
				const depth = r.int(5)
				const parts = Array.from({ length: depth }, () => r.pick(REQUEST_SEGMENTS))
				const target = `/${parts.join("/")}${r.bool(0.1) ? "/" : ""}`
				const expected = reference(routes, target)
				for (const [mode, app] of apps) {
					const label = caseLabel(31, round, { mode, routes: routes.map((x) => x.pattern), target })
					expect(await observe(app, target), label).toEqual(expected)
				}
			}
		}
	})
})
