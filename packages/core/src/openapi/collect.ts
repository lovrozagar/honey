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
import {
	expandOptional,
	parsePattern,
	patternParams,
	splitRouteId,
	toOpenApiTemplate,
	UNNAMED_WILDCARD,
} from "../routing/pattern.ts"
import type { RouteEntry } from "../routing/tree.ts"

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

/** What a route resolves to: from its plan, or for a loaded leaf nothing serves, from its tree entry. */
function resolved(plan: Plan | undefined, entry: RouteEntry | undefined) {
	if (plan !== undefined) {
		const declared = plan.policy.declared === null ? [] : [...plan.policy.declared]
		return { errorKeys: declared.sort(compareCodeUnits), errors: plan.route.errors, meta: plan.route.meta }
	}
	const meta: Readonly<Record<string, unknown>> = entry?.mt ?? {}
	return { errorKeys: [...(entry?.ek ?? [])].sort(compareCodeUnits), errors: null, meta }
}

/** A route's pattern and declarations: its record's, else its loaded tree entry's. */
function declarations(g: HoneyGraph, id: string) {
	const record = g.records.get(id)
	const entry = g.loaded?.[id]
	return {
		input: record?.iv ?? entry?.iv ?? null,
		output: record?.out ?? entry?.out ?? null,
		segments: record?.sg ?? parsePattern(splitRouteId(id).pattern),
	}
}

/** Every route `app` serves: in registration order, or a loaded tree's order. */
export function collectRoutes(app: { readonly [GRAPH]: HoneyGraph }): CollectedRoutes {
	const g = app[GRAPH]
	const { plans } = finalTable(g)
	const http: CollectedRoute[] = []
	const ws: CollectedWsRoute[] = []
	for (const id of g.loaded === null ? g.records.keys() : Object.keys(g.loaded)) {
		const { input, output, segments } = declarations(g, id)
		const { errorKeys, errors, meta } = resolved(plans.get(id), g.loaded?.[id])
		const { method, pattern } = splitRouteId(id)
		for (const variant of expandOptional(segments)) {
			const params = patternParams(variant).map((name) => (name === UNNAMED_WILDCARD ? "wildcard" : name))
			const base = { id, input, meta, params, path: toOpenApiTemplate(variant), pattern }
			if (method === "WS") ws.push(base)
			else http.push({ ...base, errorKeys, errors, internal: meta.internal === true, method, output })
		}
	}
	return { http, ws }
}
