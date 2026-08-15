/** Slot for runtime spec/manifest generation. Filled by `import "honey/openapi"`. */

export type OpenApiGenerate = (
	app: unknown,
	options: {
		filterRoutes?: (route: { meta: unknown; method: string; path: string }) => boolean
		info: { description?: string; title: string; version: string }
		securitySchemes?: Record<string, unknown>
	},
) => Promise<unknown>

export type ManifestGenerate = (app: unknown) => Promise<unknown>

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

const MISSING =
	'Runtime OpenAPI/manifest generation requires `import "honey/openapi"` in the app entry.'

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
