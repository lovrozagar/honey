/**
 * `serveStaticOpenApi(app, options)`: the JSON (and YAML) routes, plus docs pages when asked, for a document
 * built ahead of time or living elsewhere — a Workers asset binding, a URL, an inline value or a loader. It
 * carries none of the generator, so an app that already has its document on disk pays for serving it and
 * nothing more. Each route is a plain internal GET on the handle, marked SERVED, so the document never
 * documents its own endpoints. A document is loaded once per process or isolate, concurrent first requests
 * sharing that one load, and a load that failed is not kept, so the next request tries again. Nothing parses
 * the document: it is a build artifact or an upstream's responsibility, and honey's own content-type is sent
 * whatever the upstream said. `auth` puts a Basic guard in front of every route the call mounts.
 */
import { HoneyError } from "../errors/error.ts"
import {
	answering,
	artifact,
	type Artifact,
	type DocsPages,
	docsRoutes,
	JSON_TYPE,
	mountAll,
	type ServedAccess,
	type ServedContext,
	type ServedMeta,
	type ServedHandler,
	type ServingHandle,
	YAML_TYPE,
} from "./served.ts"

/** A document the app loads itself. A string or a 2xx `Response`'s body is served and kept; a non-2xx `Response` or a throw answers 500 and the next request loads again. */
export type DocumentLoader = (ctx: {
	/** the runtime's env for the request, such as Workers bindings */
	readonly env: unknown
	/** the request that set off this load */
	readonly req: Request
}) => Promise<Response | string> | Response | string

/** A document fetched when a request first asks for it: an asset binding, a URL, or the app's own loader. */
export type FetchedSource =
	| DocumentLoader
	| {
			/** the asset's path, resolved against the request URL; a non-2xx answer becomes a 500 */
			readonly asset: string
			/** the env key of the asset binding, `"ASSETS"` by default; a missing binding answers 500 */
			readonly binding?: string
	  }
	| {
			/** `fetch` options for the request, such as auth headers */
			readonly init?: RequestInit
			/** the URL to fetch; a failure or non-2xx answers 502 */
			readonly url: string
	  }

/** Where the JSON document comes from; an inline object is serialized once, on the first request. */
export type JsonSource =
	| FetchedSource
	| {
			/** the document, as an object (serialized with `JSON.stringify`) or as JSON text served as is */
			readonly inline: object | string
	  }

/** Where the YAML document comes from. There is no inline object: nothing converts one without a converter. */
export type YamlSource =
	| FetchedSource
	| {
			/** the document as YAML text, served as is */
			readonly inline: string
	  }

/** What `serveStaticOpenApi` takes: where the document comes from, and where and how it is served. */
export type ServeStaticOpenApiOptions<A = unknown> = ServedAccess<true> & {
	/** the docs pages for the document, each path (under the handle's basePath) mapped to the page itself: `{ "/docs": scalar }` */
	readonly docs?: DocsPages
	/** `false` mounts nothing */
	readonly enabled?: boolean
	/** where the JSON document comes from; it loads on the first request and is kept for the process or isolate, and a failed load is tried again on the next request */
	readonly json: JsonSource
	/** the whole path of the JSON route, in place of `${path}.json` */
	readonly jsonPath?: string
	/** every mounted route's meta: honey's keys and the handle's declared ones, under the internal SERVED marking */
	readonly meta?: ServedMeta<A>
	/** the stem the document is served at, `"/openapi"` by default */
	readonly path?: string
	/** the YAML document; with none, no YAML route is mounted */
	readonly yaml?: YamlSource
	/** the whole path of the YAML route, in place of `${path}.yaml` and `${path}.yml` */
	readonly yamlPath?: string
}

type Loaded = { readonly etag?: string; readonly text: string }

/** A failure the app's own error boundary answers, with the standard envelope for `statusKey`. */
const failed = (statusKey: "bad_gateway" | "internal_server_error", cause: unknown) =>
	new HoneyError({ cause, errorKey: statusKey, status: statusKey })

