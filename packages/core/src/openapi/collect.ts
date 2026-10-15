/**
 * The routes an app serves, as records a document is built from: one per concrete path, read
 * from the finalized table so meta and error keys are what dispatch resolves. WebSocket routes
 * come apart: they are no operations.
 */
import { ERROR_META, type ErrorMetaEntry } from "../errors/errors.ts"
import type { InputSchemas } from "../input/input.ts"
import { type StatusKey, statusKeyToCode } from "../response/status.ts"
import { compareCodeUnits } from "../schema/canonicalize.ts"
import type { HoneyGraph } from "../routing/register.ts"
import { GRAPH } from "../routing/app.ts"
import { finalTable } from "../routing/dispatch.ts"
import type { Plan } from "../routing/finalize.ts"
import type { OutputSchemas } from "../routing/output-types.ts"
import type { ErrorFactories } from "../routing/settings.ts"
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

/** An error key as the document describes it: its status and, for a schema error, its schema. */
export type CollectedError = {
	readonly schema: ErrorMetaEntry["schema"]
	/** the HTTP status; `0` when nothing says */
	readonly status: number
	/** the status key; `"unknown"` when nothing says */
	readonly statusKey: string
}

/** One path an HTTP route serves. */
export type CollectedRoute = CollectedWsRoute & {
	/** the keys the route may answer with, sorted; none for a route that declares none */
	readonly errorKeys: readonly string[]
	/** each of `errorKeys` with its status: from ERROR_META, never by calling a factory */
	readonly errorMeta: Readonly<Record<string, CollectedError>>
	/** the error factories the route's keys come from: what `ctx.errors` holds */
	readonly errors: Readonly<Record<string, (...args: never[]) => unknown>> | null
	/** `meta.internal`: generated artifacts leave the route out */
	readonly internal: boolean
	/** the registration the route came from: shared by the records one `.on()` call writes */
	readonly registration: object
	/** `GET`, `POST`… or `ALL` */
	readonly method: string
	readonly output: OutputSchemas | null
}

export type CollectedRoutes = { readonly http: CollectedRoute[]; readonly ws: CollectedWsRoute[] }

/** The error status a key names by itself: a status key, or one as its suffix. */
function inferred(key: string): CollectedError | null {
	/* longest first, so `billing_event_not_found` reads as not_found and never found */
	const byLength = (Object.keys(statusKeyToCode) as StatusKey[]).sort((a, b) => b.length - a.length)
	const statusKey = byLength.find((k) => key === k || key.endsWith(`_${k}`))
	if (statusKey === undefined || statusKeyToCode[statusKey] < 400) return null
	return { schema: null, status: statusKeyToCode[statusKey], statusKey }
}

/** Where a key's status is looked up: an app's factory, or a generated tree's record of its status keys. */
type ErrorSource = ErrorFactories | Readonly<Record<string, string>> | null | undefined

/** What `source` holds for `key`: its factory's ERROR_META entry, or the status key a tree recorded. */
function lookup(source: ErrorSource, key: string): ErrorMetaEntry | undefined {
	if (source === null || source === undefined) return undefined
	const meta = (source as { [ERROR_META]?: Record<string, ErrorMetaEntry> })[ERROR_META]
	if (meta !== undefined) return Object.hasOwn(meta, key) ? meta[key] : undefined
	const statusKey = Object.hasOwn(source, key) ? (source as Readonly<Record<string, unknown>>)[key] : undefined
	return typeof statusKey === "string" ? { schema: null, statusKey: statusKey as StatusKey } : undefined
}

/**
 * Each key's status from the first source that knows it (the factory the route named, the ones its
 * middleware brought, the app it was registered on, a generated tree's record, the app serving it),
 * else from its name, else unknown.
 */
function errorMetaOf(keys: readonly string[], sources: readonly ErrorSource[]) {
	const out: Record<string, CollectedError> = {}
	for (const key of keys) {
		const entry = sources.map((source) => lookup(source, key)).find((found) => found !== undefined)
		out[key] =
			entry === undefined
				? (inferred(key) ?? { schema: null, status: 0, statusKey: "unknown" })
				: { schema: entry.schema, status: statusKeyToCode[entry.statusKey as StatusKey], statusKey: entry.statusKey }
	}
	return out
}

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
		const record = g.records.get(id)
		const errorMeta = errorMetaOf(errorKeys, [
			record?.ef,
			...(plans.get(id)?.mf ?? []),
			record?.own.errorFactory,
			g.loaded?.[id]?.es,
			g.settings.errorFactory,
		])
		const { method, pattern } = splitRouteId(id)
		for (const variant of expandOptional(segments)) {
			const params = patternParams(variant).map((name) => (name === UNNAMED_WILDCARD ? "wildcard" : name))
			const base = { id, input, meta, params, path: toOpenApiTemplate(variant), pattern }
			if (method === "WS") ws.push(base)
			else {
				/* every route is a record or a loaded leaf */
				const registration = (record?.fn ?? g.loaded?.[id]) as object
				http.push({
					...base,
					errorKeys,
					errorMeta,
					errors,
					internal: meta.internal === true,
					method,
					output,
					registration,
				})
			}
		}
	}
	return { http, ws }
}
