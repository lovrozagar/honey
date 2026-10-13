import type { OpenApiSpecInput } from "./codegen.ts"
import { cmpCodeUnit, pascalWords } from "./codegen-lang.ts"

export type IRScalarType = "string" | "number" | "integer" | "boolean" | "null"

export type IRSchema =
	| { kind: "scalar"; type: IRScalarType; format?: string; enum?: (string | number | boolean)[] }
	| {
			kind: "const"
			value: string | number | boolean
			/** the declared `type`, when the schema has one */ type?: IRScalarType
	  }
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
	/** Path params are always required. */
	required?: boolean
	/** A path param that may span segments (`x-honey-wildcard`). */
	wildcard?: true
	/** `schema.default` as declared. */
	default?: unknown
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
			/** The whole form object, for emitters that type the form as one value. */
			schema?: IRSchema
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
	summary?: string
	params: {
		path: IRParam[]
		query: IRParam[]
		header: IRParam[]
		/** Cookie params. Most SDKs leave them to per-call options; the TypeScript SDK types them. */
		cookie?: IRParam[]
	}
	/** The preferred request body: JSON first, then form, multipart, raw bytes. */
	body?: IRBody
	/** Every declared request body, one per content type, in the same preference order. */
	bodies?: IRBody[]
	responses: Record<string, IRResponse>
	extensions: IROperationExtensions
}

export type IRTreeEntry = { kind: "method"; op: IROperation } | { kind: "namespace"; ns: IRNamespace }

export type IRNamespace = {
	entries: Map<string, IRTreeEntry>
}

/** How a client authenticates: the header it sends and the prefix before the token. */
export type IRAuth = { headerName: string; prefix: string }

export type IRInfo = { title?: string; description?: string; version?: string }

export type IR = {
	operations: IROperation[]
	schemas: Record<string, IRSchema>
	/** `description` of each component schema that has one. */
	schemaDescriptions: Record<string, string>
	tree: IRNamespace
	auth: IRAuth
	info: IRInfo
}

export function methodsOf(ns: IRNamespace): Array<[string, IROperation]> {
	return [...ns.entries.entries()]
		.filter((e): e is [string, Extract<IRTreeEntry, { kind: "method" }>] => e[1].kind === "method")
		.map(([k, v]): [string, IROperation] => [k, v.op])
		.sort(([a], [b]) => cmpCodeUnit(a, b))
}

