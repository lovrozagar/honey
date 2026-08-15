import { type OpenApiSpecInput, extractOpenApiPathParams, resolveRefs } from "./codegen.ts"

export type IRScalarType = "string" | "number" | "integer" | "boolean" | "null"

export type IRSchema =
	| { kind: "scalar"; type: IRScalarType; format?: string; enum?: (string | number | boolean)[] }
	| { kind: "const"; value: string | number | boolean }
	| { kind: "object"; fields: IRField[]; additional?: IRSchema | false }
	| { kind: "array"; items: IRSchema }
	| { kind: "tuple"; items: IRSchema[] }
	| { kind: "union"; variants: IRSchema[]; discriminator?: IRDiscriminator }
	| { kind: "allOf"; parts: IRSchema[] }
	| { kind: "ref"; name: string }
	| { kind: "nullable"; inner: IRSchema }
	| { kind: "binary" }
	| { kind: "unknown" }

export type IRField = {
	name: string /* raw JSON key, no mangling */
	schema: IRSchema
	required: boolean
	description?: string
}

export type IRDiscriminator = {
	propertyName: string
	mapping?: Record<string, string> /* value → bare schema name */
}

export type IRParam = {
	name: string
	schema: IRSchema
	description?: string
}

export type IRMultipartPart = {
	name: string
	/** "file" for schemas with kind === "binary" (or array-of-binary), otherwise "text". */
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
		}

export type IRResponse = {
	status: string /* "200" | "204" | "default" | ... — preserved verbatim */
	contentType?: string /* undefined for 204 / no-content */
	schema?: IRSchema
}

export type IROperationExtensions = {
	websocket?: true
	realtime?: true
	sse?: true
	deprecated?: true
	idempotencyKey?: true
	mcp?: true
	invalidates?: string[]
}

export type IROperation = {
	id: string /* operationId */
	method: string /* upper-cased HTTP method */
	path: string /* OpenAPI path template, {param} preserved */
	description?: string
	params: {
		path: IRParam[]
		query: IRParam[]
		header: IRParam[]
	}
	body?: IRBody
	responses: Record<string, IRResponse>
	extensions: IROperationExtensions
}

export type IRTreeEntry =
	| { kind: "method"; op: IROperation }
	| { kind: "namespace"; ns: IRNamespace }

export type IRNamespace = {
	entries: Map<string, IRTreeEntry>
}

export type IR = {
	operations: IROperation[]
	schemas: Record<string, IRSchema>
	tree: IRNamespace
}

export function methodsOf(ns: IRNamespace): Array<[string, IROperation]> {
	return [...ns.entries.entries()]
		.filter((e): e is [string, Extract<IRTreeEntry, { kind: "method" }>] => e[1].kind === "method")
		.map(([k, v]) => [k, v.op])
		.sort(([a], [b]) => a.localeCompare(b))
}

export function namespacesOf(ns: IRNamespace): Array<[string, IRNamespace]> {
	return [...ns.entries.entries()]
		.filter((e): e is [string, Extract<IRTreeEntry, { kind: "namespace" }>] => e[1].kind === "namespace")
		.map(([k, v]) => [k, v.ns])
		.sort(([a], [b]) => a.localeCompare(b))
}

function firstDescendantId(ns: IRNamespace): string {
	for (const [, entry] of ns.entries) {
		if (entry.kind === "method") return entry.op.id
		const sub = firstDescendantId(entry.ns)
		if (sub) return sub
	}
	return ""
}

export function buildResourceTree(operations: IROperation[]): IRNamespace {
	const root: IRNamespace = { entries: new Map() }

	for (const op of operations) {
		const segments = op.id.split(".")
		let cur = root

		for (let i = 0; i < segments.length - 1; i++) {
			const seg = segments[i] ?? ""
			const existing = cur.entries.get(seg)
			if (existing) {
				if (existing.kind === "method") {
					throw new Error(
						`operationId conflict: "${existing.op.id}" is callable but also a namespace prefix of "${op.id}".\n` +
						`Rename one. Suggested: "${existing.op.id}" → "${existing.op.id}One" or drop "${op.id}".`,
					)
				}
				cur = existing.ns
			} else {
				const ns: IRNamespace = { entries: new Map() }
				cur.entries.set(seg, { kind: "namespace", ns })
				cur = ns
			}
		}

		const leafName = segments[segments.length - 1] ?? ""
		const existing = cur.entries.get(leafName)
		if (existing && existing.kind === "namespace") {
			const otherId = firstDescendantId(existing.ns)
			throw new Error(
				`operationId conflict: "${op.id}" is callable but also a namespace prefix of "${otherId}".\n` +
				`Rename one. Suggested: "${op.id}" → "${op.id}One" or drop "${otherId}".`,
			)
		}
		cur.entries.set(leafName, { kind: "method", op })
	}

	return root
}

