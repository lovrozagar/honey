/**
 * The IR: what every emitter reads, built from an OpenAPI document and nothing else (H2). This
 * file holds its types, the reading of a JSON Schema into an IR schema, and following refs.
 */

export type IRScalarType = "boolean" | "integer" | "null" | "number" | "string"

export type IRSchema =
	| { kind: "scalar"; type: IRScalarType; format?: string; enum?: (boolean | number | string)[] }
	| {
			kind: "const"
			value: boolean | number | string
			/** the declared `type`, when there is one */ type?: IRScalarType
	  }
	| { kind: "object"; fields: IRField[]; additional?: IRSchema | false }
	| { kind: "array"; items: IRSchema }
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
			schema?: IRSchema
	  }

export type IRResponse = {
	/** the status key as written: `200`, `4XX`, `default` */
	status: string
	/** none for a response without a body */
	contentType?: string
	schema?: IRSchema
}

export type IROperationExtensions = {
	deprecated?: true
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
	tree: IRNamespace
	/** every webhook, by name in code-unit order */
	webhooks: IRWebhook[]
}

type Json = Record<string, unknown>

const SCALARS: readonly unknown[] = ["boolean", "integer", "null", "number", "string"]

const lastSegment = (ref: string) => ref.split("/").pop() as string

/** Whether `schema` admits null: `nullable`, a null in its type list, or a null variant. */
function isNullable(schema: Json): boolean {
	if (schema.nullable === true) return true
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true
	const variants = (schema.anyOf ?? schema.oneOf) as Json[] | undefined
	return variants?.some((variant) => variant.type === "null") === true
}

/** The schema `schema` makes nullable; never wrapped twice. */
function nullableOf(schema: Json): IRSchema {
	let inner: IRSchema
	/* only a type list that holds null is stripped; a flag beside any other list drops the flag below */
	if (Array.isArray(schema.type) && schema.type.includes("null")) {
		const rest = (schema.type as unknown[]).filter((type) => type !== "null")
		inner = schemaToIR({ ...schema, type: rest.length === 1 ? rest[0] : rest })
	} else if (schema.anyOf !== undefined || schema.oneOf !== undefined) {
		const rest = ((schema.anyOf ?? schema.oneOf) as Json[]).filter((variant) => variant.type !== "null")
		if (rest.length === 0) inner = { kind: "unknown" }
		else inner = rest.length === 1 ? schemaToIR(rest[0]) : { kind: "union", variants: rest.map(schemaToIR) }
	} else {
		const { nullable: _flag, ...rest } = schema
		inner = schemaToIR(rest)
	}
	return inner.kind === "nullable" ? inner : { inner, kind: "nullable" }
}

function unionOf(schema: Json): IRSchema {
	const variants = ((schema.oneOf ?? schema.anyOf) as Json[]).map(schemaToIR)
	const raw = schema.discriminator as { mapping?: Record<string, string>; propertyName: string } | undefined
	if (raw === undefined) return { kind: "union", variants }
	const discriminator: IRDiscriminator = { propertyName: raw.propertyName }
	if (raw.mapping !== undefined) {
		discriminator.mapping = Object.fromEntries(
			Object.entries(raw.mapping).map(([value, ref]) => [value, lastSegment(ref)]),
		)
	}
	return { discriminator, kind: "union", variants }
}

/** A string or integer enum as a scalar; a mixed one as a union of consts; `null` when it is neither. */
function enumOf(schema: Json): IRSchema | null {
	const values = schema.enum as (boolean | number | string)[]
	if (values.length === 0) return null
	const all = (test: (value: unknown) => boolean) => schema.type === undefined && values.every(test)
	if (schema.type === "string" || all((value) => typeof value === "string"))
		return { enum: values, kind: "scalar", type: "string" }
	if (schema.type === "integer" || all(Number.isInteger)) return { enum: values, kind: "scalar", type: "integer" }
	return values.every(literal) ? { kind: "union", variants: values.map((value) => ({ kind: "const", value })) } : null
}

