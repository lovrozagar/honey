/**
 * Hot-path regression gate: in-process `app.fetch` cost on the paths every request takes,
 * measured as a ratio to a minimal hand-written fetch handler run in the same process. The
 * ratio cancels most of the machine and runtime speed, so one committed baseline holds on a
 * laptop and on a CI runner.
 *
 *     bun bench/src/hotpath.ts            # compare against bench/hotpath-baseline.json
 *     bun bench/src/hotpath.ts --update   # record a new baseline (commit it with the change that moved it)
 *
 * Exits 1 when a scenario's median ratio exceeds its baseline by more than the threshold
 * (`HOTPATH_THRESHOLD`, default 0.25). Ratios drift by up to ~20% between Bun versions, so
 * baselines are kept per runtime minor version; a version without one runs as a hint only, and
 * CI gates on the version it pins. It catches a slowdown on the order of the per-request middleware
 * allocations that compiling chains at finalize removed (25–50%); a ~100 ns change stays under the threshold.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { createMiddleware, honey } from "@lovrozagar/honey"

const BASELINE_FILE = new URL("../hotpath-baseline.json", import.meta.url)
const THRESHOLD = Number(process.env.HOTPATH_THRESHOLD ?? 0.25)
const SAMPLES = Number(process.env.HOTPATH_SAMPLES ?? 9)
const ITERATIONS = Number(process.env.HOTPATH_ITERATIONS ?? 50_000)

type Fetch = (req: Request) => Response | Promise<Response>

const passthrough = createMiddleware(async (_ctx, next) => next())

function buildApp() {
	const app = honey()
	app.get("/json").handler((ctx) => ctx.res.json("ok", { message: "Hello, World!" }))
	app.get("/users/:id").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
	const chained = app.use(passthrough).use(passthrough)
	chained.get("/chain").handler((ctx) => ctx.res.json("ok", { ok: true }))
	/* many unrelated scopes and one that covers the route: the per-route chain is compiled once */
	for (let i = 0; i < 50; i++) app.use(`/area${i}`, passthrough)
	app.use("/scoped", passthrough)
	app.get("/scoped/item").handler((ctx) => ctx.res.json("ok", { ok: true }))
	return app
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" }, status })
}

/** The floor: what any router has to do — read the path, look up a handler, build a response. */
function buildRaw(): Fetch {
	const routes = new Map<string, (path: string) => Response>([
		["/json", () => json({ message: "Hello, World!" })],
		["/chain", () => json({ ok: true })],
		["/scoped/item", () => json({ ok: true })],
	])
	return (req) => {
		const url = req.url
		const path = url.slice(url.indexOf("/", 8))
		const handler = routes.get(path)
		if (handler !== undefined) return handler(path)
		if (path.startsWith("/users/")) return json({ id: path.slice(7) })
		return json({ error_key: "not_found", message: "not_found", status: 404, success: false }, 404)
	}
}

const SCENARIOS: Record<string, string> = {
	chain: "/chain",
	"not-found": "/nope/at/all",
	param: "/users/42",
	scoped: "/scoped/item",
	static: "/json",
}

async function timePerOp(fetch: Fetch, req: Request, expectStatus: number): Promise<number> {
	const start = performance.now()
	for (let i = 0; i < ITERATIONS; i++) {
		let res = fetch(req)
		if (res instanceof Promise) res = await res
		if (res.status !== expectStatus) throw new Error(`${req.url}: expected ${expectStatus}, got ${res.status}`)
	}
	return ((performance.now() - start) * 1e6) / ITERATIONS
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	return sorted[Math.floor(sorted.length / 2)] as number
}

