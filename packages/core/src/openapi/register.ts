/**
 * `@lovrozagar/honey/openapi`: the app's OpenAPI 3.1 document and route manifest, generated or
 * served. Each docs page and the static document server is a subpath of its own. A plain subpath:
 * nothing registers itself, and an app that never imports it carries none of it.
 */
export type { OpenApiDocument, OpenApiInfo } from "./document.ts"
export {
	type GenerateOpenApiOptions,
	generateOpenApi,
	type OpenApiExternalDocs,
	type OpenApiRouteInfo,
	type OpenApiServer,
	type OpenApiServerVariable,
	type OpenApiTag,
} from "./generate.ts"
export {
	type GenerateManifestOptions,
	generateManifest,
	type ManifestError,
	type ManifestRoute,
	type RouteManifest,
} from "./manifest.ts"
export type { DocsConfig } from "./docs-page.ts"
export type { DocsPage } from "./served.ts"
export { type ServeManifestOptions, type ServeOpenApiOptions, serveManifest, serveOpenApi } from "./serve.ts"
export { toYaml } from "./yaml.ts"
