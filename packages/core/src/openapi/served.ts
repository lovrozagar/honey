/**
 * The serving helpers `serveOpenApi` and `serveStaticOpenApi` both mount through: a body with its strong
 * validator, the answer that revalidates and 304s, all-or-none mounting under the handle's basePath as an
 * internal SERVED route behind an optional Basic guard, and the docs-page routes pointing at the JSON URL
 * the browser sees. Nothing here reads the route graph for a document, so a function that serves bytes it
 * was given carries no generator.
 */
import type { RuntimeMiddleware } from "../middleware/middleware.ts"
import { ifNoneMatchHits } from "../response/etag.ts"
import type { TypedResponse } from "../response/response.ts"
import { isStaticPattern, joinPatterns, parsePattern } from "../routing/pattern.ts"
import { assertRouteFree, GRAPH, type HandleView, type HoneyGraph, SERVED, VIEW } from "../routing/register.ts"
import type { HoneyMeta, InferMeta } from "../routing/app-types.ts"
import type { GuardFactory, ServedAuth } from "./basic-auth.ts"
import type { DocsConfig, DocsContext } from "./docs-page.ts"

/**
 * The route meta a serving call puts on every route it mounts: honey's own keys and the ones handle `A`
 * declares (`meta<T>()`), each optional, as a route's own `.meta()` takes them. Never `internal` or SERVED,
 * the marking every served route keeps.
 */
export type ServedMeta<A> = Partial<Omit<HoneyMeta<[InferMeta<A>] extends [never] ? {} : InferMeta<A>>, "internal">> & {
	/** Not settable: every served route is internal, so it never appears in generated artifacts. */
	readonly internal?: never
	readonly [SERVED]?: never
}

/** A docs page, as `scalar` and `swagger` are: the page for the document at `config.url`. */
export type DocsPage = (config: DocsConfig) => (ctx: DocsContext) => TypedResponse

/** What a served route reads of its context: the request, its runtime's env, and the raw or HTML answer. */
export type ServedContext = DocsContext & {
	readonly env: unknown
	readonly req: Request
	readonly res: { raw(response: Response): TypedResponse }
}

export type ServedHandler = (ctx: ServedContext) => unknown

/** A handle serving routes about its app: what these functions read and register through. */
export type ServingHandle = {
	readonly [GRAPH]: HoneyGraph
	readonly [VIEW]: HandleView
	get(path: string): { meta(meta: object): ServedRoute }
}

/** A served route once its meta is set: its handler, behind a guard's middleware when it has one. */
type ServedRoute = {
	handler(fn: ServedHandler): unknown
	use(mw: RuntimeMiddleware): { handler(fn: ServedHandler): unknown }
}

/** The docs pages a serving call mounts: each path, under the handle's basePath, mapped to its page. */
export type DocsPages = Readonly<Record<string, DocsPage>>

/**
 * A serving call's `auth`, and `cacheControl` where it takes one: a guarded document is answered
 * `private, no-store`, so no public cache can hold it for someone the guard would refuse.
 */
export type ServedAccess<Cached extends boolean> = Cached extends true
	?
			| {
					/** a Basic guard in front of every route the call mounts, from `basic()` */
					readonly auth?: ServedAuth
					/** not beside `auth`: a guarded answer is always `private, no-store` */
					readonly cacheControl?: never
			  }
			| {
					/** none: the document answers anyone */
					readonly auth?: undefined
					/** `"no-cache"` by default; never beside `auth` */
					readonly cacheControl?: string
			  }
	: {
			/** a Basic guard in front of every route the call mounts, from `basic()` */
			readonly auth?: ServedAuth
		}

export type Artifact = { readonly body: string; readonly contentType: string; readonly etag: string }

export const JSON_TYPE = "application/json; charset=utf-8"
export const YAML_TYPE = "application/yaml; charset=utf-8"

/** `body` with its strong validator: base64url of the first 16 bytes of its SHA-256, quoted. */
export async function artifact(body: string, contentType: string): Promise<Artifact> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)), 0, 16)
	let binary = ""
	for (const byte of hash) binary += String.fromCharCode(byte)
	const tag = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
	return { body, contentType, etag: `"${tag}"` }
}

/**
 * The answer for `served`, cached as `cacheControl` says, an unchanged one a 304. A guarded answer never
 * revalidates: its guard sends it `private, no-store`, with no validator.
 */
export function answering(
	served: (ctx: ServedContext) => Promise<Artifact>,
	cacheControl = "no-cache",
	auth?: ServedAuth,
): ServedHandler {
	return async (ctx) => {
		const { body, contentType, etag } = await served(ctx)
		const headers = {
			"cache-control": cacheControl,
			"content-type": contentType,
			etag,
			"x-content-type-options": "nosniff",
		}
		const hit = auth === undefined && ifNoneMatchHits(ctx.req.headers.get("if-none-match"), etag)
		return ctx.res.raw(hit ? new Response(null, { headers, status: 304 }) : new Response(body, { headers }))
	}
}

/** `path` under the handle's basePath. */
export const under = (app: ServingHandle, path: string) => joinPatterns(app[VIEW].basePath, path)

/**
 * Mount every route, or none: each path is checked fixed and free before any is registered. `meta` is the
 * caller's own route meta, under the internal SERVED marking no caller can lift, and `auth` guards every
 * route alike.
 */
export function mountAll(
	app: ServingHandle,
	routes: readonly (readonly [path: string, handler: ServedHandler])[],
	meta: object = {},
	auth?: ServedAuth,
): void {
	const ids = new Set<string>()
	for (const [path] of routes) {
		const segments = parsePattern(under(app, path))
		if (!isStaticPattern(segments))
			throw new Error(`cannot serve at ${path}: a served path is fixed, with no parameter`)
		const id = assertRouteFree(app[GRAPH], "GET", segments)
		if (ids.has(id)) throw new Error(`Duplicate route: ${id}`)
		ids.add(id)
	}
	const guard = auth === undefined ? null : (auth as unknown as GuardFactory).guard()
	for (const [path, handler] of routes) {
		const route = app.get(path).meta({ ...meta, internal: true, [SERVED]: true })
		if (guard === null) route.handler(handler)
		else route.use(guard.stamp).handler(guard.wrap(handler))
	}
}

/** What a `docs` value that is not the map is shown to pass instead. */
const DOCS_FIX =
	'import { scalar } from "@lovrozagar/honey/openapi/scalar" (or swagger from "@lovrozagar/honey/openapi/swagger") and pass docs: { "/docs": scalar }'

/**
 * The docs pages' routes: each page built for the JSON URL the browser sees (the prefix the app strips,
 * then the path it routes). A page alone, or a path given the name of a page, is what the option took
 * before, so the throw shows the map a JavaScript caller passes instead.
 */
export function docsRoutes(app: ServingHandle, docs: DocsPages, jsonPath: string): [string, ServedHandler][] {
	if (typeof docs !== "object" || docs === null) throw new TypeError(`docs maps each path to its page: ${DOCS_FIX}`)
	const url = `${app[GRAPH].settings.stripPrefix ?? ""}${under(app, jsonPath)}`
	return Object.entries(docs).map(([path, page]) => {
		if (typeof page !== "function") throw new TypeError(`docs at ${path} is not a page: ${DOCS_FIX}`)
		return [path, page({ url }) as ServedHandler]
	})
}
