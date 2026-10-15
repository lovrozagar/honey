/**
 * The OpenAPI 3.1 document, assembled: the info a caller gives (its own fields only), the servers,
 * the paths, and the components the document lifted or the caller declared. Keys go in one order,
 * so the same app always writes the same bytes.
 */
import type { JsonSchema } from "../schema/to-json-schema.ts"
import type { PathItem } from "./paths.ts"

export type OpenApiInfo = { readonly description?: string; readonly title: string; readonly version: string }

export type OpenApiServer = { readonly description?: string; readonly url: string }

export type OpenApiDocument = {
	components?: { schemas?: Record<string, JsonSchema>; securitySchemes?: Record<string, unknown> }
	info: OpenApiInfo
	openapi: "3.1.0"
	paths: Record<string, PathItem>
	servers?: OpenApiServer[]
}

export type DocumentParts = {
	readonly info: OpenApiInfo
	readonly paths: Record<string, PathItem>
	readonly schemas: Record<string, JsonSchema>
	readonly securitySchemes?: Readonly<Record<string, unknown>>
	readonly servers: readonly OpenApiServer[]
}

/** Only the Info Object's own fields: callers pass their whole options bag. */
function cleanInfo(info: OpenApiInfo): OpenApiInfo {
	const out: { description?: string; title: string; version: string } = { title: info.title, version: info.version }
	if (typeof info.description === "string") out.description = info.description
	return out
}

/** The document of `parts`: `servers` and `components` only when there is something to put in them. */
export function assembleDocument(parts: DocumentParts): OpenApiDocument {
	const doc: OpenApiDocument = { openapi: "3.1.0", info: cleanInfo(parts.info), paths: { ...parts.paths } }
	if (parts.servers.length > 0) doc.servers = parts.servers.map((server) => ({ ...server }))
	const components: NonNullable<OpenApiDocument["components"]> = {}
	if (Object.keys(parts.schemas).length > 0) components.schemas = parts.schemas
	if (parts.securitySchemes !== undefined) components.securitySchemes = { ...parts.securitySchemes }
	if (Object.keys(components).length > 0) doc.components = components
	return doc
}