async function measure(): Promise<Record<string, { honeyNs: number; rawNs: number; ratio: number }>> {
	const app = buildApp()
	const honeyFetch: Fetch = (req) => app.fetch(req, {})
	const raw = buildRaw()
	const out: Record<string, { honeyNs: number; rawNs: number; ratio: number }> = {}
	for (const [name, path] of Object.entries(SCENARIOS)) {
		const req = new Request(`http://bench.local${path}`)
		const status = name === "not-found" ? 404 : 200
		/* warm both paths up so the JIT has settled before anything is recorded */
		await timePerOp(honeyFetch, req, status)
		await timePerOp(raw, req, status)
		const ratios: number[] = []
		const honeyNs: number[] = []
		const rawNs: number[] = []
		/* interleaved, so frequency scaling and noisy neighbors hit both sides alike */
		for (let s = 0; s < SAMPLES; s++) {
			const h = await timePerOp(honeyFetch, req, status)
			const r = await timePerOp(raw, req, status)
			honeyNs.push(h)
			rawNs.push(r)
			ratios.push(h / r)
		}
		out[name] = { honeyNs: median(honeyNs), rawNs: median(rawNs), ratio: median(ratios) }
	}
	return out
}

/** Ratios drift between runtime versions, so a baseline is kept per runtime minor version. */
type BaselineFile = { note: string; baselines: Record<string, Record<string, number>> }

const version = typeof Bun !== "undefined" ? Bun.version : process.version.slice(1)
const runtime = `${typeof Bun !== "undefined" ? "bun" : "node"} ${version.split(".").slice(0, 2).join(".")}`
const results = await measure()

function readBaselines(): BaselineFile {
	try {
		return JSON.parse(readFileSync(BASELINE_FILE, "utf8")) as BaselineFile
	} catch {
		return { baselines: {}, note: "" }
	}
}

if (process.argv.includes("--update")) {
	/* a baseline is the median of three full runs, so one noisy run does not set the bar */
	const runs = [results, await measure(), await measure()]
	const ratios = Object.fromEntries(
		Object.keys(results).map((k) => [k, Number(median(runs.map((r) => r[k]?.ratio ?? 0)).toFixed(2))]),
	)
	const file = readBaselines()
	file.note =
		"app.fetch cost / minimal raw fetch handler, median of interleaved samples, per runtime minor version. Regenerate with `bun bench/src/hotpath.ts --update` (CI gates on the Bun version it pins)."
	file.baselines[runtime] = ratios
	file.baselines = Object.fromEntries(Object.entries(file.baselines).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
	writeFileSync(BASELINE_FILE, `${JSON.stringify(file, null, "\t")}\n`)
	console.log(`hotpath baseline written for ${runtime} (${version})`)
	console.table(ratios)
	process.exit(0)
}

const file = readBaselines()
const own = file.baselines[runtime]
/* no baseline for this runtime version: compare against the newest one, but only as a hint */
const advisory = own === undefined
const [againstName, against] =
	own !== undefined ? [runtime, own] : (Object.entries(file.baselines).at(-1) ?? ["none", {}])
let failed = false
const rows = Object.entries(results).map(([name, r]) => {
	const base = against[name]
	const limit = base === undefined ? Number.POSITIVE_INFINITY : base * (1 + THRESHOLD)
	const ok = r.ratio <= limit
	if (!ok) failed = true
	return {
		baseline: base ?? "—",
		honey_ns: Math.round(r.honeyNs),
		limit: Number.isFinite(limit) ? Number(limit.toFixed(2)) : "—",
		ratio: Number(r.ratio.toFixed(2)),
		raw_ns: Math.round(r.rawNs),
		scenario: name,
		status: ok ? "ok" : "REGRESSED",
	}
})
console.log(`hotpath on ${runtime} (${version}) vs baseline ${againstName}, threshold +${Math.round(THRESHOLD * 100)}%`)
console.table(rows)
if (advisory) {
	console.log(`hotpath: no baseline for ${runtime}; advisory only. Record one with --update.`)
} else if (failed) {
	console.error(
		"hotpath: a scenario regressed past the threshold. If the slowdown is intended, re-record the baseline.",
	)
	process.exit(1)
}
