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

export type OpenApiRuntime = {
	docsUi: DocsUi
	generateManifest: ManifestGenerate
	generateOpenApi: OpenApiGenerate
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
