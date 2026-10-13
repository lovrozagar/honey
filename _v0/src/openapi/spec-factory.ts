/** Slot for runtime spec/manifest generation. Filled by `import "@lovrozagar/honey/openapi"`. */

export type OpenApiGenerate = (
	app: unknown,
	options: {
		filterRoutes?: (route: { meta: unknown; method: string; path: string }) => boolean
		info: { description?: string; title: string; version: string }
		invalidate?: "error" | "off" | "warn" | { entityKey?: string; level?: "error" | "off" | "warn" }
		onSchemaError?: "throw" | "warn"
		profile?: string
		securitySchemes?: Record<string, unknown>
	},
) => Promise<unknown>

export type ManifestGenerate = (
	app: unknown,
	options?: {
		filterRoutes?: (route: { meta: unknown; method: string; path: string }) => boolean
		visibility?: "all" | "published"
	},
) => Promise<unknown>

export type YamlGenerate = (value: unknown) => string

import type { HoneyRes } from "../response.ts"

export type DocsUi = (
	kind: "scalar" | "swagger",
	specUrl: string,
) => (ctx: { res: HoneyRes }) => Response | Promise<Response>

/** A served document, serialized once per route epoch: the bytes, their type and a strong ETag. */
export type ServedArtifact = { body: string; contentType: string; etag: string }

export type OpenApiRuntime = {
	/** Answer a request for a served artifact: `ETag`, `Cache-Control`, and 304 on a match. */
	artifactResponse: (request: Request, artifact: ServedArtifact) => Response
	docsUi: DocsUi
	generateManifest: ManifestGenerate
	generateOpenApi: OpenApiGenerate
	toServedArtifact: (body: string, contentType: string) => Promise<ServedArtifact>
	toYaml: YamlGenerate
}

const MISSING = 'Runtime OpenAPI/manifest generation requires `import "@lovrozagar/honey/openapi"` in the app entry.'

let runtime: OpenApiRuntime | undefined

export function registerOpenApiRuntime(next: OpenApiRuntime): void {
	runtime = next
}

export function resetOpenApiRuntime(): void {
	runtime = undefined
}

export function getOpenApiRuntime(): OpenApiRuntime {
	if (!runtime) throw new Error(MISSING)
	return runtime
}

export function tryGetOpenApiRuntime(): OpenApiRuntime | undefined {
	return runtime
}

/**
 * Memoize `compute` per route epoch. A failure is cached too, until the routes change: a
 * document that cannot be generated fails every request the same way instead of re-running the
 * whole generation per request.
 */
export function epochCached<T>(epochOf: () => number, compute: () => Promise<T>): () => Promise<T> {
	let entry: { epoch: number; value: Promise<T> } | null = null
	return () => {
		const epoch = epochOf()
		if (entry === null || entry.epoch !== epoch) {
			const value = Promise.resolve().then(compute)
			/* handled here so a failure no request is awaiting yet is never an unhandled rejection */
			value.catch(() => {})
			entry = { epoch, value }
		}
		return entry.value
	}
}

const APP = Symbol.for("honey.app")

/**
 * Bind an internal handler (`spec()`, docs UIs) to the app serving it. Returns a new function
 * per app, so one `spec()` handler mounted on two apps documents each of them — binding onto
 * the shared function object would make the second mount throw or steal the first.
 */
export function bindInternalHandler<F extends (ctx: never, app?: unknown) => unknown>(fn: F, app: unknown): F {
	const bound = ((ctx: never) => fn(ctx, app)) as unknown as F
	for (const key of Reflect.ownKeys(fn)) {
		if (typeof key !== "symbol" || key === APP) continue
		Object.defineProperty(bound, key, { value: (fn as unknown as Record<symbol, unknown>)[key] })
	}
	Object.defineProperty(bound, APP, { value: app })
	return bound
}
