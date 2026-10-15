/**
 * `serveOpenApi(app, options)` and `serveManifest(app, options?)`: an app serving its own document
 * (JSON at `${path}.json`, the same document as YAML at `.yaml` and `.yml`, and a docs page when
 * asked) and its published manifest. Each is a plain internal GET on the handle it is called on,
 * so the handle's basePath and middleware apply, marked SERVED so it stays with this app. A call
 * mounts all its routes or, when any path is taken, none. Each artifact is built once per route
 * change, a failed build kept for its routes too, and answered with a strong ETag, `no-cache` and a
 * 304 for a matching `If-None-Match`. A served document never runs the invalidate check and
 * documents a schema it cannot convert unconstrained, with a warning.
 */
import { ifNoneMatchHits } from "../response/etag.ts"
import type { TypedResponse } from "../response/response.ts"
import { isStaticPattern, joinPatterns, parsePattern } from "../routing/pattern.ts"
import { assertRouteFree, GRAPH, type HandleView, type HoneyGraph, SERVED, VIEW } from "../routing/register.ts"
import type { DocsContext } from "./docs-page.ts"
import { type GenerateOpenApiOptions, generateOpenApi } from "./generate.ts"
import { type GenerateManifestOptions, generateManifest } from "./manifest.ts"
import { scalar } from "./scalar.ts"
import { swagger } from "./swagger.ts"
import { toYaml } from "./yaml.ts"

export type ServeOpenApiOptions = Omit<GenerateOpenApiOptions, "info" | "invalidate" | "onSchemaError"> & {
	readonly description?: string
	/** a docs page for the document, at `docsPath` */
	readonly docs?: "scalar" | "swagger"
	/** `"/docs"` by default */
	readonly docsPath?: string
	/** `false` mounts nothing */
	readonly enabled?: boolean
	/** the stem the document is served at, `"/openapi"` by default: `.json`, `.yaml` and `.yml` follow */
	readonly path?: string
	readonly title: string
	readonly version: string
}

export type ServeManifestOptions = Omit<GenerateManifestOptions, "visibility"> & {
	/** `false` mounts nothing */
	readonly enabled?: boolean
	/** `"/manifest.json"` by default */
	readonly path?: string
}

type ServedContext = DocsContext & {
	readonly req: Request
	readonly res: { raw(response: Response): TypedResponse }
}

type ServedHandler = (ctx: ServedContext) => unknown

/** A handle serving routes about its app: what these functions read and register through. */
type ServingHandle = {
	readonly [GRAPH]: HoneyGraph
	readonly [VIEW]: HandleView
	get(path: string): { meta(meta: object): { handler(fn: ServedHandler): unknown } }
}

type Artifact = { readonly body: string; readonly contentType: string; readonly etag: string }

const JSON_TYPE = "application/json; charset=utf-8"
const YAML_TYPE = "application/yaml; charset=utf-8"

/** What `build` gives for the graph's routes as they are, built again only once they change; a throw is kept too. */
function perEpoch<T>(g: HoneyGraph, build: () => T): () => T {
	let cached: { epoch: number; failed: boolean; value: unknown } | null = null
	return () => {
		if (cached === null || cached.epoch !== g.epoch) {
			try {
				cached = { epoch: g.epoch, failed: false, value: build() }
			} catch (error) {
				/* kept for these routes and thrown on every read below: the boundary answers it */
				cached = { epoch: g.epoch, failed: true, value: error }
			}
		}
		if (cached.failed) throw cached.value
		return cached.value as T
	}
}

/** `body` with its strong validator: base64url of the first 16 bytes of its SHA-256, quoted. */
async function artifact(body: string, contentType: string): Promise<Artifact> {
	const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)), 0, 16)
	let binary = ""
	for (const byte of hash) binary += String.fromCharCode(byte)
	const tag = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
	return { body, contentType, etag: `"${tag}"` }
}

/** The answer for `served`: revalidated on every use (`no-cache`), an unchanged one a 304. */
function answering(served: () => Promise<Artifact>): ServedHandler {
	return async (ctx) => {
		const { body, contentType, etag } = await served()
		const headers = {
			"cache-control": "no-cache",
			"content-type": contentType,
			etag,
			"x-content-type-options": "nosniff",
		}
		const hit = ifNoneMatchHits(ctx.req.headers.get("if-none-match"), etag)
		return ctx.res.raw(hit ? new Response(null, { headers, status: 304 }) : new Response(body, { headers }))
	}
}

/** `path` under the handle's basePath. */
const under = (app: ServingHandle, path: string) => joinPatterns(app[VIEW].basePath, path)

/** Mount every route, or none: each path is checked fixed and free before any is registered. */
function mountAll(app: ServingHandle, routes: readonly (readonly [path: string, handler: ServedHandler])[]): void {
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
			.meta({ internal: true, [SERVED]: true })
			.handler(handler)
}

/** Serve the app's OpenAPI document, and a docs page for it when asked, from `app`; returns `app`. */
export function serveOpenApi<A>(app: A, options: ServeOpenApiOptions): A {
	const { description, docs, docsPath = "/docs", enabled = true, path = "/openapi", title, version, ...rest } = options
	if (!enabled) return app
	const handle = app as unknown as ServingHandle
	const g = handle[GRAPH]
	const info = description === undefined ? { title, version } : { description, title, version }
	const document = perEpoch(g, () =>
		generateOpenApi(handle, { ...rest, info, invalidate: "off", onSchemaError: "warn" }),
	)
	const json = perEpoch(g, () => artifact(JSON.stringify(document()), JSON_TYPE))
	const yaml = perEpoch(g, () => artifact(toYaml(document()), YAML_TYPE))
	const routes: [string, ServedHandler][] = [
		[`${path}.json`, answering(json)],
		[`${path}.yaml`, answering(yaml)],
		[`${path}.yml`, answering(yaml)],
	]
	if (docs !== undefined) {
		/* the URL the browser sees: the prefix the app strips, then the path it routes */
		const url = `${g.settings.stripPrefix ?? ""}${under(handle, `${path}.json`)}`
		routes.push([docsPath, (docs === "scalar" ? scalar : swagger)({ url }) as ServedHandler])
	}
	mountAll(handle, routes)
	return app
}

/** Serve the app's published manifest from `app`; returns `app`. */
export function serveManifest<A>(app: A, options: ServeManifestOptions = {}): A {
	const { enabled = true, path = "/manifest.json", ...rest } = options
	if (!enabled) return app
	const handle = app as unknown as ServingHandle
	const manifest = perEpoch(handle[GRAPH], () =>
		artifact(JSON.stringify(generateManifest(handle, { ...rest, visibility: "published" })), JSON_TYPE),
	)
	mountAll(handle, [[path, answering(manifest)]])
	return app
}
