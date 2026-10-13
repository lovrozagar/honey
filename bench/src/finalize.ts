/**
 * Finalize-cost bench (00-rules "Perf gate"): `_finalize()` compiles the route table once, and for
 * every route `_resolve` scans every scoped middleware, so its cost grows with routes × scopes.
 * The warm per-request loop in hotpath.ts never sees it; this measures it directly on fresh apps.
 *
 *     bun bench/src/finalize.ts
 */
import { createMiddleware, honey } from "@lovrozagar/honey"
import { median } from "./significance.ts"

const SAMPLES = Number(process.env.FINALIZE_SAMPLES ?? 9)
const GRID: ReadonlyArray<readonly [routes: number, scopes: number]> = [
	[100, 10],
	[100, 100],
	[500, 50],
	[1000, 10],
	[1000, 100],
]

const passthrough = createMiddleware(async (_ctx, next) => next())

function buildApp(routes: number, scopes: number) {
	const app = honey()
	for (let j = 0; j < scopes; j++) app.use(`/area${j}`, passthrough)
	for (let i = 0; i < routes; i++)
		app.get(`/area${i % Math.max(scopes, 1)}/r${i}/:id`).handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
	return app
}

/** Median wall time of one `_finalize()` on a freshly built app, in microseconds. */
function finalizeMicros(routes: number, scopes: number): number {
	const samples: number[] = []
	/* one throwaway run so the JIT has compiled finalize before anything is recorded */
	for (let s = 0; s <= SAMPLES; s++) {
		const app = buildApp(routes, scopes)
		const start = performance.now()
		app._finalize()
		if (s > 0) samples.push((performance.now() - start) * 1000)
	}
	return median(samples)
}

const version = typeof Bun !== "undefined" ? `bun ${Bun.version}` : `node ${process.version}`
const rows = GRID.map(([routes, scopes]) => {
	const micros = finalizeMicros(routes, scopes)
	return {
		finalize_us: Number(micros.toFixed(1)),
		ns_per_route_scope: Number(((micros * 1000) / (routes * Math.max(scopes, 1))).toFixed(1)),
		routes,
		scopes,
	}
})
console.log(`finalize on ${version}, median of ${SAMPLES} fresh apps`)
console.table(rows)
