/**
 * `serveOpenApi(app, options)` and `serveManifest(app, options?)`: an app serving its own document
 * (JSON at `${path}.json`, the same document as YAML at `.yaml` and `.yml`, and a docs page when
 * asked) and its published manifest. Each is a plain internal GET on the handle it is called on,
 * so the handle's basePath and middleware apply, marked SERVED so it stays with this app. A call
 * mounts all its routes or, when any path is taken, none. Each artifact is built once per route
 * change, a failed build kept for its routes too, and answered with a strong ETag, `no-cache` and a
 * 304 for a matching `If-None-Match`. A served document never runs the invalidate check and
 * documents a schema it cannot convert unconstrained, with a warning. `docs` is the page itself, so
 * an app that shows none carries neither page, and one that shows one carries only that one.
 */
import { GRAPH, type HoneyGraph } from "../routing/register.ts"
import { type GenerateOpenApiOptions, generateOpenApi } from "./generate.ts"
import { type GenerateManifestOptions, generateManifest } from "./manifest.ts"
import {
	answering,
	artifact,
	type DocsPage,
	docsRoute,
	JSON_TYPE,
	mountAll,
	type ServedHandler,
	type ServingHandle,
	YAML_TYPE,
} from "./served.ts"
import { toYaml } from "./yaml.ts"

export type ServeOpenApiOptions = Omit<GenerateOpenApiOptions, "info" | "invalidate" | "onSchemaError"> & {
	readonly description?: string
	/** a docs page for the document, at `docsPath`: the page itself, `scalar` or `swagger` */
	readonly docs?: DocsPage
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
	if (docs !== undefined) routes.push(docsRoute(handle, docs, docsPath, `${path}.json`))
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
