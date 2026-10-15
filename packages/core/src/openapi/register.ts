/**
 * `@lovrozagar/honey/openapi`: the app's OpenAPI 3.1 document and route manifest, generated or
 * served, and the docs pages. A plain subpath: nothing registers itself, and an app that never
 * imports it carries none of it.
 */
export { SERVED } from "../routing/register.ts"
export type { OpenApiDocument, OpenApiInfo } from "./document.ts"
export {
	type GenerateOpenApiOptions,
	generateOpenApi,
	type OpenApiExternalDocs,
	type OpenApiRouteInfo,
	type OpenApiServer,
	type OpenApiServerVariable,
	type OpenApiTag,
	type OpenApiWebhook,
	type WebhookSignature,
} from "./generate.ts"
export {
	type GenerateManifestOptions,
	generateManifest,
	type ManifestError,
	type ManifestRoute,
	type RouteManifest,
} from "./manifest.ts"
export { type DocsConfig, inlineJson } from "./docs-page.ts"
export { scalar } from "./scalar.ts"
export { type ServeManifestOptions, type ServeOpenApiOptions, serveManifest, serveOpenApi } from "./serve.ts"
export { swagger } from "./swagger.ts"
export { toYaml } from "./yaml.ts"
