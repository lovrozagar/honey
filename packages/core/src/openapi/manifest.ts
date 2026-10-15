/**
 * `generateManifest(app, options?)`: the app's routes as plain data, one entry per route by method
 * and honey pattern, with the keys it may answer, its meta, the middleware it runs by name, and
 * its shapes as JSON Schema; then every key once with its status. `visibility: "all"` (the
 * generate-time artifact) keeps every route and meta key; `"published"` (a served manifest)
 * applies the document's policy: no internal route, only the meta keys the metaSpec publishes.
 */
import type { GRAPH } from "../routing/app.ts"
import { type HoneyGraph, SERVED } from "../routing/register.ts"
import { compareCodeUnits } from "../schema/canonicalize.ts"
import type { JsonSchema, JsonSchemaOptions } from "../schema/to-json-schema.ts"
import { metaSpecOf } from "../meta/meta-spec-merge.ts"
import { publishableMetaKeys } from "../meta/meta-spec.ts"
import { type CollectedError, type CollectedRoute, collectRoutes } from "./collect.ts"
import { extractSchemas, type RouteSchemas } from "./extract-schemas.ts"
import type { OpenApiRouteInfo } from "./generate.ts"

export type ManifestRoute = {
	readonly errors: readonly string[]
	readonly input?: Readonly<Record<string, JsonSchema>>
	readonly meta: Readonly<Record<string, unknown>>
	readonly method: string
	readonly middleware: readonly string[]
	readonly output?: Readonly<Record<string, Readonly<Record<string, JsonSchema>>>>
	readonly params: readonly string[]
	readonly path: string
}

export type ManifestError = { readonly errorKey: string; readonly status: number; readonly statusKey: string }

export type RouteManifest = { readonly errors: readonly ManifestError[]; readonly routes: readonly ManifestRoute[] }

export type GenerateManifestOptions = {
	readonly converters?: JsonSchemaOptions["converters"]
	/** leave out every route this answers false for */
	readonly filterRoutes?: (route: OpenApiRouteInfo) => boolean
	/** `"all"` (the default) keeps everything; `"published"` applies the document's visibility */
	readonly visibility?: "all" | "published"
}

/** One entry per route: an optional param's variants come shortest first, so the last is the fullest. */
function byRoute(collected: readonly CollectedRoute[]): CollectedRoute[] {
	const out = new Map<string, CollectedRoute>()
	for (const route of collected) out.set(route.id, route)
	return [...out.values()]
}

/** The app's route manifest. */
export function generateManifest(
	app: { readonly [GRAPH]: HoneyGraph },
	options: GenerateManifestOptions = {},
): RouteManifest {
	const published = options.visibility === "published"
	const publishable = published ? publishableMetaKeys(metaSpecOf(app)) : () => true
	const schemas = extractSchemas(app, { converters: options.converters })
	/* a route the app serves about itself is in no manifest; another internal route only in "all" */
	const keep = (route: CollectedRoute) =>
		(route.meta as { [SERVED]?: unknown })[SERVED] !== true &&
		!(published && route.internal) &&
		(options.filterRoutes?.({ meta: route.meta, method: route.method, path: route.pattern }) ?? true)
	const routes = byRoute(collectRoutes(app).http).filter(keep)
	const errors = new Map<string, CollectedError>()
	const entries = routes.map((route): ManifestRoute => {
		for (const key of route.errorKeys) if (!errors.has(key)) errors.set(key, route.errorMeta[key] as CollectedError)
		/* every HTTP route has its entry, keyed by its id */
		const { input, output } = schemas[route.id] as RouteSchemas
		return {
			errors: route.errorKeys,
			...(input === undefined ? {} : { input }),
			meta: Object.fromEntries(Object.entries(route.meta).filter(([key]) => publishable(key))),
			method: route.method,
			middleware: route.middleware,
			...(output === undefined ? {} : { output }),
			params: route.params,
			path: route.pattern,
		}
	})
	return {
		errors: [...errors.keys()].sort(compareCodeUnits).map((errorKey) => {
			const { status, statusKey } = errors.get(errorKey) as CollectedError
			return { errorKey, status, statusKey }
		}),
		routes: entries,
	}
}