function isNullableSchema(schema: Record<string, unknown>): boolean {
	if (schema.nullable === true) return true
	const t = schema.type
	if (Array.isArray(t) && (t as unknown[]).includes("null")) return true
	const variants = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined
	if (variants && variants.some((v) => v.type === "null")) return true
	return false
}

function isStringEnum(schema: Record<string, unknown>): boolean {
	const e = schema.enum as unknown[] | undefined
	if (!e || e.length === 0) return false
	const t = schema.type
	if (t === "string") return true
	if (!t && e.every((v) => typeof v === "string")) return true
	return false
}

function isIntEnum(schema: Record<string, unknown>): boolean {
	const e = schema.enum as unknown[] | undefined
	if (!e || e.length === 0) return false
	const t = schema.type
	if (t === "integer") return true
	if (!t && e.every((v) => typeof v === "number" && Number.isInteger(v))) return true
	return false
}

/** Strip null variant from anyOf/oneOf; returns remaining schemas. */
function stripNullVariants(schema: Record<string, unknown>): Record<string, unknown>[] | null {
	const variants = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined
	if (!variants) return null
	return variants.filter((v) => v.type !== "null")
}

/** Strip "null" from a type array, returning the first non-null type string. */
function stripNullFromTypeArray(schema: Record<string, unknown>): Record<string, unknown> {
	const t = schema.type as string[]
	const nonNull = t.filter((v) => v !== "null")
	return { ...schema, type: nonNull.length === 1 ? nonNull[0] : nonNull }
}