export function namespacesOf(ns: IRNamespace): Array<[string, IRNamespace]> {
	return [...ns.entries.entries()]
		.filter((e): e is [string, Extract<IRTreeEntry, { kind: "namespace" }>] => e[1].kind === "namespace")
		.map(([k, v]): [string, IRNamespace] => [k, v.ns])
		.sort(([a], [b]) => cmpCodeUnit(a, b))
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
			const out: Extract<IRSchema, { kind: "const" }> = { kind: "const", value: v }
			const t = schema.type
			if (t === "string" || t === "integer" || t === "number" || t === "boolean") out.type = t
			return out
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
		if (
			enumVals.length > 0 &&
			enumVals.every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")
		) {
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

	if (schema.type === "object" || schema.properties !== undefined || schema.additionalProperties !== undefined) {
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

export type IRPathSegment = { kind: "literal"; text: string } | { kind: "param"; name: string }

/** Splits an OpenAPI path template into literal and `{param}` pieces. Any text between braces is a name. */
export function parseOpenApiPath(path: string): IRPathSegment[] {
	const out: IRPathSegment[] = []
	const re = /\{([^{}]+)\}/g
	let last = 0
	let match: RegExpExecArray | null = re.exec(path)
	while (match !== null) {
		if (match.index > last) out.push({ kind: "literal", text: path.slice(last, match.index) })
		out.push({ kind: "param", name: match[1] })
		last = match.index + match[0].length
		match = re.exec(path)
	}
	if (last < path.length) out.push({ kind: "literal", text: path.slice(last) })
	return out
}

export function openApiPathParams(path: string): string[] {
	const names: string[] = []
	for (const seg of parseOpenApiPath(path)) {
		if (seg.kind === "param" && !names.includes(seg.name)) names.push(seg.name)
	}
	return names
}

type Components = Record<string, Record<string, unknown>>

/** Follows a component `$ref` on a parameter, request body or response object (not on schemas). */
function deref(value: unknown, components: Components, depth = 0): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined
	const obj = value as Record<string, unknown>
	if (typeof obj.$ref !== "string" || depth > 16) return obj
	const parts = obj.$ref.replace(/^#\//, "").split("/")
	if (parts[0] !== "components" || parts.length !== 3) return undefined
	const target = Object.hasOwn(components, parts[1]) ? components[parts[1]] : undefined
	const next = target && Object.hasOwn(target, parts[2]) ? target[parts[2]] : undefined
	return deref(next, components, depth + 1)
}

/** Resolves a top-level schema `$ref` against `components.schemas`, for shape checks only. */
function resolveSchemaShallow(
	schema: Record<string, unknown> | undefined,
	components: Components,
	depth = 0,
): Record<string, unknown> | undefined {
	if (!schema || typeof schema.$ref !== "string" || depth > 16) return schema
	const name = schema.$ref.split("/").pop() ?? ""
	const schemas = components.schemas ?? {}
	const next = Object.hasOwn(schemas, name) ? (schemas[name] as Record<string, unknown>) : undefined
	return resolveSchemaShallow(next, components, depth + 1)
}

/** Detect whether a multipart/form-data schema has at least one binary (file) property. */
function hasBinaryMultipartPart(schema: Record<string, unknown> | undefined, components: Components): boolean {
	const props = schema?.properties as Record<string, Record<string, unknown>> | undefined
	if (!props) return false
	for (const raw of Object.values(props)) {
		const prop = resolveSchemaShallow(raw, components)
		if (prop?.format === "binary") return true
		if (prop?.type === "array") {
			const items = resolveSchemaShallow(prop.items as Record<string, unknown> | undefined, components)
			if (items?.format === "binary") return true
		}
	}
	return false
}

/** Normalise a multipart/form-data object schema into typed parts. */
function extractMultipartParts(schema: Record<string, unknown> | undefined, components: Components): IRMultipartPart[] {
	const props = schema?.properties as Record<string, Record<string, unknown>> | undefined
	if (!props) return []
	const parts: IRMultipartPart[] = []
	for (const [name, propSchema] of Object.entries(props)) {
		const resolved = resolveSchemaShallow(propSchema, components)
		const resolvedItems =
			resolved?.type === "array"
				? resolveSchemaShallow(resolved.items as Record<string, unknown> | undefined, components)
				: undefined
		const isBinary = resolved?.format === "binary" || resolvedItems?.format === "binary"
		parts.push({ name, schema: schemaToIR(propSchema), type: isBinary ? "file" : "text" })
	}
	return parts
}

/* JSON first, then the structured kinds, then whatever the spec lists first. */
const BODY_PREFERENCE = [
	"application/json",
	"application/x-www-form-urlencoded",
	"multipart/form-data",
	"application/octet-stream",
]

function isJsonMediaType(ct: string): boolean {
	const essence = ct.split(";")[0]?.trim().toLowerCase() ?? ""
	return essence === "application/json" || essence.endsWith("+json")
}

function contentTypeRank(ct: string): number {
	const essence = ct.split(";")[0]?.trim().toLowerCase() ?? ""
	const i = BODY_PREFERENCE.indexOf(essence)
	if (i >= 0) return i
	return isJsonMediaType(ct) ? BODY_PREFERENCE.length : BODY_PREFERENCE.length + 1
}

/** Content types in preference order; ties keep the order the spec lists them in. */
function orderedContentTypes(content: Record<string, unknown>): string[] {
	return Object.keys(content)
		.map((ct, i) => ({ ct, i, rank: contentTypeRank(ct) }))
		.sort((a, b) => a.rank - b.rank || a.i - b.i)
		.map((x) => x.ct)
}

function preferredContentType(content: Record<string, unknown>): string | undefined {
	return orderedContentTypes(content)[0]
}

function bodyFor(
	ct: string,
	mediaType: Record<string, unknown> | undefined,
	required: boolean,
	components: Components,
): IRBody {
	const rawSchema = mediaType?.schema as Record<string, unknown> | undefined
	const essence = ct.split(";")[0]?.trim().toLowerCase()
	if (essence === "application/octet-stream") {
		return { contentType: "application/octet-stream", kind: "stream", required }
	}
	if (
		essence === "multipart/form-data" &&
		hasBinaryMultipartPart(resolveSchemaShallow(rawSchema, components), components)
	) {
		const body: IRBody = {
			contentType: "multipart/form-data",
			kind: "multipart",
			parts: extractMultipartParts(resolveSchemaShallow(rawSchema, components), components),
			required,
		}
		if (rawSchema) body.schema = schemaToIR(rawSchema)
		return body
	}
	const bodySchema = rawSchema ? schemaToIR(rawSchema) : { kind: "unknown" as const }
	return { contentType: ct, kind: "raw", required, schema: bodySchema }
}

function buildOperation(
	id: string,
	method: string,
	path: string,
	op: Record<string, unknown>,
	pathItem: Record<string, unknown>,
	components: Components,
): IROperation {
	const upperMethod = method.toUpperCase()

	/* path-item parameters apply to every operation unless the operation overrides (same name + in) */
	const opParams = ((op.parameters as unknown[] | undefined) ?? []).map((p) => deref(p, components))
	const itemParams = ((pathItem.parameters as unknown[] | undefined) ?? []).map((p) => deref(p, components))
	const declaredParams: Record<string, unknown>[] = []
	for (const p of opParams) if (p) declaredParams.push(p)
	for (const p of itemParams) {
		if (!p) continue
		if (!declaredParams.some((d) => d.name === p.name && d.in === p.in)) declaredParams.push(p)
	}

	const pathParams: IRParam[] = []
	const queryParams: IRParam[] = []
	const headerParams: IRParam[] = []
	const cookieParams: IRParam[] = []
	const templateNames = openApiPathParams(path)

	for (const p of declaredParams) {
		const pIn = p.in as string
		const pName = String(p.name)
		const pSchema = p.schema
			? schemaToIR(p.schema as Record<string, unknown>)
			: { kind: "scalar" as const, type: "string" as const }
		const param: IRParam = { name: pName, required: pIn === "path" || p.required === true, schema: pSchema }
		if (typeof p.description === "string") param.description = p.description
		if (p["x-honey-wildcard"] === true) param.wildcard = true
		const pDefault = (p.schema as Record<string, unknown> | undefined)?.default
		if (pDefault !== undefined) param.default = pDefault
		if (pIn === "path") {
			/* a declared path param missing from the template cannot be sent */
			if (templateNames.includes(pName)) pathParams.push(param)
		} else if (pIn === "query") {
			queryParams.push(param)
		} else if (pIn === "header") {
			headerParams.push(param)
		} else if (pIn === "cookie") {
			cookieParams.push(param)
		}
	}

	/* path params in template order; back-fill the ones absent from parameters[] */
	const orderedPath: IRParam[] = []
	for (const name of templateNames) {
		orderedPath.push(
			pathParams.find((p) => p.name === name) ?? { name, required: true, schema: { kind: "scalar", type: "string" } },
		)
	}

	let body: IRBody | undefined
	const bodies: IRBody[] = []
	const requestBody = deref(op.requestBody, components)
	if (requestBody) {
		const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
		const required = requestBody.required === true
		for (const ct of content ? orderedContentTypes(content) : []) {
			bodies.push(bodyFor(ct, content?.[ct], required, components))
		}
		body = bodies[0]
	}

	const responses: Record<string, IRResponse> = {}
	const extensions: IROperationExtensions = {}

	const rawResponses = op.responses as Record<string, unknown> | undefined
	if (rawResponses) {
		for (const [status, rawResponse] of Object.entries(rawResponses)) {
			const response = deref(rawResponse, components) ?? {}
			const content = response.content as Record<string, Record<string, unknown>> | undefined
			if (!content || Object.keys(content).length === 0) {
				responses[status] = { status }
				continue
			}
			/* SSE detected by response content-type, not a request extension */
			if (Object.keys(content).some((k) => k.split(";")[0]?.trim().toLowerCase() === "text/event-stream")) {
				extensions.sse = true
			}
			const ct = preferredContentType(content) ?? Object.keys(content)[0]
			const mediaType = content[ct]
			const respSchema = mediaType?.schema ? schemaToIR(mediaType.schema as Record<string, unknown>) : undefined
			const resp: IRResponse = { contentType: ct, status }
			if (respSchema !== undefined) resp.schema = respSchema
			responses[status] = resp
		}
	}

	if (op["x-websocket"] === true) extensions.websocket = true
	if (op["x-realtime"] === true) extensions.realtime = true
	if (op["x-deprecated"] === true || op.deprecated === true) extensions.deprecated = true
	if (op["x-idempotency-key"] === true) extensions.idempotencyKey = true
	if (op["x-mcp"] === true) extensions.mcp = true
	if (Array.isArray(op["x-invalidate"])) {
		extensions.invalidates = (op["x-invalidate"] as unknown[]).filter((x): x is string => typeof x === "string")
	}

	const operation: IROperation = {
		extensions,
		id,
		method: upperMethod,
		params: { header: headerParams, path: orderedPath, query: queryParams },
		path,
		responses,
	}
	if (cookieParams.length > 0) operation.params.cookie = cookieParams
	if (body) operation.body = body
	if (bodies.length > 1) operation.bodies = bodies
	if (typeof op.description === "string") operation.description = op.description
	if (typeof op.summary === "string") operation.summary = op.summary

	return operation
}

/** Deterministic id for an operation without an `operationId`: `GET /users/{id}` → `getUsersById`. */
export function deriveOperationId(method: string, path: string): string {
	const literal: string[] = []
	const params: string[] = []
	for (const seg of parseOpenApiPath(path)) {
		if (seg.kind === "param") params.push(pascalWords(seg.name))
		else literal.push(pascalWords(seg.text))
	}
	const base = `${method.toLowerCase()}${literal.join("")}${params.length > 0 ? `By${params.join("And")}` : ""}`
	return base === method.toLowerCase() ? `${base}Root` : base
}

export type ToIROptions = {
	/** Give operations without an `operationId` a derived one instead of dropping them, and disambiguate
	 * a shared `operationId` by method. The non-TypeScript SDK emitters use this. */
	deriveOperationIds?: boolean
	/** A shared `operationId`: `"suffix"` disambiguates by method (default with `deriveOperationIds`),
	 * `"throw"` refuses the document (default otherwise; the TypeScript SDK always refuses). */
	duplicateOperationIds?: "suffix" | "throw"
}

export function toIR(spec: OpenApiSpecInput, options: ToIROptions = {}): IR {
	const schemas: Record<string, IRSchema> = {}
	for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
		schemas[name] = schemaToIR(schema)
	}

	const components = (spec.components ?? {}) as Components
	const operations: IROperation[] = []
	const seen = new Set<string>()
	const pending: Array<{
		method: string
		op: Record<string, unknown>
		path: string
		pathItem: Record<string, unknown>
	}> = []

	for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
		for (const method of HTTP_METHODS) {
			const op = (pathItem as Record<string, unknown>)[method] as Record<string, unknown> | undefined
			if (!op) continue
			const id = op.operationId as string | undefined
			if (!id) {
				if (options.deriveOperationIds)
					pending.push({ method, op, path, pathItem: pathItem as Record<string, unknown> })
				continue
			}
			let finalId = id
			if (seen.has(id)) {
				const onDuplicate = options.duplicateOperationIds ?? (options.deriveOperationIds ? "suffix" : "throw")
				if (onDuplicate === "throw") throw new Error(`Duplicate operationId: "${id}"`)
				finalId = `${id}${pascalWords(method)}`
				for (let i = 2; seen.has(finalId); i++) finalId = `${id}${pascalWords(method)}${i}`
			}
			seen.add(finalId)
			operations.push(buildOperation(finalId, method, path, op, pathItem as Record<string, unknown>, components))
		}
	}

	/* derived ids after explicit ones, so an explicit id always keeps its name */
	const namespaceRoots = new Set(operations.map((o) => o.id.split(".")[0] ?? o.id))
	for (const { method, op, path, pathItem } of pending) {
		const base = deriveOperationId(method, path)
		let id = base
		for (let i = 2; seen.has(id) || namespaceRoots.has(id); i++) id = `${base}${i}`
		seen.add(id)
		operations.push(buildOperation(id, method, path, op, pathItem, components))
	}

	const tree = buildResourceTree(operations)
	const schemaDescriptions: Record<string, string> = {}
	for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
		if (typeof schema.description === "string") schemaDescriptions[name] = schema.description
	}
	return { auth: specAuth(spec), info: infoOf(spec), operations, schemaDescriptions, schemas, tree }
}