function objectOf(schema: Json): IRSchema {
	const properties = (schema.properties ?? {}) as Record<string, Json>
	const required = new Set((schema.required as string[] | undefined) ?? [])
	const fields = Object.entries(properties).map(([name, property]) => {
		const field: IRField = { name, required: required.has(name), schema: schemaToIR(property) }
		if (typeof property.description === "string") field.description = property.description
		return field
	})
	const ap = schema.additionalProperties
	if (ap === undefined) return { fields, kind: "object" }
	return {
		additional: ap === false ? false : ap === true ? { kind: "unknown" } : schemaToIR(ap as Json),
		fields,
		kind: "object",
	}
}

type Reader = (schema: Json) => IRSchema | null

const isSchema = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * A tuple, as 2020-12 (`prefixItems`, then `items` for the rest) or draft-07 (`items` as a list,
 * then `additionalItems`) writes it. Without a rest schema it is closed: zod leaves `items: false`
 * out of a closed tuple. `minItems` below the length makes an optional tail.
 */
function tupleOf(schema: Json): IRSchema | null {
	const modern = Array.isArray(schema.prefixItems)
	const fixed = (modern ? schema.prefixItems : schema.items) as Json[]
	if (!Array.isArray(fixed)) return null
	const tuple: Extract<IRSchema, { kind: "tuple" }> = { items: fixed.map(schemaToIR), kind: "tuple" }
	const rest = modern ? schema.items : schema.additionalItems
	if (isSchema(rest)) tuple.rest = schemaToIR(rest)
	if (typeof schema.minItems === "number" && schema.minItems < fixed.length) tuple.required = schema.minItems
	return tuple
}

const literal = (value: unknown): value is boolean | number | string =>
	typeof value === "string" || typeof value === "number" || typeof value === "boolean"

function constOf(schema: Json): IRSchema | null {
	const value = schema.const
	if (!literal(value)) return null
	const typed = SCALARS.includes(schema.type) && schema.type !== "null"
	return typed ? { kind: "const", type: schema.type as IRScalarType, value } : { kind: "const", value }
}

function scalarOf(schema: Json): IRSchema | null {
	if (!SCALARS.includes(schema.type)) return null
	const scalar: Extract<IRSchema, { kind: "scalar" }> = { kind: "scalar", type: schema.type as IRScalarType }
	if (typeof schema.format === "string") scalar.format = schema.format
	if (Array.isArray(schema.enum)) scalar.enum = schema.enum as (boolean | number | string)[]
	return scalar
}

/* the order matters: a ref before anything it might also say, const before type, nullability before unions */
const READERS: readonly Reader[] = [
	(schema) => (typeof schema.$ref === "string" ? { kind: "ref", name: lastSegment(schema.$ref) } : null),
	(schema) => (Array.isArray(schema.allOf) ? { kind: "allOf", parts: (schema.allOf as Json[]).map(schemaToIR) } : null),
	constOf,
	(schema) => (isNullable(schema) ? nullableOf(schema) : null),
	(schema) =>
		Array.isArray(schema.type) && schema.type.length > 1
			? { kind: "union", variants: (schema.type as unknown[]).map((type) => schemaToIR({ ...schema, type })) }
			: null,
	(schema) => (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) ? unionOf(schema) : null),
	(schema) => (Array.isArray(schema.enum) ? enumOf(schema) : null),
	(schema) =>
		schema.format === "binary" && (schema.type === "string" || schema.type === undefined) ? { kind: "binary" } : null,
	tupleOf,
	(schema) => (schema.type === "array" ? { items: schemaToIR(schema.items as Json | undefined), kind: "array" } : null),
	(schema) =>
		schema.type === "object" || schema.properties !== undefined || schema.additionalProperties !== undefined
			? objectOf(schema)
			: null,
	scalarOf,
]

/** What a typed value of `schema` is in the IR, read in a fixed order; anything unreadable is `unknown`. */
export function schemaToIR(schema: Json | undefined): IRSchema {
	if (schema === undefined) return { kind: "unknown" }
	for (const read of READERS) {
		const ir = read(schema)
		if (ir !== null) return ir
	}
	return { kind: "unknown" }
}

/** Follows `ref` nodes to their component; an unknown or endless one is `unknown`. */
export function irResolver(schemas: Record<string, IRSchema>): (schema: IRSchema) => IRSchema {
	return (schema) => {
		let at = schema
		for (let hops = 0; at.kind === "ref"; hops++) {
			const next = Object.hasOwn(schemas, at.name) ? schemas[at.name] : undefined
			if (next === undefined || hops === 32) return { kind: "unknown" }
			at = next
		}
		return at
	}
}