export function schemaToIR(schema: Record<string, unknown> | undefined): IRSchema {
	if (!schema) return { kind: "unknown" }

	if (typeof schema.$ref === "string") {
		const parts = schema.$ref.split("/")
		const name = parts[parts.length - 1] ?? schema.$ref
		return { kind: "ref", name }
	}

	if (Array.isArray(schema.allOf)) {
		const parts = (schema.allOf as Record<string, unknown>[]).map(schemaToIR)
		return { kind: "allOf", parts }
	}

	/* const precedes type inference */
	if (schema.const !== undefined) {
		const v = schema.const
		if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
			return { kind: "const", value: v }
		}
	}

	if (isNullableSchema(schema)) {
		let inner: IRSchema

		if (Array.isArray(schema.type) && (schema.type as unknown[]).includes("null")) {
			inner = schemaToIR(stripNullFromTypeArray(schema))
		} else if (schema.anyOf || schema.oneOf) {
			const remaining = stripNullVariants(schema) ?? []
			if (remaining.length === 0) {
				inner = { kind: "unknown" }
			} else if (remaining.length === 1) {
				inner = schemaToIR(remaining[0])
			} else {
				inner = { kind: "union", variants: remaining.map(schemaToIR) }
			}
		} else {
			/* nullable: true on a plain schema — strip the flag and recurse */
			const { nullable: _n, ...rest } = schema
			inner = schemaToIR(rest as Record<string, unknown>)
		}

		/* idempotent: never double-wrap */
		if (inner.kind === "nullable") return inner
		return { inner, kind: "nullable" }
	}

	/* multi-type array without null — nullable path already handled null-containing arrays above */
	if (Array.isArray(schema.type) && (schema.type as string[]).length > 1) {
		const types = schema.type as string[]
		const variants: IRSchema[] = types.map((t) => schemaToIR({ ...schema, type: t }))
		if (variants.length === 1) return variants[0]
		return { kind: "union", variants }
	}

	if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf)) {
		const variants = ((schema.oneOf ?? schema.anyOf) as Record<string, unknown>[]).map(schemaToIR)
		const rawDisc = schema.discriminator as Record<string, unknown> | undefined
		if (rawDisc) {
			const propertyName = rawDisc.propertyName as string
			const rawMapping = rawDisc.mapping as Record<string, string> | undefined
			let mapping: Record<string, string> | undefined
			if (rawMapping) {
				mapping = {}
				for (const [k, v] of Object.entries(rawMapping)) {
					const parts = v.split("/")
					mapping[k] = parts[parts.length - 1]
				}
			}
			const discriminator: IRDiscriminator = { propertyName }
			if (mapping) discriminator.mapping = mapping
			return { discriminator, kind: "union", variants }
		}
		return { kind: "union", variants }
	}

	/* enum detection precedes type branching — {enum:[...]} can lack type */
	if (Array.isArray(schema.enum)) {
		const enumVals = schema.enum as (string | number | boolean)[]
		if (isStringEnum(schema)) return { enum: enumVals, kind: "scalar", type: "string" }
		if (isIntEnum(schema)) return { enum: enumVals, kind: "scalar", type: "integer" }
		/* mixed enum (string + number values) — emit as union of const literals */
		if (enumVals.length > 0 && enumVals.every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
			return { kind: "union", variants: enumVals.map((v) => ({ kind: "const" as const, value: v })) }
		}
	}

	if (schema.format === "binary" && (schema.type === "string" || schema.type === undefined)) {
		return { kind: "binary" }
	}

	if (schema.type === "array" || Array.isArray(schema.items)) {
		if (Array.isArray(schema.items)) {
			const items = (schema.items as Record<string, unknown>[]).map(schemaToIR)
			return { items, kind: "tuple" }
		}
		const items = schema.items ? schemaToIR(schema.items as Record<string, unknown>) : { kind: "unknown" as const }
		return { items, kind: "array" }
	}

	if (
		schema.type === "object" ||
		schema.properties !== undefined ||
		schema.additionalProperties !== undefined
	) {
		const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>
		const requiredKeys = new Set((schema.required as string[] | undefined) ?? [])
		const fields: IRField[] = Object.entries(props).map(([name, propSchema]) => {
			const field: IRField = {
				name,
				required: requiredKeys.has(name),
				schema: schemaToIR(propSchema),
			}
			if (typeof propSchema.description === "string") field.description = propSchema.description
			return field
		})

		let additional: IRSchema | false | undefined
		const ap = schema.additionalProperties
		if (ap === false) {
			additional = false
		} else if (ap === true) {
			additional = { kind: "unknown" }
		} else if (ap !== undefined) {
			additional = schemaToIR(ap as Record<string, unknown>)
		}

		const result: { kind: "object"; fields: IRField[]; additional?: IRSchema | false } = {
			fields,
			kind: "object",
		}
		if (additional !== undefined) result.additional = additional
		return result
	}

	const t = schema.type as string | undefined
	if (t === "string" || t === "integer" || t === "number" || t === "boolean" || t === "null") {
		const scalar: Extract<IRSchema, { kind: "scalar" }> = { kind: "scalar", type: t as IRScalarType }
		if (typeof schema.format === "string") scalar.format = schema.format
		if (Array.isArray(schema.enum)) scalar.enum = schema.enum as (string | number | boolean)[]
		return scalar
	}

	return { kind: "unknown" }
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const

/** Detect whether a multipart/form-data schema has at least one binary (file) property. */
function hasBinaryMultipartPart(mediaType: Record<string, unknown> | undefined): boolean {
	const schema = mediaType?.schema as Record<string, unknown> | undefined
	const props = schema?.properties as Record<string, Record<string, unknown>> | undefined
	if (!props) return false
	for (const prop of Object.values(props)) {
		if (prop.format === "binary") return true
		if (prop.type === "array") {
			const items = prop.items as Record<string, unknown> | undefined
			if (items?.format === "binary") return true
		}
	}
	return false
}

/** Normalise a multipart/form-data object schema into typed parts. */
function extractMultipartParts(
	mediaType: Record<string, unknown> | undefined,
): IRMultipartPart[] {
	const schema = mediaType?.schema as Record<string, unknown> | undefined
	const props = schema?.properties as Record<string, Record<string, unknown>> | undefined
	if (!props) return []
	const parts: IRMultipartPart[] = []
	for (const [name, propSchema] of Object.entries(props)) {
		const ir = schemaToIR(propSchema)
		const isBinary =
			ir.kind === "binary" || (ir.kind === "array" && ir.items.kind === "binary")
		parts.push({ name, schema: ir, type: isBinary ? "file" : "text" })
	}
	return parts
}

