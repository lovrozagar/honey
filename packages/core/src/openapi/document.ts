/**
 * The OpenAPI 3.1 document, assembled: the info a caller gives (its own fields only), the servers,
 * the paths, the webhooks, the components the document lifted or the caller declared, the tags and
 * the external docs. Keys go in the specification's field order, so the same app always writes the
 * same bytes.
 */
import type { JsonSchema } from "../schema/to-json-schema.ts"
import type { Operation, PathItem } from "./paths.ts"
import type { OpenApiServer } from "./servers.ts"
import type { OpenApiExternalDocs, OpenApiTag } from "./tags.ts"

/** The document's Info Object. */
export type OpenApiInfo = {
	/** what the API is for; CommonMark */
	readonly description?: string
	/** the API's name */
	readonly title: string
	/** the API's own version, not the OpenAPI version */
	readonly version: string
}

/** The generated OpenAPI 3.1 document. An optional field is left out when it would be empty, except `components.securitySchemes`. */
export type OpenApiDocument = {
	/** the schemas operations share by reference, and the security schemes the caller passed */
	components?: {
		/** the body schemas, one per distinct shape, and the nested shapes they share, by name */
		schemas?: Record<string, JsonSchema>
		/** the schemes the caller passed; present, even empty, whenever the option was set */
		securitySchemes?: Record<string, unknown>
	}
	/** the document's own external docs */
	externalDocs?: OpenApiExternalDocs
	/** the API's name, version and description */
	info: OpenApiInfo
	/** the OpenAPI version the document follows */
	openapi: "3.1.0"
	/** each route's operations, by OpenAPI path such as `/users/{id}` */
	paths: Record<string, PathItem>
	/** the servers the API is reachable at */
	servers?: OpenApiServer[]
	/** every tag an operation names, in first-named order, with the metadata the caller declared for it */
	tags?: OpenApiTag[]
	/** the requests the API sends subscribers, by name and then by lowercase method */
	webhooks?: Record<string, Record<string, Operation>>
}

export type DocumentParts = {
	readonly externalDocs?: OpenApiExternalDocs
	readonly info: OpenApiInfo
	readonly paths: Record<string, PathItem>
	readonly schemas: Record<string, JsonSchema>
	readonly securitySchemes?: Readonly<Record<string, unknown>>
	readonly servers: readonly OpenApiServer[]
	readonly tags: readonly OpenApiTag[]
	readonly webhooks: Record<string, Record<string, Operation>>
}

/** Only the Info Object's own fields: callers pass their whole options bag. */
function cleanInfo(info: OpenApiInfo): OpenApiInfo {
	const out: { description?: string; title: string; version: string } = { title: info.title, version: info.version }
	if (typeof info.description === "string") out.description = info.description
	return out
}

/** The document of `parts`: each optional field only when there is something to put in it. */
export function assembleDocument(parts: DocumentParts): OpenApiDocument {
	const doc: OpenApiDocument = {
		openapi: "3.1.0",
		info: cleanInfo(parts.info),
		...(parts.servers.length > 0 ? { servers: [...parts.servers] } : {}),
		paths: { ...parts.paths },
	}
	if (Object.keys(parts.webhooks).length > 0) doc.webhooks = parts.webhooks
	const components: NonNullable<OpenApiDocument["components"]> = {}
	if (Object.keys(parts.schemas).length > 0) components.schemas = parts.schemas
	if (parts.securitySchemes !== undefined) components.securitySchemes = { ...parts.securitySchemes }
	if (Object.keys(components).length > 0) doc.components = components
	if (parts.tags.length > 0) doc.tags = [...parts.tags]
	if (parts.externalDocs !== undefined) doc.externalDocs = structuredClone(parts.externalDocs)
	return doc
}
