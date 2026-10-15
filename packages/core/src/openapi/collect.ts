/**
 * The routes an app serves, as records a document is built from: one per concrete path, read
 * from the finalized table so meta and error keys are what dispatch resolves. WebSocket routes
 * come apart: they are no operations.
 */
import type { InputSchemas } from "../input/input.ts"
import { compareCodeUnits } from "../schema/canonicalize.ts"
import type { HoneyGraph } from "../routing/register.ts"
import { GRAPH } from "../routing/app.ts"
import { finalTable } from "../routing/dispatch.ts"
import type { Plan } from "../routing/finalize.ts"
import type { OutputSchemas } from "../routing/output-types.ts"
import { expandOptional, patternParams, splitRouteId, toOpenApiTemplate, UNNAMED_WILDCARD } from "../routing/pattern.ts"

/** One path a WebSocket route serves. */
export type CollectedWsRoute = {
	/** `WS /pattern` */
	readonly id: string
	/** the upgrade's non-body sources, as declared */
	readonly input: InputSchemas | null
	readonly meta: Readonly<Record<string, unknown>>
	/** parameter names, an unnamed wildcard as `wildcard` */
	readonly params: readonly string[]
	/** the OpenAPI path template: `/chat/{room}` */
	readonly path: string
	/** the honey pattern: `/chat/:room` */
	readonly pattern: string
}

/** One path an HTTP route serves. */
export type CollectedRoute = CollectedWsRoute & {
	/** the keys the route may answer with, sorted; none for a route that declares none */
	readonly errorKeys: readonly string[]
	/** the error factories the route's keys come from: what `ctx.errors` holds */
	readonly errors: Readonly<Record<string, (...args: never[]) => unknown>> | null
	/** `meta.internal`: generated artifacts leave the route out */
	readonly internal: boolean
	/** `GET`, `POST`… or `ALL` */
	readonly method: string
	readonly output: OutputSchemas | null
}

export type CollectedRoutes = { readonly http: CollectedRoute[]; readonly ws: CollectedWsRoute[] }

/** Every route `app` serves, in registration order. */
export function collectRoutes(app: { readonly [GRAPH]: HoneyGraph }): CollectedRoutes {
	const g = app[GRAPH]
	const { plans } = finalTable(g)
	const http: CollectedRoute[] = []
	const ws: CollectedWsRoute[] = []
	for (const [id, record] of g.records) {
		/* finalize plans every record */
		const { policy, route } = plans.get(id) as Plan
		const { errors, meta } = route
		const { method, pattern } = splitRouteId(id)
		for (const segments of expandOptional(record.sg)) {
			const params = patternParams(segments).map((name) => (name === UNNAMED_WILDCARD ? "wildcard" : name))
			const base = { id, input: record.iv, meta, params, path: toOpenApiTemplate(segments), pattern }
			if (method === "WS") {
				ws.push(base)
				continue
			}
			http.push({
				...base,
				errorKeys: policy.declared === null ? [] : [...policy.declared].sort(compareCodeUnits),
				errors,
				internal: meta.internal === true,
				method,
				output: record.out,
			})
		}
	}
	return { http, ws }
}
