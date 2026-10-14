/**
 * Finalize-cost gate (00-rules "Perf gate"): compiling the route table runs once per registration
 * epoch, and every route is checked against every scope, so its cost grows with routes × scopes.
 * The warm per-request loop in hotpath.ts never sees it; this measures it on fresh apps.
 *
 *     bun bench/src/finalize.ts
 *
 * Until the cutover (H21) v1 is gated against v0 in the same process: per grid point, fresh v0
 * and v1 apps are finalized in interleaved samples, and the gate fails (exit 1) when v1's median
 * cost is more than `FINALIZE_THRESHOLD` (default 0.10) over v0's AND outside the band of its own
 * samples. A ratio, so no baseline file and no dependence on the machine.
 */
import { createMiddleware, honey } from "@lovrozagar/honey"
import { createMiddleware as createV1Middleware } from "../../packages/core/src/middleware/middleware.ts"
import { GRAPH, honey as honeyV1 } from "../../packages/core/src/routing/app.ts"
import { finalTable } from "../../packages/core/src/routing/dispatch.ts"
import { judge, median } from "./significance.ts"

const SAMPLES = Number(process.env.FINALIZE_SAMPLES ?? 9)
const THRESHOLD = Number(process.env.FINALIZE_THRESHOLD ?? 0.1)
const GRID: ReadonlyArray<readonly [routes: number, scopes: number]> = [
	[100, 10],
	[100, 100],
	[500, 50],
	[1000, 10],
	[1000, 100],
]

const v0Pass = createMiddleware(async (_ctx, next) => next())
const v1Pass = createV1Middleware(async (_ctx, next) => next())

/** Fresh apps of one shape; each returns the call that finalizes it. */
function buildV0(routes: number, scopes: number): () => void {
	const app = honey()
	for (let j = 0; j < scopes; j++) app.use(`/area${j}`, v0Pass)
	for (let i = 0; i < routes; i++)
		app.get(`/area${i % Math.max(scopes, 1)}/r${i}/:id`).handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
	// oxlint-disable-next-line no-underscore-dangle -- v0 exposes finalize only under this name
	return () => app._finalize()
}

function buildV1(routes: number, scopes: number): () => void {
	const app = honeyV1<{}>()
	for (let j = 0; j < scopes; j++) app.use(`/area${j}`, v1Pass)
	for (let i = 0; i < routes; i++)
		app.get(`/area${i % Math.max(scopes, 1)}/r${i}/:id`).handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
	return () => void finalTable(app[GRAPH])
}

function micros(finalize: () => void): number {
	const start = performance.now()
	finalize()
	return (performance.now() - start) * 1000
}

type Point = { ratios: number[]; v0: number; v1: number }

/** Interleaved samples after one throwaway run of each, so both JITs have settled. */
function measure(routes: number, scopes: number): Point {
	micros(buildV0(routes, scopes))
	micros(buildV1(routes, scopes))
	const v0: number[] = []
	const v1: number[] = []
	const ratios: number[] = []
	for (let s = 0; s < SAMPLES; s++) {
		const a = micros(buildV0(routes, scopes))
		const b = micros(buildV1(routes, scopes))
		v0.push(a)
		v1.push(b)
		ratios.push(b / a)
	}
	return { ratios, v0: median(v0), v1: median(v1) }
}

const version = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`
const rows = GRID.map(([routes, scopes]) => {
	const point = measure(routes, scopes)
	const verdict = judge(point.ratios, 1, THRESHOLD)
	return {
		band: `±${verdict.halfWidth.toFixed(2)}`,
		routes,
		scopes,
		status: verdict.status === "regressed" ? "REGRESSED" : verdict.status,
		v0_us: Number(point.v0.toFixed(1)),
		v1_over_v0: Number(verdict.ratio.toFixed(2)),
		v1_us: Number(point.v1.toFixed(1)),
	}
})
console.log(`finalize v1 vs v0 on ${version}, median of ${SAMPLES} fresh apps each, threshold +${THRESHOLD * 100}%`)
console.table(rows)
if (rows.some((r) => r.status === "REGRESSED")) {
	console.error("finalize: v1 compiles slower than v0 past the threshold.")
	process.exit(1)
}
