/**
 * Finalize-cost gate (00-rules "Perf gate"): compiling the route table runs once per registration
 * epoch, and every route is checked against every scope, so its cost grows with routes × scopes.
 * The warm per-request loop in hotpath.ts never sees it; this measures it on fresh apps.
 *
 *     bun bench/src/finalize.ts   # judged against blueprint/baselines/bench.json
 *
 * Per grid point, v1's finalize is a ratio to a raw twin doing the work honey cannot skip: each
 * route keyed by method and path, and each route's scopes found by a segment-prefix test over every
 * scope, on fresh tables in interleaved samples (gate.ts). Until bit 20 e it was gated against v0.
 */
import { createMiddleware } from "../../packages/core/src/middleware/middleware.ts"
import { GRAPH, honey } from "../../packages/core/src/routing/app.ts"
import { finalTable } from "../../packages/core/src/routing/dispatch.ts"
import { gate } from "./gate.ts"

const GRID: ReadonlyArray<readonly [routes: number, scopes: number]> = [
	[100, 10],
	[100, 100],
	[500, 50],
	[1000, 10],
	[1000, 100],
]
/* fresh tables per sample, scaled so a small grid's sample costs about what a large one's does: one finalize of a
   small grid alone is too short to time (100x10 spread 18% over five runs at a flat 20) */
const repeatsOf = (routes: number, scopes: number) => Math.max(20, Math.round(400_000 / (routes * scopes)))

const pass = createMiddleware(async (_ctx, next) => next())
/* the raw tables' sizes, kept so the work that builds them is never optimized away */
let kept = 0

const scopeOf = (j: number) => `/area${j}`
const pathOf = (i: number, scopes: number) => `/area${i % Math.max(scopes, 1)}/r${i}/:id`

/** A fresh v1 app of one shape and the call that finalizes it. */
function v1App(routes: number, scopes: number): () => void {
	const app = honey<{}>()
	for (let j = 0; j < scopes; j++) app.use(scopeOf(j), pass)
	for (let i = 0; i < routes; i++)
		app.get(pathOf(i, scopes)).handler((ctx) => ctx.res.json("ok", { id: ctx.params.id }))
	return () => void finalTable(app[GRAPH])
}

/** The same table by hand: routes by method and path, each with the scopes whose prefix covers it. */
function rawTable(routes: number, scopes: number): () => void {
	const prefixes = Array.from({ length: scopes }, (_, j) => scopeOf(j))
	const paths = Array.from({ length: routes }, (_, i) => pathOf(i, scopes))
	return () => {
		const table = new Map<string, { path: string; scopes: string[] }>()
		for (const path of paths) {
			const covering = prefixes.filter((prefix) => path === prefix || path.startsWith(`${prefix}/`))
			table.set(`GET ${path}`, { path, scopes: covering })
		}
		kept += table.size
	}
}

/** Microseconds to finalize `repeatsOf` fresh tables made by `make`. */
function micros(make: (routes: number, scopes: number) => () => void, routes: number, scopes: number): number {
	const finalizers = Array.from({ length: repeatsOf(routes, scopes) }, () => make(routes, scopes))
	const start = performance.now()
	for (const finalize of finalizers) finalize()
	return (performance.now() - start) * 1000
}

await gate(
	"finalize",
	GRID.map(([routes, scopes]) => ({
		name: `${routes}x${scopes}`,
		raw: async () => micros(rawTable, routes, scopes),
		v1: async () => micros(v1App, routes, scopes),
	})),
	{
		samples: Number(process.env.FINALIZE_SAMPLES ?? 9),
	},
)
if (kept < 0) console.log(kept)
