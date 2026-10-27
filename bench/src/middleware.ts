/**
 * Edge-middleware gate (bit 07 budget, gate B): each middleware's per-request cost through
 * `app.fetch` in process, on its working path (cors sees an Origin, csrf a same-origin POST,
 * ipRestrict a peer inside its allow range, timeout an answer in time).
 *
 *     bun bench/src/middleware.ts            # gate
 *     bun bench/src/middleware.ts --update   # record the v1-only ceilings for this runtime minor
 *
 * The eight middlewares v0 has, alone and stacked, gate v1 against v0 in the same process, as
 * streaming.ts does: interleaved samples, failing (exit 1) when v1's median is more than
 * `MIDDLEWARE_THRESHOLD` (default 0.10) over v0's AND outside the band of its own samples.
 *
 * rateLimit and compress are new in v1 (A5/A6): no v0 to compare with, so each is gated as its
 * cost over the same route without it, against a ceiling recorded per runtime minor in
 * blueprint/baselines/middleware.json, as hotpath.ts gates against its baseline. A runtime
 * without a recorded ceiling runs as a hint only.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { honey } from "../../_v0/src/index.ts"
import { cors } from "../../_v0/src/cors.ts"
import { csrf } from "../../_v0/src/csrf.ts"
import { ipRestrict } from "../../_v0/src/ip-restrict.ts"
import { poweredBy } from "../../_v0/src/powered-by.ts"
import { requestId } from "../../_v0/src/request-id.ts"
import { secureHeaders } from "../../_v0/src/secure-headers.ts"
import { serverTiming } from "../../_v0/src/server-timing.ts"
import { timeout } from "../../_v0/src/timeout.ts"
import { compress as compressV1 } from "../../packages/core/src/middleware/compress.ts"
import { cors as corsV1 } from "../../packages/core/src/middleware/cors.ts"
import { csrf as csrfV1 } from "../../packages/core/src/middleware/csrf.ts"
import { ipRestrict as ipRestrictV1 } from "../../packages/core/src/middleware/ip-restrict.ts"
import { poweredBy as poweredByV1 } from "../../packages/core/src/middleware/powered-by.ts"
import { rateLimit as rateLimitV1 } from "../../packages/core/src/middleware/rate-limit.ts"
import { requestId as requestIdV1 } from "../../packages/core/src/middleware/request-id.ts"
import { secureHeaders as secureHeadersV1 } from "../../packages/core/src/middleware/secure-headers.ts"
import { serverTiming as serverTimingV1 } from "../../packages/core/src/middleware/server-timing.ts"
import { timeout as timeoutV1 } from "../../packages/core/src/middleware/timeout.ts"
import { honey as honeyV1 } from "../../packages/core/src/routing/app.ts"
import { judge, median } from "./significance.ts"

const BASELINE_FILE = new URL("../../blueprint/baselines/middleware.json", import.meta.url)
const THRESHOLD = Number(process.env.MIDDLEWARE_THRESHOLD ?? 0.1)
const SAMPLES = Number(process.env.MIDDLEWARE_SAMPLES ?? 15)
const ITERATIONS = Number(process.env.MIDDLEWARE_ITERATIONS ?? 20_000)
/* gzip of a 4 KiB answer costs ~20x a plain one: fewer iterations keep a sample near the others' length */
const GZIP_ITERATIONS = Math.max(1, Math.round(ITERATIONS / 20))
const PEER = "203.0.113.7"
const PEER_ADDRESS = Symbol.for("honey.peerAddress")

type FetchApp = { fetch(request: Request, env: {}): Response | Promise<Response> }
type Builder = { use(mw: unknown): Builder; get(path: string): Route; post(path: string): Route }
type Route = { handler(fn: (ctx: never) => unknown): unknown }
type Ctx = {
	res: { json(key: string, body: unknown): Response }
	timing?: { end(name: string): void; start(name: string): void }
}

