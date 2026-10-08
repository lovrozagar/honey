import { describe, expect, it } from "vitest"
import { generateRouteTreeFromApp } from "../../../src/codegen.ts"
import { honey } from "../../../src/index.ts"
import type { RouteTree } from "../../../src/tree.ts"
import { createNode, insertRoute } from "../../../src/tree.ts"

/*
 * Property test: for random route sets and random request paths, the router built at runtime,
 * an app hydrated from the generated tree module, and an app loaded from a live snapshot all
 * agree with a naive reference matcher — which route answers, or 404, or 405 with the same
 * Allow set. The reference encodes the documented precedence directly: at each segment a
 * static route beats a param beats a wildcard, a route ending here beats a wildcard matching
 * nothing, and within one leaf the exact method beats GET-for-HEAD beats ALL.
 */

/* small deterministic PRNG — failures reproduce from the seed in the message */
function rng(seed: number): () => number {
	let s = seed >>> 0
	return () => {
		s = (s + 0x6d2b79f5) >>> 0
		let t = s
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

const STATICS = ["a", "b", "me", "x"]
const METHODS = ["GET", "POST", "DELETE", "ALL", "HEAD"] as const
const REQUEST_METHODS = ["GET", "POST", "DELETE", "HEAD", "PUT"] as const

type Seg = { k: "static"; v: string } | { k: "param"; o: boolean } | { k: "wildcard" }
type Route = { method: (typeof METHODS)[number]; pattern: string; segs: Seg[] }

function randomRoute(next: () => number): Route {
	const depth = Math.floor(next() * 4)
	const segs: Seg[] = []
	const parts: string[] = []
	for (let d = 0; d < depth; d++) {
		const last = d === depth - 1
		const r = next()
		if (r < 0.55) {
			const v = STATICS[Math.floor(next() * STATICS.length)]
			segs.push({ k: "static", v })
			parts.push(v)
		} else if (r < 0.85 || !last) {
			const optional = last && next() < 0.2
			segs.push({ k: "param", o: optional })
			/* one param name per depth: the trie allows one param child per node */
			parts.push(`:p${d}${optional ? "?" : ""}`)
		} else {
			segs.push({ k: "wildcard" })
			parts.push("*w")
		}
	}
	const method = METHODS[Math.floor(next() * METHODS.length)]
	return { method, pattern: `/${parts.join("/")}`, segs }
}

/** Concrete variants: an optional last param is the route with and without it. */
function variants(segs: Seg[]): Seg[][] {
	const last = segs[segs.length - 1]
	if (last?.k === "param" && last.o) return [segs.slice(0, -1), [...segs.slice(0, -1), { k: "param", o: false }]]
	return [segs]
}

/** Rank vector of a variant against a path, or null when it does not match. Lower wins. */
function rank(variant: Seg[], path: string[]): number[] | null {
	const out: number[] = []
	for (let i = 0; i < variant.length; i++) {
		const seg = variant[i]
		if (seg.k === "wildcard") {
			out.push(2)
			return out
		}
		if (i >= path.length) return null
		if (seg.k === "static") {
			if (seg.v !== path[i]) return null
			out.push(0)
		} else out.push(1)
	}
	if (variant.length !== path.length) return null
	out.push(0)
	return out
}

function compareRank(a: number[], b: number[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
	return a.length - b.length
}

function methodScore(routeMethod: string, method: string): number | null {
	if (routeMethod === method) return 0
	if (method === "HEAD" && routeMethod === "GET") return 1
	if (routeMethod === "ALL") return 2
	return null
}

type Expected = { allow?: string[]; id?: string; status: number }

function reference(routes: Route[], method: string, rawPath: string): Expected {
	const path = rawPath.split("/").filter((s) => s.length > 0)
	let best: { id: string; rank: number[]; score: number } | null = null
	const allowed = new Set<string>()
	for (const route of routes) {
		for (const v of variants(route.segs)) {
			const r = rank(v, path)
			if (r === null) continue
			const score = methodScore(route.method, method)
			if (score === null) {
				if (route.method !== "ALL") allowed.add(route.method)
				continue
			}
			const id = `${route.method} ${route.pattern}`
			if (best === null) best = { id, rank: r, score }
			else {
				const c = compareRank(r, best.rank)
				if (c < 0 || (c === 0 && score < best.score)) best = { id, rank: r, score }
			}
		}
	}
	if (best !== null) return { id: best.id, status: 200 }
	if (allowed.size > 0) return { allow: [...allowed].sort(), status: 405 }
	return { status: 404 }
}

function randomPath(next: () => number): string {
	const depth = Math.floor(next() * 5)
	const parts: string[] = []
	for (let d = 0; d < depth; d++) {
		const r = next()
		parts.push(r < 0.7 ? STATICS[Math.floor(next() * STATICS.length)] : `v${Math.floor(next() * 3)}`)
	}
	let path = `/${parts.join("/")}`
	if (next() < 0.1) path += "/"
	if (next() < 0.05) path = path.replace("/", "//")
	return path
}

/** Keep only routes the router accepts together (no duplicate leaves). */
function acceptedRoutes(candidates: Route[]): Route[] {
	const scratch = createNode()
	const seen = new Set<string>()
	const out: Route[] = []
	for (const route of candidates) {
		const id = `${route.method} ${route.pattern}`
		if (seen.has(id)) continue
		try {
			insertRoute(scratch, route.method, route.pattern)
		} catch {
			continue
		}
		seen.add(id)
		out.push(route)
	}
	return out
}

function register(app: ReturnType<typeof honey>, routes: Route[]): void {
	for (const route of routes) {
		const id = `${route.method} ${route.pattern}`
		const builder = (route.method === "ALL" ? app.all(route.pattern) : app.on([route.method], route.pattern)) as {
			handler(fn: (c: { res: { text(k: string, b: string, o: unknown): Response } }) => Response): unknown
		}
		builder.handler((c) => c.res.text("ok", id, { headers: { "x-route": id } }))
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

async function observe(
	app: { fetch(r: Request, e: object): Response | Promise<Response> },
	method: string,
	path: string,
) {
	const res = await app.fetch(new Request(`http://x${path}`, { method }), {})
	const out: Expected = { status: res.status }
	if (res.status === 200) out.id = res.headers.get("x-route") ?? undefined
	if (res.status === 405) {
		out.allow = (res.headers.get("allow") ?? "")
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean)
			.sort()
	}
	return out
}

describe("router ≡ loaded tree ≡ naive reference matcher", () => {
	it("agrees on random route sets and requests", async () => {
		const ROUND_COUNT = 120
		for (let round = 0; round < ROUND_COUNT; round++) {
			const seed = 1000 + round
			const next = rng(seed)
			const candidates = Array.from({ length: 2 + Math.floor(next() * 9) }, () => randomRoute(next))
			const routes = acceptedRoutes(candidates)

			const runtime = honey()
			register(runtime, routes)
			const snapshot = honey().routeTree(runtime.toRouteTree())
			const apps: Array<[string, { fetch(r: Request, e: object): Response | Promise<Response> }]> = [
				["runtime", runtime],
				["snapshot", snapshot],
			]
			/* the generated module is the expensive mode — every fourth round */
			if (round % 4 === 0) {
				const hydrated = honey().routeTree(await loadGenerated(generateRouteTreeFromApp(runtime)))
				register(hydrated, routes)
				apps.push(["generated", hydrated])
			}

			for (let q = 0; q < 25; q++) {
				const method = REQUEST_METHODS[Math.floor(next() * REQUEST_METHODS.length)]
				const path = randomPath(next)
				const expected = reference(routes, method, path)
				for (const [mode, app] of apps) {
					const got = await observe(app, method, path)
					const where = `seed ${seed}, ${mode}: ${method} ${path} over [${routes.map((r) => `${r.method} ${r.pattern}`).join(", ")}]`
					expect(got, where).toEqual(expected)
				}
			}
		}
	})

	it("static-vs-param siblings across methods: a method miss falls back to the param route", async () => {
		const app = honey()
		app.get("/u/me").handler((c) => c.res.text("ok", "me"))
		app.delete("/u/:id").handler((c) => c.res.text("ok", `del ${c.params.id}`))
		app.get("/users/me/settings").handler((c) => c.res.text("ok", "settings"))
		app.get("/users/:id/profile").handler((c) => c.res.text("ok", `profile ${c.params.id}`))
		app.get("/files/static").handler((c) => c.res.text("ok", "static"))
		app.get("/files/*path").handler((c) => c.res.text("ok", `file ${c.params.path}`))
		app.get("/admin/x").handler((c) => c.res.text("ok", "admin x"))
		app.get("/*rest").handler((c) => c.res.text("ok", `root ${c.params.rest}`))
		const text = async (method: string, path: string) =>
			(await app.fetch(new Request(`http://x${path}`, { method }), {})).text()
		expect(await text("DELETE", "/u/me")).toBe("del me")
		expect(await text("GET", "/users/me/profile")).toBe("profile me")
		expect(await text("GET", "/files/static/x")).toBe("file static/x")
		expect(await text("GET", "/admin/zzz")).toBe("root admin/zzz")
	})

	it("405 lists every method that matches the path across branches", async () => {
		const app = honey()
		app.get("/u/me").handler((c) => c.res.text("ok", "me"))
		app.post("/u/:id").handler((c) => c.res.text("ok", "id"))
		const res = await app.fetch(new Request("http://x/u/me", { method: "PUT" }), {})
		expect(res.status).toBe(405)
		expect(
			res.headers
				.get("allow")
				?.split(",")
				.map((s) => s.trim())
				.sort(),
		).toEqual(["GET", "POST"])
	})
})
