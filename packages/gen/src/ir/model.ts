/**
 * The IR: what every emitter reads, built from an OpenAPI document and nothing else (H2). This
 * file holds its types; `schema.ts` reads a JSON Schema into an IR schema and follows refs.
 */

export type IRScalarType = "boolean" | "integer" | "null" | "number" | "string"

/** A value's constraint keywords as the spec states them (bit 19 c): a string's, a number's, an array's. */
export type IRBounds = {
	minLength?: number
	maxLength?: number
	pattern?: string
	minimum?: number
	maximum?: number
	exclusiveMinimum?: number
	exclusiveMaximum?: number
}

export type IRSchema =
	| ({ kind: "scalar"; type: IRScalarType; format?: string; enum?: (boolean | number | string)[] } & IRBounds)
	| {
			kind: "const"
			value: boolean | number | string
			/** the declared `type`, when there is one */ type?: IRScalarType
	  }
	| { kind: "object"; fields: IRField[]; additional?: IRSchema | false }
	| { kind: "array"; items: IRSchema; minItems?: number; maxItems?: number }
	| {
			kind: "tuple"
			items: IRSchema[]
			/** what may follow the fixed items; none: nothing may */
			rest?: IRSchema
			/** how many leading items must be there, when fewer than all: the rest is an optional tail */
			required?: number
	  }
	| { kind: "union"; variants: IRSchema[]; discriminator?: IRDiscriminator }
	| { kind: "allOf"; parts: IRSchema[] }
	| { kind: "ref"; name: string }
	| { kind: "nullable"; inner: IRSchema }
	| { kind: "binary" }
	| { kind: "unknown" }

export type IRField = {
	/** the raw JSON key, never mangled */
	name: string
	schema: IRSchema
	required: boolean
	description?: string
}

/** `mapping` maps a discriminant value to a bare component name. */
export type IRDiscriminator = { propertyName: string; mapping?: Record<string, string> }

export type IRParam = {
	name: string
	schema: IRSchema
	description?: string
	/** a path param is always required */
	required?: boolean
	/** a path param spanning segments (`x-honey-wildcard`) */
	wildcard?: true
	/** `schema.default`, as declared */
	default?: unknown
}

export type IRMultipartPart = {
	name: string
	/** `file` for a binary schema or a list of them */
	type: "file" | "text"
	schema?: IRSchema
}

export type IRBody =
	| { kind: "raw"; contentType: string; schema: IRSchema; required: boolean }
	| { kind: "stream"; contentType: "application/octet-stream"; required: boolean }
	| {
			kind: "multipart"
			contentType: "multipart/form-data"
			parts: IRMultipartPart[]
			required: boolean
			/** the whole form, for emitters that type it as one value */
			schema: IRSchema
	  }

export type IRResponse = {
	/** the status key as written: `200`, `4XX`, `default` */
	status: string
	/** none for a response without a body */
	contentType?: string
	schema?: IRSchema
	/** the declared headers (A2), names as written, in code-unit order; none when it declares none */
	headers?: { name: string; required: boolean; schema: IRSchema }[]
	/** every media type it declares with its schema; `contentType`/`schema` are the preferred one */
	contents?: { contentType: string; schema?: IRSchema }[]
	/** a response a declared error produces (`x-honey-error`), never a declared output */
	error?: true
}

export type IROperationExtensions = {
	deprecated?: true
	/** every declared error key (`x-honey-errors`): its status, null when it has none, and its own schema */
	errors?: Record<string, { schema?: IRSchema; status: number | null }>
	idempotencyKey?: true
	invalidates?: string[]
	mcp?: true
	realtime?: true
	/** the honey route id the operation came from (`x-honey-route`): what extracted ctx types are keyed by */
	route?: string
	sse?: true
	websocket?: true
}

export type IROperation = {
	/** the operationId */
	id: string
	/** upper case */
	method: string
	/** the OpenAPI path template, `{param}` kept */
	path: string
	description?: string
	summary?: string
	params: { path: IRParam[]; query: IRParam[]; header: IRParam[]; cookie?: IRParam[] }
	/** the preferred request body: JSON first, then form, multipart, raw bytes */
	body?: IRBody
	/** every declared body, in the same order, when there are several */
	bodies?: IRBody[]
	responses: Record<string, IRResponse>
	extensions: IROperationExtensions
}

export type IRTreeEntry = { kind: "method"; op: IROperation } | { kind: "namespace"; ns: IRNamespace }

export type IRNamespace = { entries: Map<string, IRTreeEntry> }

/** How a client authenticates: the header it sends and the prefix before the token. */
export type IRAuth = { headerName: string; prefix: string }

export type IRInfo = { title?: string; description?: string; version?: string }

/** How a webhook is signed (`x-honey-signature`); `prefix` precedes the digest, empty when nothing does. */
export type IRSignature = { algorithm: "hmac-sha256"; encoding: "base64" | "hex"; header: string; prefix: string }

/** A request the API sends a subscriber, `body` its JSON payload's schema. */
export type IRWebhook = Pick<IROperation, "description" | "method" | "summary"> & {
	name: string
	body?: IRSchema
	signature?: IRSignature
}

export type IR = {
	auth: IRAuth
	info: IRInfo
	operations: IROperation[]
	schemas: Record<string, IRSchema>
	/** the `description` of each component schema that has one */
	schemaDescriptions: Record<string, string>
	/** each server URL the document declares, in order: the first is an SDK's default base URL */
	servers: string[]
	tree: IRNamespace
	/** every webhook, by name in code-unit order */
	webhooks: IRWebhook[]
}