const SMALL = { ok: true }
const BIG = { items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}` })) }

/** GET and POST /t behind `middleware`, answering `body`; a serverTiming in the stack times one span. */
function app(make: () => unknown, middleware: readonly unknown[], body: unknown = SMALL): FetchApp {
	const root = make() as Builder
	let scope = root
	for (const mw of middleware) scope = scope.use(mw)
	const handler = (ctx: Ctx) => {
		ctx.timing?.start("db")
		ctx.timing?.end("db")
		return ctx.res.json("ok", body)
	}
	scope.get("/t").handler(handler as never)
	scope.post("/t").handler(handler as never)
	return root as unknown as FetchApp
}

const v0 = () => honey()
const v1 = () => honeyV1<{}>()

/** The eight middlewares both versions have, each configured alike and on its working path. */
const PAIRED_MIDDLEWARE = {
	cors: [() => cors(), () => corsV1()],
	csrf: [() => csrf(), () => csrfV1()],
	ipRestrict: [
		() => ipRestrict({ allowList: ["203.0.113.0/24"] }),
		() => ipRestrictV1({ allowList: ["203.0.113.0/24"] }),
	],
	poweredBy: [() => poweredBy(), () => poweredByV1()],
	requestId: [() => requestId(), () => requestIdV1()],
	secureHeaders: [() => secureHeaders(), () => secureHeadersV1()],
	serverTiming: [() => serverTiming(), () => serverTimingV1()],
	timeout: [() => timeout({ duration: 5000 }), () => timeoutV1({ duration: 5000 })],
} as const

type Paired = { method: string; versions: { v0: FetchApp; v1: FetchApp } }

function paired(): Record<string, Paired> {
	const out: Record<string, Paired> = {}
	for (const [name, [old, current]] of Object.entries(PAIRED_MIDDLEWARE)) {
		out[name] = {
			method: name === "csrf" ? "POST" : "GET",
			versions: { v0: app(v0, [old()]), v1: app(v1, [current()]) },
		}
	}
	const all = Object.values(PAIRED_MIDDLEWARE)
	out["stack-8"] = {
		method: "POST",
		versions: {
			v0: app(
				v0,
				all.map(([old]) => old()),
			),
			v1: app(
				v1,
				all.map(([, current]) => current()),
			),
		},
	}
	return out
}

/** A rate limit no bench run reaches: every request is counted and answered. */
function unlimited() {
	return rateLimitV1({ limit: Number.MAX_SAFE_INTEGER, windowMs: 3_600_000 })
}

/** The new middlewares, each against the same route without it. */
type Ceiling = { bare: FetchApp; iterations: number; subject: FetchApp }

function ceilings(): Record<string, Ceiling> {
	const stack10 = () => [...Object.values(PAIRED_MIDDLEWARE).map(([, current]) => current()), unlimited(), compressV1()]
	return {
		"compress-gzip-4k": { bare: app(v1, [], BIG), iterations: GZIP_ITERATIONS, subject: app(v1, [compressV1()], BIG) },
		"compress-skip": { bare: app(v1, []), iterations: ITERATIONS, subject: app(v1, [compressV1()]) },
		rateLimit: { bare: app(v1, []), iterations: ITERATIONS, subject: app(v1, [unlimited()]) },
		"stack-10": { bare: app(v1, []), iterations: ITERATIONS, subject: app(v1, stack10()) },
	}
}

/** One request every scenario can take: same origin, a peer, gzip accepted, no credentials. */
function request(method: string): Request {
	const req = new Request("http://bench.local/t", {
		headers: { "accept-encoding": "gzip", origin: "http://bench.local", "sec-fetch-site": "same-origin" },
		method,
	})
	Object.defineProperty(req, PEER_ADDRESS, { value: PEER })
	return req
}

async function timePerOp(target: FetchApp, req: Request, iterations: number): Promise<number> {
	const start = performance.now()
	for (let i = 0; i < iterations; i++) {
		let res = target.fetch(req, {})
		if (res instanceof Promise) res = await res
		if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
	}
	return ((performance.now() - start) * 1e6) / iterations
}

/** Interleaved samples of `a` and `b` after a warm-up: a's median ns, b's, and the per-sample a/b ratios. */
async function interleaved(a: FetchApp, b: FetchApp, req: Request, iterations: number) {
	await timePerOp(a, req, iterations)
	await timePerOp(b, req, iterations)
	const ratios: number[] = []
	const aNs: number[] = []
	const bNs: number[] = []
	for (let s = 0; s < SAMPLES; s++) {
		const x = await timePerOp(a, req, iterations)
		const y = await timePerOp(b, req, iterations)
		aNs.push(x)
		bNs.push(y)
		ratios.push(x / y)
	}
	return { a: median(aNs), b: median(bNs), ratios }
}

async function measureCeilings(): Promise<Record<string, { bareNs: number; ns: number; ratios: number[] }>> {
	const out: Record<string, { bareNs: number; ns: number; ratios: number[] }> = {}
	for (const [name, c] of Object.entries(ceilings())) {
		const point = await interleaved(c.subject, c.bare, request("GET"), c.iterations)
		out[name] = { bareNs: point.b, ns: point.a, ratios: point.ratios }
	}
	return out
}

type BaselineFile = { baselines: Record<string, Record<string, number>>; note: string }

function readBaselines(): BaselineFile {
	try {
		return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as BaselineFile
	} catch {
		return { baselines: {}, note: "" }
	}
}

const version = typeof Bun !== "undefined" ? Bun.version : process.version.slice(1)
const runtime = `${typeof Bun !== "undefined" ? "bun" : "node"} ${version.split(".").slice(0, 2).join(".")}`

if (process.argv.includes("--update")) {
	/* a ceiling is the median of three full runs, so one noisy run does not set the bar */
	const runs = [await measureCeilings(), await measureCeilings(), await measureCeilings()]
	const ratios = Object.fromEntries(
		Object.keys(runs[0] ?? {}).map((k) => [k, Number(median(runs.map((r) => median(r[k]?.ratios ?? [0]))).toFixed(2))]),
	)
	const file = readBaselines()
	file.note =
		"rateLimit / compress (no v0) per-request cost: v1 app.fetch with the middleware / the same route without it, median of interleaved samples, per runtime minor version. Regenerate with `taskset -c 2,3 bun bench/src/middleware.ts --update` on a quiet machine and commit the move with its reason."
	file.baselines[runtime] = ratios
	writeFileSync(BASELINE_FILE, `${JSON.stringify(file, null, "\t")}\n`)
	console.log(`middleware ceilings written for ${runtime} (${version})`)
	console.table(ratios)
	process.exit(0)
}

const pairedRows = []
for (const [name, p] of Object.entries(paired())) {
	const point = await interleaved(p.versions.v1, p.versions.v0, request(p.method), ITERATIONS)
	const verdict = judge(point.ratios, 1, THRESHOLD)
	pairedRows.push({
		band: `±${verdict.halfWidth.toFixed(2)}`,
		scenario: name,
		status: verdict.status === "regressed" ? "REGRESSED" : verdict.status,
		v0_ns: Math.round(point.b),
		v1_ns: Math.round(point.a),
		v1_over_v0: Number(verdict.ratio.toFixed(2)),
	})
}

const file = readBaselines()
const own = file.baselines[runtime]
const ceilingRows = Object.entries(await measureCeilings()).map(([name, m]) => {
	const verdict = judge(m.ratios, own?.[name], THRESHOLD)
	return {
		bare_ns: Math.round(m.bareNs),
		ceiling: own?.[name] ?? "—",
		ns: Math.round(m.ns),
		over_bare: Number(verdict.ratio.toFixed(2)),
		scenario: name,
		status: verdict.status === "regressed" ? "REGRESSED" : verdict.status,
	}
})

console.log(`middleware v1 vs v0 on ${runtime} (${version}), threshold +${Math.round(THRESHOLD * 100)}%`)
console.table(pairedRows)
console.log(`middleware v1-only ceilings (cost over the bare route) on ${runtime}`)
console.table(ceilingRows)
const failed = [...pairedRows, ...ceilingRows].some((row) => row.status === "REGRESSED")
if (own === undefined)
	console.log(`middleware: no ceilings for ${runtime}; those rows are a hint. Record them with --update.`)
if (failed) {
	console.error("middleware: a middleware's per-request cost regressed past the threshold.")
	process.exit(1)
}
