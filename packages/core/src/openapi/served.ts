/**
 * The serving helpers `serveOpenApi` and `serveStaticOpenApi` both mount through: a body with its strong
 * validator, the answer that revalidates and 304s, all-or-none mounting under the handle's basePath as an
 * internal SERVED route, and the docs-page route pointing at the JSON URL the browser sees. Nothing here
 * reads the route graph for a document, so a function that serves bytes it was given carries no generator.
 */
import { ifNoneMatchHits } from "../response/etag.ts"
import type { TypedResponse } from "../response/response.ts"
import { isStaticPattern, joinPatterns, parsePattern } from "../routing/pattern.ts"
import { assertRouteFree, GRAPH, type HandleView, type HoneyGraph, SERVED, VIEW } from "../routing/register.ts"
import type { DocsConfig, DocsContext } from "./docs-page.ts"

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
	get(path: string): { meta(meta: object): { handler(fn: ServedHandler): unknown } }
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

/** The answer for `served`, cached as `cacheControl` says, an unchanged one a 304. */
export function answering(served: (ctx: ServedContext) => Promise<Artifact>, cacheControl = "no-cache"): ServedHandler {
	return async (ctx) => {
		const { body, contentType, etag } = await served(ctx)
		const headers = {
			"cache-control": cacheControl,
			"content-type": contentType,
			etag,
			"x-content-type-options": "nosniff",
		}
		const hit = ifNoneMatchHits(ctx.req.headers.get("if-none-match"), etag)
		return ctx.res.raw(hit ? new Response(null, { headers, status: 304 }) : new Response(body, { headers }))
	}
}

/** `path` under the handle's basePath. */
export const under = (app: ServingHandle, path: string) => joinPatterns(app[VIEW].basePath, path)

/**
 * Mount every route, or none: each path is checked fixed and free before any is registered. `meta` is the
 * caller's own route meta, under the internal SERVED marking no caller can lift.
 */
export function mountAll(
	app: ServingHandle,
	routes: readonly (readonly [path: string, handler: ServedHandler])[],
	meta: object = {},
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
	for (const [path, handler] of routes)
		app
			.get(path)
			.meta({ ...meta, internal: true, [SERVED]: true })
			.handler(handler)
}

/**
 * The docs page's route: the page itself, built for the JSON URL the browser sees (the prefix the app strips,
 * then the path it routes). A `docs` that is not a page is the string the option used to take, so the throw
 * names the import a JavaScript caller needs.
 */
export function docsRoute(
	app: ServingHandle,
	docs: DocsPage,
	docsPath: string,
	jsonPath: string,
): [path: string, handler: ServedHandler] {
	if (typeof docs !== "function") {
		throw new TypeError(
			`docs takes the page itself: import { scalar } from "@lovrozagar/honey/openapi/scalar" (or swagger from "@lovrozagar/honey/openapi/swagger") and pass docs: scalar`,
		)
	}
	const url = `${app[GRAPH].settings.stripPrefix ?? ""}${under(app, jsonPath)}`
	return [docsPath, docs({ url }) as ServedHandler]
}
