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

/** One route of the manifest. A route with an optional parameter is one entry, with its fullest variant's `params`. */
export type ManifestRoute = {
	/** the error keys the route may answer; each is described in the manifest's `errors` */
	readonly errors: readonly string[]
	/** the JSON Schema of each input source, by source name such as `json` or `search`; a `binary` source is left out */
	readonly input?: Readonly<Record<string, JsonSchema>>
	/** the route's meta; under `"published"` visibility, only built-in keys and keys with a metaSpec entry other than `false` */
	readonly meta: Readonly<Record<string, unknown>>
	/** the method in uppercase, such as `GET`; `ALL` for an `all()` route */
	readonly method: string
	/** the names of the middleware the route runs, in order; an unnamed one is `anonymous` */
	readonly middleware: readonly string[]
	/** the JSON Schema of each response, by content type and then by status key; `headers` and `redirect` declarations are left out */
	readonly output?: Readonly<Record<string, Readonly<Record<string, JsonSchema>>>>
	/** the names of the route's path parameters; an unnamed wildcard is `wildcard` */
	readonly params: readonly string[]
	/** the route's pattern with parameters as `:name`, such as `/users/:id`; not the OpenAPI `{id}` form */
	readonly path: string
}

/** An error key a route may answer, with its status. */
export type ManifestError = {
	/** the error key, as listed in a route's `errors` */
	readonly errorKey: string
	/** the numeric HTTP status; `0` when nothing says what it is */
	readonly status: number
	/** the status as its key, such as `"not_found"`; `"unknown"` when nothing says what it is */
	readonly statusKey: string
}

/** The app's routes as plain data. */
export type RouteManifest = {
	/** every error key the listed routes may answer, once, sorted by key */
	readonly errors: readonly ManifestError[]
	/** the HTTP routes in registration order; WebSocket routes and the routes a serving call such as `serveOpenApi` mounted are never listed */
	readonly routes: readonly ManifestRoute[]
}

/** What `generateManifest` takes: how schemas convert, which routes it lists and how much it keeps. */
export type GenerateManifestOptions = {
	/** the converters honey cannot import itself: `effect`, without which an Effect schema comes out as `{}` */
	readonly converters?: JsonSchemaOptions["converters"]
	/** leave out every route this answers false for */
	readonly filterRoutes?: (route: OpenApiRouteInfo) => boolean
	/** `"all"` (the default) keeps internal routes and every meta key; `"published"` drops internal routes and keeps only built-in keys and keys with a metaSpec entry other than `false` */
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