function buildOperation(
	id: string,
	method: string,
	path: string,
	op: Record<string, unknown>,
): IROperation {
	const upperMethod = method.toUpperCase()

	const declaredParams = (op.parameters as Record<string, unknown>[] | undefined) ?? []
	const pathParams: IRParam[] = []
	const queryParams: IRParam[] = []
	const headerParams: IRParam[] = []
	const declaredPathNames = new Set<string>()

	for (const p of declaredParams) {
		const pIn = p.in as string
		const pName = p.name as string
		const pSchema = p.schema ? schemaToIR(p.schema as Record<string, unknown>) : { kind: "scalar" as const, type: "string" as const }
		const param: IRParam = { name: pName, schema: pSchema }
		if (typeof p.description === "string") param.description = p.description
		if (pIn === "path") {
			pathParams.push(param)
			declaredPathNames.add(pName)
		} else if (pIn === "query") {
			queryParams.push(param)
		} else if (pIn === "header") {
			headerParams.push(param)
		}
		/* cookie params discarded per OpenAPI client convention */
	}

	/* back-fill path params absent from parameters[] but present in the URL template */
	for (const name of extractOpenApiPathParams(path)) {
		if (!declaredPathNames.has(name)) {
			pathParams.push({ name, schema: { kind: "scalar", type: "string" } })
		}
	}

	let body: IRBody | undefined
	const requestBody = op.requestBody as Record<string, unknown> | undefined
	if (requestBody) {
		const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
		const firstCt = content ? Object.keys(content)[0] : undefined
		if (firstCt && content) {
			const mediaType = content[firstCt]
			const required = requestBody.required === true

			if (firstCt === "application/octet-stream") {
				body = { contentType: "application/octet-stream", kind: "stream", required }
			} else if (firstCt === "multipart/form-data" && hasBinaryMultipartPart(mediaType)) {
				body = {
					contentType: "multipart/form-data",
					kind: "multipart",
					parts: extractMultipartParts(mediaType),
					required,
				}
			} else {
				const bodySchema = mediaType?.schema
					? schemaToIR(mediaType.schema as Record<string, unknown>)
					: { kind: "unknown" as const }
				body = { contentType: firstCt, kind: "raw", required, schema: bodySchema }
			}
		}
	}

	const responses: Record<string, IRResponse> = {}
	const extensions: IROperationExtensions = {}

	const rawResponses = op.responses as Record<string, Record<string, unknown>> | undefined
	if (rawResponses) {
		for (const [status, response] of Object.entries(rawResponses)) {
			const content = response.content as Record<string, Record<string, unknown>> | undefined
			if (!content || Object.keys(content).length === 0) {
				responses[status] = { status }
			} else {
				const firstCt = Object.keys(content)[0]
				/* SSE detected by response content-type, not a request extension */
				if (firstCt === "text/event-stream") extensions.sse = true
				const mediaType = content[firstCt]
				const respSchema = mediaType?.schema
					? schemaToIR(mediaType.schema as Record<string, unknown>)
					: undefined
				const resp: IRResponse = { contentType: firstCt, status }
				if (respSchema !== undefined) resp.schema = respSchema
				responses[status] = resp
			}
		}
	}

	if (op["x-websocket"] === true) extensions.websocket = true
	if (op["x-realtime"] === true) extensions.realtime = true
	if (op["x-deprecated"] === true) extensions.deprecated = true
	if (op["x-idempotency-key"] === true) extensions.idempotencyKey = true
	if (op["x-mcp"] === true) extensions.mcp = true
	if (Array.isArray(op["x-invalidate"])) extensions.invalidates = op["x-invalidate"] as string[]

	const operation: IROperation = {
		extensions,
		id,
		method: upperMethod,
		params: { header: headerParams, path: pathParams, query: queryParams },
		path,
		responses,
	}
	if (body) operation.body = body
	if (typeof op.description === "string") operation.description = op.description

	return operation
}

export function toIR(spec: OpenApiSpecInput): IR {
	/* schemas built from raw components BEFORE resolveRefs, which strips them */
	const schemas: Record<string, IRSchema> = {}
	for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
		schemas[name] = schemaToIR(schema)
	}

	const resolved = resolveRefs(spec)
	const operations: IROperation[] = []
	const seen = new Set<string>()

	for (const [path, pathItem] of Object.entries(resolved.paths)) {
		for (const method of HTTP_METHODS) {
			const op = pathItem[method] as Record<string, unknown> | undefined
			if (!op) continue
			const id = op.operationId as string | undefined
			if (!id) continue
			if (seen.has(id)) throw new Error(`Duplicate operationId: "${id}"`)
			seen.add(id)
			operations.push(buildOperation(id, method, path, op))
		}
	}

	const tree = buildResourceTree(operations)
	return { operations, schemas, tree }
}