/** `binding`'s own `fetch`, or the 500 that names the binding nothing bound. */
function bound(env: unknown, binding: string): (input: URL) => Promise<Response> {
	const target = (Object(env) as Record<string, { fetch?: unknown } | undefined>)[binding]
	if (typeof target?.fetch !== "function") {
		throw failed(
			"internal_server_error",
			new Error(`no asset binding ${binding}: bind the directory the document is in as ${binding}`),
		)
	}
	const fetched = target.fetch as (input: URL) => Promise<Response>
	return (input) => fetched.call(target, input)
}

/** What `res` carries, with its validator when the upstream sent a strong one; a non-2xx is `statusKey`. */
async function answered(
	res: Response,
	statusKey: "bad_gateway" | "internal_server_error",
	what: string,
): Promise<Loaded> {
	if (!res.ok) throw failed(statusKey, new Error(`${what} answered ${String(res.status)}`))
	const etag = res.headers.get("etag")
	const strong = etag !== null && /^"[^"]*"$/.test(etag)
	return { ...(strong ? { etag } : {}), text: await res.text() }
}

/** The document `source` holds, for the request that first asks for it. */
async function read(source: JsonSource | YamlSource, ctx: ServedContext): Promise<Loaded> {
	if (typeof source === "function") {
		let loaded: Response | string
		try {
			loaded = await source({ env: ctx.env, req: ctx.req })
		} catch (error) {
			throw failed("internal_server_error", error)
		}
		return typeof loaded === "string" ? { text: loaded } : await answered(loaded, "internal_server_error", "the loader")
	}
	if ("inline" in source) {
		return { text: typeof source.inline === "string" ? source.inline : JSON.stringify(source.inline) }
	}
	if ("asset" in source) {
		const res = await bound(ctx.env, source.binding ?? "ASSETS")(new URL(source.asset, ctx.req.url))
		return await answered(res, "internal_server_error", `asset ${source.asset}`)
	}
	let res: Response
	try {
		res = await fetch(source.url, source.init)
	} catch (error) {
		throw failed("bad_gateway", error)
	}
	return await answered(res, "bad_gateway", source.url)
}

/**
 * `source`'s document for this isolate: loaded on the first request, kept with its ETag, and loaded again
 * only after a load that failed. Every request waiting on the first one shares it.
 */
function loading(source: JsonSource | YamlSource, contentType: string): (ctx: ServedContext) => Promise<Artifact> {
	let kept: Promise<Artifact> | null = null
	return (ctx) => {
		kept ??= read(source, ctx).then(
			async ({ etag, text }) =>
				etag === undefined ? await artifact(text, contentType) : { body: text, contentType, etag },
			(error: unknown) => {
				/* not kept, so the next request loads again */
				kept = null
				throw error
			},
		)
		return kept
	}
}

/** Serve a document built ahead of time or living elsewhere, and its docs pages when asked, from `app`; returns `app`. */
export function serveStaticOpenApi<A>(app: A, options: ServeStaticOpenApiOptions<A>): A {
	const { auth, cacheControl, docs, enabled = true, json, jsonPath, meta = {}, path = "/openapi" } = options
	if (auth !== undefined && cacheControl !== undefined)
		throw new TypeError("serveStaticOpenApi: auth answers private, no-store; leave cacheControl out beside it")
	if (!enabled) return app
	const handle = app as unknown as ServingHandle
	const stem = jsonPath ?? `${path}.json`
	const routes: [string, ServedHandler][] = [[stem, answering(loading(json, JSON_TYPE), cacheControl, auth)]]
	if (options.yaml !== undefined) {
		const served = answering(loading(options.yaml, YAML_TYPE), cacheControl, auth)
		const at = options.yamlPath === undefined ? [`${path}.yaml`, `${path}.yml`] : [options.yamlPath]
		for (const yamlPath of at) routes.push([yamlPath, served])
	}
	if (docs !== undefined) routes.push(...docsRoutes(handle, docs, stem))
	mountAll(handle, routes, meta, auth)
	return app
}