/**
 * The first security scheme (code-unit order) decides the header: http basic → `Basic `, other
 * http → `Bearer `, a header apiKey → its name, with a prefix when its description says
 * `Format: <prefix> {token}`. Anything else, or no scheme, is `Authorization: Bearer`.
 */
export function specAuth(spec: OpenApiSpecInput): IRAuth {
	const components = (spec.components ?? {}) as Record<string, unknown>
	const schemes = (components.securitySchemes ?? {}) as Record<string, Record<string, unknown>>
	const keys = Object.keys(schemes).sort(cmpCodeUnit)
	const fallback = { headerName: "Authorization", prefix: "Bearer " }
	const scheme = keys.length > 0 ? schemes[keys[0]] : undefined
	if (!scheme) return fallback
	const type = String(scheme.type ?? "")
	if (type === "http") {
		const httpScheme = String(scheme.scheme ?? "").toLowerCase()
		return { headerName: "Authorization", prefix: httpScheme === "basic" ? "Basic " : "Bearer " }
	}
	if (type === "apiKey" && scheme.in === "header") {
		const headerName = String(scheme.name ?? "Authorization")
		const match = /Format:\s*(\S+)\s+\{/i.exec(String(scheme.description ?? ""))
		return { headerName, prefix: match ? `${match[1]} ` : "" }
	}
	return fallback
}

function infoOf(spec: OpenApiSpecInput): IRInfo {
	const info = ((spec as { info?: unknown }).info ?? {}) as Record<string, unknown>
	const out: IRInfo = {}
	for (const key of ["title", "description", "version"] as const) {
		if (typeof info[key] === "string") out[key] = info[key] as string
	}
	return out
}

/** Every request body an operation declares, preferred first. */
export function bodiesOf(op: IROperation): IRBody[] {
	return op.bodies ?? (op.body ? [op.body] : [])
}

/** Follows `ref` nodes to their component schema; an unknown ref resolves to `unknown`. */
export function irResolver(schemas: Record<string, IRSchema>): (schema: IRSchema) => IRSchema {
	return (schema) => {
		let cur = schema
		for (let i = 0; i < 32 && cur.kind === "ref"; i++) {
			const next = Object.hasOwn(schemas, cur.name) ? schemas[cur.name] : undefined
			if (!next) return { kind: "unknown" }
			cur = next
		}
		return cur
	}
}

function isStringSchema(s: IRSchema | undefined): boolean {
	return s?.kind === "scalar" && s.type === "string"
}

/**
 * Honey's standard error envelope (`success: false`, `error_key` enum, one `status`), read from the IR.
 * Returns its error keys and status, or null for any other shape.
 */
export function irErrorEnvelope(
	schema: IRSchema,
	resolve: (schema: IRSchema) => IRSchema,
): { keys: string[]; status: number } | null {
	const obj = resolve(schema)
	if (obj.kind !== "object") return null
	const field = (o: Extract<IRSchema, { kind: "object" }>, name: string): IRSchema | undefined => {
		const f = o.fields.find((x) => x.name === name)
		return f ? resolve(f.schema) : undefined
	}

	const success = field(obj, "success")
	if (success?.kind !== "const" || success.value !== false) return null
	if (!isStringSchema(field(obj, "message")) || !isStringSchema(field(obj, "status_key"))) return null

	const fields = field(obj, "fields")
	if (fields?.kind !== "object" || !fields.additional) return null
	const list = resolve(fields.additional)
	if (list.kind !== "array") return null
	const item = resolve(list.items)
	if (item.kind !== "object") return null
	for (const k of ["error_key", "message", "path"]) if (!isStringSchema(field(item, k))) return null

	const status = field(obj, "status")
	if (status?.kind !== "scalar" || !status.enum || status.enum.length !== 1) return null
	const statusVal = status.enum[0]
	if (typeof statusVal !== "number") return null

	const key = field(obj, "error_key")
	if (key?.kind !== "scalar" || !key.enum || key.enum.length === 0) return null
	if (!key.enum.every((k) => typeof k === "string")) return null
	return { keys: key.enum as string[], status: statusVal }
}
