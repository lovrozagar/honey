import { InternPool } from "./codegen-route-tree-intern.ts"
import {
	deriveErrorEnvelopeName,
	deriveSchemaName,
	isErrorEnvelope,
	sanitizeComponentName,
	shortHash,
} from "./codegen-schema-naming.ts"
import type { SchemaNameContext } from "./codegen-schema-naming.ts"
import { effectJsonSchemaFn, loadEffectJsonSchema, loadToJSONSchema, toJSONSchemaFn } from "./codegen-loaders.ts"
import { sanitizeZodJsonSchema } from "./codegen-sanitize.ts"
import {
	bodiesOf,
	irErrorEnvelope,
	irResolver,
	methodsOf,
	namespacesOf,
	openApiPathParams,
	schemaToIR,
	toIR,
} from "./codegen-ir.ts"
import type { IR, IRBody, IRNamespace, IROperation, IRSchema } from "./codegen-ir.ts"
import { isJsonMedia, isTextMedia, mediaEssence } from "./codegen-sdk-model.ts"
import type { HoneyError } from "./error.ts"
import { ERROR_META } from "./errors.ts"
import type { ErrorMetaEntry } from "./errors.ts"
import type { InvalidateCheckConfig } from "./invalidate-check.ts"
import { publishableMetaKeys } from "./meta-spec.ts"
import { metaSpecOf } from "./meta-spec-merge.ts"
import type { Honey } from "./index.ts"
import {
	generateOpenApiFromTree,
	type OpenApiInfo,
	type OpenApiRouteInfo,
	type OpenApiSpec,
} from "./openapi/document.ts"
import { getJsonSchemaConverter, setJsonSchemaConverter } from "./openapi/json-schema-slot.ts"
import { collectRoutes, extractParams } from "./openapi/collect.ts"
import { parsePattern, patternParams } from "./pattern.ts"
import type { RouteHandler, RouteTree } from "./tree.ts"
import { forEachLeaf, ROUTE_TREE_VERSION } from "./tree.ts"
import { irToTs } from "./ts-type-emitter.ts"
import { createTypeEmitState, emitSchemaType, quoteKey } from "./type-emitter.ts"
import type { TypeEmitState } from "./type-emitter.ts"
import type { InputSchemaEntry, InputSchemasDef, MetaSpecConfig, OutputSchemaDef, StandardSchemaLike } from "./types.ts"
import { EMPTY_OBJ, statusKeyToCode } from "./types.ts"
import { CROSS_ORIGIN_SAFE_HEADERS } from "./client/redirect-policy.ts"

export { prepareCodegen } from "./codegen-loaders.ts"
export type { InvalidateCheckConfig, InvalidateCheckLevel } from "./invalidate-check.ts"
export { toYaml, yamlSiblingPath } from "./yaml.ts"
export { DEFAULT_ERROR_JSON_SCHEMA } from "./openapi/document.ts"
export type { OpenApiInfo, OpenApiRouteInfo, OpenApiSpec }

/* Status → typed error subclass. Single source of truth shared between the
 * emitted client (class declarations + status map + footer re-exports) and
 * the index.gen.ts import/export. Order is deterministic for stable output. */
const STATUS_ERROR_CLASSES: ReadonlyArray<{ name: string; status: number }> = [
	{ name: "BadRequestError", status: 400 },
	{ name: "UnauthorizedError", status: 401 },
	{ name: "ForbiddenError", status: 403 },
	{ name: "NotFoundError", status: 404 },
	{ name: "ConflictError", status: 409 },
	{ name: "UnprocessableEntityError", status: 422 },
	{ name: "RateLimitError", status: 429 },
	{ name: "InternalServerError", status: 500 },
	{ name: "BadGatewayError", status: 502 },
	{ name: "ServiceUnavailableError", status: 503 },
	{ name: "GatewayTimeoutError", status: 504 },
]

const ERROR_EXPORT_NAMES: ReadonlyArray<string> = [
	"ClientError",
	...STATUS_ERROR_CLASSES.map((c) => c.name),
	"isClientError",
]

/* ---- Valibot → JSON Schema converter ---- */

type ValibotSchema = Record<string, unknown> & { type: string }

/** Wrappers that make an object entry optional. */
const VALIBOT_OPTIONAL = new Set(["exact_optional", "nullish", "optional", "undefinedable"])

/** Pipe actions with a JSON Schema equivalent. Anything else constrains nothing in the document. */
function applyValibotPipe(schema: ValibotSchema, json: Record<string, unknown>): Record<string, unknown> {
	const pipe = schema.pipe as Array<Record<string, unknown>> | undefined
	if (!Array.isArray(pipe)) return json
	const formats: Record<string, string> = {
		email: "email",
		ipv4: "ipv4",
		ipv6: "ipv6",
		iso_date: "date",
		iso_date_time: "date-time",
		iso_timestamp: "date-time",
		url: "uri",
		uuid: "uuid",
	}
	for (const action of pipe.slice(1)) {
		const type = action.type as string
		const req = action.requirement
		if (type in formats) json.format = formats[type]
		else if (type === "integer") json.type = "integer"
		else if (type === "regex" && req instanceof RegExp) json.pattern = req.source
		else if (type === "min_length" && typeof req === "number")
			json[json.type === "array" ? "minItems" : "minLength"] = req
		else if (type === "max_length" && typeof req === "number")
			json[json.type === "array" ? "maxItems" : "maxLength"] = req
		else if (type === "length" && typeof req === "number") {
			json[json.type === "array" ? "minItems" : "minLength"] = req
			json[json.type === "array" ? "maxItems" : "maxLength"] = req
		} else if (type === "min_value" && typeof req === "number") json.minimum = req
		else if (type === "max_value" && typeof req === "number") json.maximum = req
		else if (type === "description" && typeof action.description === "string") json.description = action.description
	}
	return json
}

function valibotObject(s: ValibotSchema, depth: number): Record<string, unknown> {
	const entries = s.entries as Record<string, ValibotSchema>
	if (Object.keys(entries).length === 0 && s.type === "object") return { type: "object" }
	const properties: Record<string, unknown> = {}
	const required: string[] = []
	for (const k of Object.keys(entries)) {
		const entry = entries[k]
		properties[k] = valibotToJsonSchema(entry, depth + 1)
		if (!VALIBOT_OPTIONAL.has(entry.type)) required.push(k)
	}
	const result: Record<string, unknown> = { properties, type: "object" }
	if (required.length > 0) result.required = required
	if (s.type === "strict_object") result.additionalProperties = false
	else if (s.type === "object_with_rest") result.additionalProperties = valibotToJsonSchema(s.rest, depth + 1)
	return result
}

function valibotToJsonSchema(schema: unknown, depth = 0): unknown {
	/* a lazy schema can recurse without end; past this depth the node is unconstrained */
	if (depth > 32) return {}
	const s = schema as ValibotSchema
	const walk = (child: unknown): unknown => valibotToJsonSchema(child, depth + 1)

	switch (s.type) {
		case "string":
			return applyValibotPipe(s, { type: "string" })
		case "number":
			return applyValibotPipe(s, { type: "number" })
		case "boolean":
			return { type: "boolean" }
		case "bigint":
			return { format: "int64", type: "integer" }
		case "date":
			return { format: "date-time", type: "string" }
		case "file":
		case "blob":
			return { contentEncoding: "binary", format: "binary", type: "string" }
		case "undefined":
		case "void":
			return {}
		case "null":
			return { type: "null" }
		case "any":
		case "unknown":
			return {}
		case "literal":
			return { const: s.literal }
		case "object":
		case "strict_object":
		case "loose_object":
		case "object_with_rest":
			return valibotObject(s, depth)
		case "array":
			return applyValibotPipe(s, { items: walk(s.item), type: "array" })
		case "optional":
		case "exact_optional":
		case "undefinedable":
		case "non_nullable":
		case "non_nullish":
		case "non_optional": {
			const inner = walk(s.wrapped) as Record<string, unknown>
			const fallback = s.default
			return fallback === undefined || typeof fallback === "function" ? inner : { ...inner, default: fallback }
		}
		case "nullable":
		case "nullish":
			return { anyOf: [walk(s.wrapped), { type: "null" }] }
		case "union":
		case "variant":
			return { anyOf: (s.options as unknown[]).map(walk) }
		case "intersect":
			return { allOf: (s.options as unknown[]).map(walk) }
		case "picklist":
			return { enum: s.options }
		case "enum": {
			const enumObj = s.enum as Record<string, string | number>
			/* a TS numeric enum carries reverse mappings — keep the values */
			return {
				enum: Object.keys(enumObj)
					.filter((k) => typeof enumObj[enumObj[k] as string] !== "number")
					.map((k) => enumObj[k]),
			}
		}
		case "record":
			return { additionalProperties: walk(s.value), type: "object" }
		case "tuple":
		case "strict_tuple":
		case "loose_tuple":
		case "tuple_with_rest": {
			const items = (s.items as unknown[]).map(walk)
			const result: Record<string, unknown> = { minItems: items.length, prefixItems: items, type: "array" }
			if (s.type === "tuple_with_rest") result.items = walk(s.rest)
			else if (s.type !== "loose_tuple") {
				result.items = false
				result.maxItems = items.length
			}
			return result
		}
		case "lazy": {
			const getter = s.getter as ((input: unknown) => unknown) | undefined
			return typeof getter === "function" ? walk(getter(undefined)) : {}
		}
		default:
			return {}
	}
}

/* ---- ArkType → JSON Schema converter ---- */

function arkTypeToJsonSchema(schema: unknown): unknown {
	const s = schema as Record<string, unknown>
	if (typeof s.toJsonSchema === "function") {
		try {
			return s.toJsonSchema()
		} catch {
			/* fall through */
		}
	}
	return {}
}

/* ---- Yup → JSON Schema converter ---- */

type YupJsonDesc = {
	fields?: Record<string, YupJsonDesc>
	innerType?: YupJsonDesc | YupJsonDesc[]
	nullable?: boolean
	oneOf?: unknown[]
	optional?: boolean
	type: string
}

function yupToJsonSchema(schema: unknown): unknown {
	const s = schema as Record<string, unknown>
	if (typeof s.describe !== "function") return {}
	const desc = s.describe() as YupJsonDesc
	return yupDescToJsonSchema(desc)
}

function yupDescToJsonSchema(desc: YupJsonDesc): unknown {
	const base = yupDescBase(desc)
	if (desc.nullable) {
		return { anyOf: [base, { type: "null" }] }
	}
	return base
}

function yupDescBase(desc: YupJsonDesc): unknown {
	switch (desc.type) {
		case "string":
			return { type: "string" }
		case "number":
			return { type: "number" }
		case "boolean":
			return { type: "boolean" }
		case "date":
			return { format: "date-time", type: "string" }
		case "object": {
			if (!desc.fields) return { type: "object" }
			const keys = Object.keys(desc.fields)
			if (keys.length === 0) return { type: "object" }
			const properties: Record<string, unknown> = {}
			const required: string[] = []
			for (const k of keys) {
				const field = desc.fields[k]
				properties[k] = yupDescToJsonSchema(field)
				if (!field.optional) required.push(k)
			}
			const result: Record<string, unknown> = { properties, type: "object" }
			if (required.length > 0) result.required = required
			return result
		}
		case "array": {
			if (!desc.innerType || Array.isArray(desc.innerType)) return { type: "array" }
			return { items: yupDescToJsonSchema(desc.innerType), type: "array" }
		}
		case "tuple": {
			if (!Array.isArray(desc.innerType)) return { type: "array" }
			const items = desc.innerType.map((i) => yupDescToJsonSchema(i))
			return {
				items: false,
				maxItems: items.length,
				minItems: items.length,
				prefixItems: items,
				type: "array",
			}
		}
		case "mixed": {
			if (desc.oneOf && desc.oneOf.length > 0) return { enum: desc.oneOf }
			return {}
		}
		default:
			return {}
	}
}

/* ---- Effect → JSON Schema converter ---- */

function effectToJsonSchema(schema: unknown): unknown {
	if (effectJsonSchemaFn) {
		try {
			return effectJsonSchemaFn(schema)
		} catch {
			/* fall through */
		}
	}
	return {}
}

type ErrorEntry = {
	errorKey: string
	status: number
	statusKey: string
}

type RouteManifestEntry = {
	errors: string[]
	input?: Record<string, unknown>
	meta: Record<string, unknown>
	method: string
	middleware: string[]
	output?: Record<string, unknown>
	params: string[]
	path: string
}

type RouteManifest = {
	errors: ErrorEntry[]
	routes: RouteManifestEntry[]
}

type CollectedRoute = {
	handler: RouteHandler
	method: string
	path: string
}

function isMetaInternal(handler: RouteHandler): boolean {
	return (handler.mt as { internal?: boolean } | null)?.internal === true
}

type ErrorInfo = { errorKey: string; status: number; statusKey: string }

/* Longest suffix first so `*_not_found` wins over `*_found` (302). */
const STATUS_KEYS_BY_LENGTH = (Object.keys(statusKeyToCode) as Array<keyof typeof statusKeyToCode>).sort(
	(a, b) => b.length - a.length,
)

/*
 * Composed apps keep declared keys on the handler but may not carry the worker
 * factory. Infer HTTP status from a trailing status-key suffix so the document
 * still lists what `c.errors.<key>` actually writes.
 */
function inferErrorInfo(errorKey: string): ErrorInfo | null {
	const exact = statusKeyToCode[errorKey as keyof typeof statusKeyToCode]
	if (exact !== undefined) {
		if (exact < 400) return null
		return { errorKey, status: exact, statusKey: errorKey }
	}
	for (const statusKey of STATUS_KEYS_BY_LENGTH) {
		if (!errorKey.endsWith(`_${statusKey}`)) continue
		const status = statusKeyToCode[statusKey]
		if (status < 400) continue
		return { errorKey, status, statusKey }
	}
	return null
}

function resolveErrorInfo(errorKey: string, factory: Record<string, () => HoneyError> | null): ErrorInfo {
	if (factory?.[errorKey]) {
		try {
			const err = factory[errorKey]()
			return { errorKey, status: err.status, statusKey: err.statusKey }
		} catch {
			/* factory call failed — fall through to suffix inference */
		}
	}
	return inferErrorInfo(errorKey) ?? { errorKey, status: 0, statusKey: "unknown" }
}

function getErrorFactory<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
): Record<string, () => HoneyError> | null {
	return (app as unknown as { _errorFactory: Record<string, () => HoneyError> | null })._errorFactory
}

function getErrorMeta(factory: Record<string, () => HoneyError> | null): Record<string, ErrorMetaEntry> | null {
	if (!factory) return null
	return (factory as Record<symbol, Record<string, ErrorMetaEntry>>)[ERROR_META] ?? null
}

function unwrapEntry(entry: InputSchemaEntry): StandardSchemaLike {
	if ("_tag" in entry) {
		return entry.schema as StandardSchemaLike
	}
	return entry
}

function introspectSchema(schema: StandardSchemaLike): unknown {
	const std = schema["~standard"]
	return {
		types: std.types,
		vendor: std.vendor,
		version: std.version,
	}
}

export { normalizeSecurity } from "./meta-spec.ts"

/** Locale-independent string order (UTF-16 code units), so output is the same on every machine. */
export function compareCodeUnits(a: string, b: string): number {
	if (a === b) return 0
	return a < b ? -1 : 1
}

export function canonicalizeSchema(schema: Record<string, unknown>): string {
	return JSON.stringify(schema, (_, value) => {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).sort(([a], [b]) => compareCodeUnits(a, b)),
			)
		}
		return value
	})
}

type SchemaSlot = {
	canonical: string
	contentType: string
	context: SchemaNameContext
	/* path key from the spec — used for context-based ref rewriting */
	pathKey: string
	schema: Record<string, unknown>
}

function isObjectSchema(schema: unknown): schema is Record<string, unknown> {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false
	const s = schema as Record<string, unknown>
	if (typeof s.$ref === "string") return false
	return s.type === "object" || (typeof s.properties === "object" && s.properties !== null)
}

/**
 * A response key as a number: `"200"` → 200, `"default"` → 0, `"4XX"` → 400. Never `NaN`, which
 * would name a schema `…ResponseNaN` and make every `default` response collide.
 */
function statusNumber(key: string): number {
	if (/^[1-5][0-9][0-9]$/.test(key)) return Number(key)
	if (/^[1-5]XX$/i.test(key)) return Number(key[0]) * 100
	return 0
}

function collectSchemaSlots(paths: Record<string, Record<string, Record<string, unknown>>>): SchemaSlot[] {
	const slots: SchemaSlot[] = []

	for (const [pathKey, methods] of Object.entries(paths)) {
		for (const [method, operation] of Object.entries(methods)) {
			const op = operation as Record<string, unknown>
			const m = method.toLowerCase()

			const requestBody = op.requestBody as Record<string, unknown> | undefined
			if (requestBody) {
				const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
				if (content) {
					for (const [contentType, mediaType] of Object.entries(content)) {
						const schema = mediaType.schema as Record<string, unknown> | undefined
						if (schema && !schema.$ref) {
							const context: SchemaNameContext = { method: m, path: pathKey, role: "request" }
							slots.push({ canonical: canonicalizeSchema(schema), contentType, context, pathKey, schema })
						}
					}
				}
			}

			const responses = op.responses as Record<string, Record<string, unknown>> | undefined
			if (responses) {
				for (const [status, response] of Object.entries(responses)) {
					const content = (response as Record<string, unknown>).content as
						| Record<string, Record<string, unknown>>
						| undefined
					if (content) {
						for (const [contentType, mediaType] of Object.entries(content)) {
							const schema = mediaType.schema as Record<string, unknown> | undefined
							if (schema && !schema.$ref) {
								const statusNum = statusNumber(status)
								const context: SchemaNameContext = {
									method: m,
									path: pathKey,
									role: "response",
									status: statusNum,
								}
								slots.push({ canonical: canonicalizeSchema(schema), contentType, context, pathKey, schema })
							}
						}
					}
				}
			}
		}
	}

	return slots
}

/*
 * Detects inline object properties shared across 2+ top-level slots, registers
 * them as named components, and returns a canonical → name map so that
 * rewritePathsToRefs can replace inline nested objects with $refs.
 */

type NestedSample = { fieldPath: string[]; isEnvelopeOwner: boolean; slotName: string }
type NestedEntry = { count: number; samples: NestedSample[]; schema: Record<string, unknown> }

type HoistedResult = {
	canonicalToName: Map<string, string>
	schemas: Record<string, Record<string, unknown>>
}

/**
 * A component name nobody holds yet. A clash gets the content hash, and a clash on the
 * hashed name (24 bits collide) a counter — a name is never handed out twice.
 */
function uniqueName(base: string, canonical: string, taken: (name: string) => boolean): string {
	if (!taken(base)) return base
	const hashed = `${base}_${shortHash(canonical)}`
	if (!taken(hashed)) return hashed
	for (let n = 2; ; n++) {
		const candidate = `${hashed}_${n}`
		if (!taken(candidate)) return candidate
	}
}

function walkNestedObjects(
	schema: Record<string, unknown>,
	slotName: string,
	fieldPath: string[],
	nestedMap: Map<string, NestedEntry>,
	isEnvelopeOwner: boolean,
): void {
	const props = schema.properties as Record<string, unknown> | undefined
	if (!props) return
	for (const key of Object.keys(props)) {
		const val = props[key]
		if (!isObjectSchema(val)) continue
		const child = val as Record<string, unknown>
		const childPath = [...fieldPath, key]
		const canonical = canonicalizeSchema(child)
		const existing = nestedMap.get(canonical)
		if (existing) {
			existing.count++
			existing.samples.push({ fieldPath: childPath, isEnvelopeOwner, slotName })
		} else {
			nestedMap.set(canonical, {
				count: 1,
				samples: [{ fieldPath: childPath, isEnvelopeOwner, slotName }],
				schema: child,
			})
		}
		walkNestedObjects(child, slotName, childPath, nestedMap, isEnvelopeOwner)
	}
}

function collectHoistedSchemas(
	slots: SchemaSlot[],
	slotNames: Map<SchemaSlot, string>,
	taken: (name: string) => boolean,
): HoistedResult {
	const nestedMap = new Map<string, NestedEntry>()
	for (const slot of slots) {
		const slotName = slotNames.get(slot)
		/* Mark slots whose schema is an error envelope — their nested objects (e.g. `fields`)
		 * are env-specific and must not be named after the parent envelope's owner slot. */
		if (slotName) walkNestedObjects(slot.schema, slotName, [], nestedMap, isErrorEnvelope(slot.schema))
	}

	const schemas: Record<string, Record<string, unknown>> = {}
	const canonicalToName = new Map<string, string>()

	for (const [canonical, entry] of nestedMap) {
		if (entry.count < 2) continue

		/* Skip hoisting nested objects that live exclusively inside Tier 2 error envelopes.
		 * Their names would be derived from whichever envelope "wins" the lex sort, and that
		 * winner differs per-spec — causing merge conflicts when multiple specs are combined. */
		if (entry.samples.every((s) => s.isEnvelopeOwner)) continue

		const owner = entry.samples.slice().sort((a, b) => {
			const na = a.slotName + a.fieldPath.join("")
			const nb = b.slotName + b.fieldPath.join("")
			return compareCodeUnits(na, nb)
		})[0]

		const fieldPart = owner.fieldPath
			.map((f) => sanitizeComponentName(f))
			.map((f) => f.charAt(0).toUpperCase() + f.slice(1))
			.join("")
		const name = uniqueName(
			sanitizeComponentName(`${owner.slotName}${fieldPart}`),
			canonical,
			(n) => taken(n) || Object.hasOwn(schemas, n),
		)
		schemas[name] = entry.schema
		canonicalToName.set(canonical, name)
	}

	/* nested hoists inside a hoisted schema point at their component too */
	for (const name of Object.keys(schemas)) schemas[name] = rewriteNestedRefs(schemas[name], canonicalToName)

	return { canonicalToName, schemas }
}

/*
 * Builds a new paths object by shallow-copying only the containers that need schema
 * replacement. Avoids structuredClone (which fails on arktype schemas containing
 * native functions). Original schema objects are dropped; only $ref objects are new.
 * Also rewrites nested inline object properties that were hoisted (canonicalToName),
 * at any depth — a hoisted name nothing points at would be an orphan component.
 */

function rewriteNestedRefs(
	schema: Record<string, unknown>,
	canonicalToName: Map<string, string>,
): Record<string, unknown> {
	const props = schema.properties as Record<string, unknown> | undefined
	if (!props) return schema
	let newProps: Record<string, unknown> | undefined
	for (const key of Object.keys(props)) {
		const val = props[key]
		if (!isObjectSchema(val)) continue
		const child = val as Record<string, unknown>
		const name = canonicalToName.get(canonicalizeSchema(child))
		const next = name ? { $ref: `#/components/schemas/${name}` } : rewriteNestedRefs(child, canonicalToName)
		if (next === child) continue
		if (!newProps) newProps = { ...props }
		newProps[key] = next
	}
	if (!newProps) return schema
	return { ...schema, properties: newProps }
}

function slotKey(
	pathKey: string,
	method: string,
	role: string,
	status: number | undefined,
	contentType: string,
): string {
	return `${pathKey}::${method}::${role}::${status ?? ""}::${contentType}`
}

function rewritePathsToRefs(
	paths: Record<string, Record<string, Record<string, unknown>>>,
	slots: SchemaSlot[],
	slotNames: Map<SchemaSlot, string>,
	hoistedCanonicalToName: Map<string, string>,
): Record<string, Record<string, Record<string, unknown>>> {
	/* keyed by operation + status + content type: JSON and XML bodies of one status are two slots */
	const lookup = new Map<string, string>()
	for (const slot of slots) {
		const name = slotNames.get(slot)
		if (!name) continue
		const status = slot.context.role === "response" ? slot.context.status : undefined
		lookup.set(slotKey(slot.pathKey, slot.context.method, slot.context.role, status, slot.contentType), name)
	}

	const rewriteContent = (
		content: Record<string, Record<string, unknown>>,
		keyFor: (ct: string) => string,
	): Record<string, Record<string, unknown>> | null => {
		const newContent: Record<string, Record<string, unknown>> = {}
		let changed = false
		for (const [ct, mediaType] of Object.entries(content)) {
			const schema = mediaType.schema as Record<string, unknown> | undefined
			if (!schema || schema.$ref) {
				newContent[ct] = mediaType
				continue
			}
			const name = lookup.get(keyFor(ct))
			if (name) {
				newContent[ct] = { ...mediaType, schema: { $ref: `#/components/schemas/${name}` } }
				changed = true
				continue
			}
			const rewritten = hoistedCanonicalToName.size > 0 ? rewriteNestedRefs(schema, hoistedCanonicalToName) : schema
			if (rewritten !== schema) {
				newContent[ct] = { ...mediaType, schema: rewritten }
				changed = true
			} else {
				newContent[ct] = mediaType
			}
		}
		return changed ? newContent : null
	}

	const newPaths: Record<string, Record<string, Record<string, unknown>>> = {}

	for (const [pathKey, methods] of Object.entries(paths)) {
		const newMethods: Record<string, Record<string, unknown>> = {}

		for (const [method, operation] of Object.entries(methods)) {
			const op = operation as Record<string, unknown>
			const m = method.toLowerCase()
			let newOp = op

			const requestBody = op.requestBody as Record<string, unknown> | undefined
			const reqContent = requestBody?.content as Record<string, Record<string, unknown>> | undefined
			if (requestBody && reqContent) {
				const next = rewriteContent(reqContent, (ct) => slotKey(pathKey, m, "request", undefined, ct))
				if (next) newOp = { ...op, requestBody: { ...requestBody, content: next } }
			}

			const responses = newOp.responses as Record<string, Record<string, unknown>> | undefined
			if (responses) {
				let newResponses: Record<string, Record<string, unknown>> | undefined
				for (const [status, response] of Object.entries(responses)) {
					const content = response.content as Record<string, Record<string, unknown>> | undefined
					if (!content) continue
					const statusNum = statusNumber(status)
					const next = rewriteContent(content, (ct) => slotKey(pathKey, m, "response", statusNum, ct))
					if (!next) continue
					if (!newResponses) newResponses = { ...responses }
					newResponses[status] = { ...response, content: next }
				}
				if (newResponses) newOp = { ...newOp, responses: newResponses }
			}

			newMethods[method] = newOp
		}

		newPaths[pathKey] = newMethods
	}

	return newPaths
}

/** Every `#/components/schemas/<name>` a value refers to. */
function collectComponentRefs(value: unknown, out: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectComponentRefs(item, out)
		return
	}
	if (value === null || typeof value !== "object") return
	for (const [key, child] of Object.entries(value)) {
		if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
			out.add(child.slice("#/components/schemas/".length))
		} else {
			collectComponentRefs(child, out)
		}
	}
}

export function deduplicateSchemas(spec: OpenApiSpec): OpenApiSpec {
	/* Sort paths lexicographically for determinism — input order must not affect output. */
	const sortedPaths: Record<string, Record<string, Record<string, unknown>>> = {}
	for (const key of Object.keys(spec.paths).sort()) sortedPaths[key] = spec.paths[key]

	const slots = collectSchemaSlots(sortedPaths)
	const existing = spec.components?.schemas ?? {}

	/* Group slots by canonical shape — same shape = one component. */
	const groups = new Map<string, SchemaSlot[]>()
	for (const slot of slots) {
		const group = groups.get(slot.canonical)
		if (group) group.push(slot)
		else groups.set(slot.canonical, [slot])
	}

	/*
	 * Tier resolution per canonical group:
	 *   Tier 1: unique shape (group.length === 1) → operation-derived name
	 *   Tier 2: shared error envelope → Err{status}* name
	 *   Tier 3: shared non-error → first-slot operation-derived name
	 * Collision (two canonicals → same tier name, or a name an existing component holds) →
	 * hash suffix, re-checked until free.
	 */
	const canonicalToName = new Map<string, string>()
	const nameToCanonical = new Map<string, string>()

	for (const [canonical, groupSlots] of groups) {
		const firstSlot = groupSlots[0]
		let base: string

		if (groupSlots.length > 1 && isErrorEnvelope(firstSlot.schema)) {
			const fallbackStatus = firstSlot.context.role === "response" ? firstSlot.context.status : undefined
			base = deriveErrorEnvelopeName(firstSlot.schema, fallbackStatus)
		} else {
			base = deriveSchemaName(firstSlot.context)
		}

		const name = uniqueName(
			base,
			canonical,
			(n) => Object.hasOwn(existing, n) || (nameToCanonical.has(n) && nameToCanonical.get(n) !== canonical),
		)
		nameToCanonical.set(name, canonical)
		canonicalToName.set(canonical, name)
	}

	/* Build slotNames map (SchemaSlot → resolved name) for hoisting + path rewriting. */
	const slotNames = new Map<SchemaSlot, string>()
	for (const slot of slots) {
		const name = canonicalToName.get(slot.canonical)
		if (name) slotNames.set(slot, name)
	}

	/* Nested hoisting: collect shared nested objects, then rewrite inline → $ref.
	 * Error envelope slots (any tier) mark their nested schemas as envelope-owned so
	 * envelope-exclusive nesting (e.g. `fields`) is not hoisted under a per-spec name. */
	const { schemas: hoistedSchemas, canonicalToName: hoistedCanonicalToName } = collectHoistedSchemas(
		slots,
		slotNames,
		(n) => Object.hasOwn(existing, n) || nameToCanonical.has(n),
	)

	/* Build components map, rewriting nested fields → $refs where hoisted */
	const extractedSchemas: Record<string, Record<string, unknown>> = {}
	for (const slot of slots) {
		const name = slotNames.get(slot)
		if (name && !Object.hasOwn(extractedSchemas, name)) {
			extractedSchemas[name] =
				hoistedCanonicalToName.size > 0 ? rewriteNestedRefs(slot.schema, hoistedCanonicalToName) : slot.schema
		}
	}

	const hasNewSchemas = Object.keys(extractedSchemas).length > 0 || Object.keys(hoistedSchemas).length > 0
	/* Nothing to extract and no existing components — return unchanged */
	if (!hasNewSchemas && !spec.components) return spec

	const paths =
		slotNames.size > 0 || hoistedCanonicalToName.size > 0
			? rewritePathsToRefs(sortedPaths, slots, slotNames, hoistedCanonicalToName)
			: sortedPaths

	const mergedSchemas: Record<string, Record<string, unknown>> = { ...existing, ...extractedSchemas }

	/* a hoisted nested schema whose every user became a component $ref is still referenced from
	   that component; one referenced from nowhere is dropped. A kept hoisted schema can itself
	   reference hoisted schemas (an object nested in a shared object), so keep closing over the
	   references until no new one appears. */
	const referenced = new Set<string>()
	collectComponentRefs(paths, referenced)
	collectComponentRefs(mergedSchemas, referenced)
	let added = true
	while (added) {
		added = false
		for (const [name, schema] of Object.entries(hoistedSchemas)) {
			if (Object.hasOwn(mergedSchemas, name) || !referenced.has(name)) continue
			mergedSchemas[name] = schema
			collectComponentRefs(schema, referenced)
			added = true
		}
	}

	const components: OpenApiSpec["components"] = {
		...spec.components,
		...(Object.keys(mergedSchemas).length > 0 ? { schemas: mergedSchemas } : {}),
	}

	return { ...spec, components, paths }
}

export type OpenApiSanitizeOptions = {
	stripSecurityRequirements?: string[]
	stripSecuritySchemes?: string[]
	stripXExtensions?: boolean | string[]
}

export function sanitizeOpenApiSpec(spec: OpenApiSpec, options: OpenApiSanitizeOptions): OpenApiSpec {
	const result = cloneJson(spec)

	if (options.stripSecuritySchemes?.length && result.components?.securitySchemes) {
		for (const name of options.stripSecuritySchemes) {
			delete result.components.securitySchemes[name]
		}
		if (Object.keys(result.components.securitySchemes).length === 0) {
			delete result.components.securitySchemes
		}
	}

	for (const methods of Object.values(result.paths)) {
		for (const operation of Object.values(methods)) {
			const op = operation as Record<string, unknown>

			if (options.stripSecurityRequirements?.length && Array.isArray(op.security)) {
				op.security = (op.security as Record<string, unknown>[]).filter(
					(s) => !options.stripSecurityRequirements?.some((name) => name in s),
				)
				if ((op.security as unknown[]).length === 0) delete op.security
			}

			if (options.stripXExtensions) {
				const targets =
					options.stripXExtensions === true
						? Object.keys(op).filter((k) => k.startsWith("x-"))
						: options.stripXExtensions
				for (const ext of targets) delete op[ext]
			}
		}
	}

	return result
}

function cloneJson<T>(value: T): T {
	try {
		return structuredClone(value)
	} catch {
		return JSON.parse(JSON.stringify(value)) as T
	}
}

/* Inlining expands each $ref; a graph of shared refs can grow exponentially (`L30` with two
   fields that both point at `L29`, …), so the output is bounded and generation fails loudly. */
const MAX_INLINED_SCHEMA_NODES = 200_000

type InlineBudget = { nodes: number }

function chargeInline(budget: InlineBudget): void {
	if (++budget.nodes > MAX_INLINED_SCHEMA_NODES) {
		throw new Error(
			`SDK codegen: inlined schemas exceed ${MAX_INLINED_SCHEMA_NODES} nodes (deeply shared $refs); ` +
				"flatten the shared component chain",
		)
	}
}

function resolveSchema(
	schema: Record<string, unknown>,
	schemas: Record<string, Record<string, unknown>>,
	budget: InlineBudget,
	visited = new Set<string>(),
): Record<string, unknown> {
	if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/components/schemas/")) {
		const name = schema.$ref.slice("#/components/schemas/".length)
		/* circular ref guard — return empty schema which maps to unknown in IR */
		if (visited.has(name)) return {}
		const resolved = Object.hasOwn(schemas, name) ? schemas[name] : undefined
		if (!resolved) throw new Error(`$ref points to nonexistent component: ${schema.$ref}`)
		const next = new Set(visited)
		next.add(name)
		return resolveSchemaDeep(cloneJson(resolved), schemas, budget, next)
	}
	return resolveSchemaDeep(schema, schemas, budget, visited)
}

function resolveSchemaDeep(
	schema: Record<string, unknown>,
	schemas: Record<string, Record<string, unknown>>,
	budget: InlineBudget,
	visited: Set<string>,
): Record<string, unknown> {
	chargeInline(budget)
	for (const key of ["oneOf", "anyOf", "allOf"] as const) {
		const arr = schema[key]
		if (Array.isArray(arr)) {
			schema[key] = arr.map((item: unknown) => {
				if (item && typeof item === "object" && !Array.isArray(item)) {
					return resolveSchema(item as Record<string, unknown>, schemas, budget, visited)
				}
				return item
			})
		}
	}
	/* resolve array items */
	if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
		schema.items = resolveSchema(schema.items as Record<string, unknown>, schemas, budget, visited)
	}
	/* resolve object properties */
	if (schema.properties && typeof schema.properties === "object") {
		const props = schema.properties as Record<string, unknown>
		for (const [k, v] of Object.entries(props)) {
			if (v && typeof v === "object" && !Array.isArray(v)) {
				props[k] = resolveSchema(v as Record<string, unknown>, schemas, budget, visited)
			}
		}
	}
	/* resolve additionalProperties */
	if (
		schema.additionalProperties &&
		typeof schema.additionalProperties === "object" &&
		!Array.isArray(schema.additionalProperties)
	) {
		schema.additionalProperties = resolveSchema(
			schema.additionalProperties as Record<string, unknown>,
			schemas,
			budget,
			visited,
		)
	}
	return schema
}

export function resolveRefs(spec: OpenApiSpecInput): OpenApiSpecInput {
	const schemas = spec.components?.schemas
	if (!schemas || Object.keys(schemas).length === 0) return spec

	const paths = cloneJson(spec.paths)
	const budget: InlineBudget = { nodes: 0 }

	for (const methods of Object.values(paths)) {
		for (const operation of Object.values(methods)) {
			const op = operation as Record<string, unknown>

			const requestBody = op.requestBody as Record<string, unknown> | undefined
			if (requestBody) {
				const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
				if (content) {
					for (const [ct, mediaType] of Object.entries(content)) {
						const schema = mediaType.schema as Record<string, unknown> | undefined
						if (schema) content[ct] = { ...mediaType, schema: resolveSchema(schema, schemas, budget) }
					}
				}
			}

			const responses = op.responses as Record<string, Record<string, unknown>> | undefined
			if (responses) {
				for (const [status, response] of Object.entries(responses)) {
					const content = response.content as Record<string, Record<string, unknown>> | undefined
					if (!content) continue
					/* every content type resolved, not only the last one written */
					const resolved: Record<string, Record<string, unknown>> = {}
					for (const [ct, mediaType] of Object.entries(content)) {
						const schema = mediaType.schema as Record<string, unknown> | undefined
						resolved[ct] = schema ? { ...mediaType, schema: resolveSchema(schema, schemas, budget) } : mediaType
					}
					responses[status] = { ...response, content: resolved }
				}
			}
		}
	}

	const { schemas: _schemas, ...restComponents } = spec.components ?? {}
	const components = Object.keys(restComponents).length > 0 ? restComponents : undefined

	return { ...spec, components, paths }
}

/**
 * Zod node kinds JSON Schema has no word for. Zod emits `{}` for each of them under
 * `unrepresentable: "any"`; the degrade is per node, and the rest of the schema survives.
 */
const ZOD_UNREPRESENTABLE = new Set(["custom", "function", "map", "nan", "promise", "set", "symbol", "transform"])

type ZodOverrideCtx = { jsonSchema: Record<string, unknown>; zodSchema: unknown }

/** `override` for Zod's converter: give `Date` and `BigInt` their wire shape, record what degraded. */
function zodOverride(degraded: Set<string>): (ctx: ZodOverrideCtx) => void {
	return (ctx) => {
		const def = zodDefOf(ctx.zodSchema)
		const kind = String(def?.type ?? "")
		if (kind === "date") {
			/* JSON.stringify writes a Date as an ISO string */
			ctx.jsonSchema.format = "date-time"
			ctx.jsonSchema.type = "string"
			return
		}
		if (kind === "bigint") {
			ctx.jsonSchema.format = "int64"
			ctx.jsonSchema.type = "integer"
			return
		}
		if (ZOD_UNREPRESENTABLE.has(kind) && Object.keys(ctx.jsonSchema).length === 0) degraded.add(kind)
	}
}

/** Zod 4 puts converters on the schema instance. Use those first so Workers
 * (where `import("zod")` does not resolve) still emit real JSON Schema. */
function zodInstanceToJsonSchema(
	schema: StandardSchemaLike,
	io: "input" | "output",
	degraded: Set<string>,
): Record<string, unknown> | undefined {
	const libraryOptions = { override: zodOverride(degraded), unrepresentable: "any" as const }
	const jsonSchema = (
		schema["~standard"] as {
			jsonSchema?: Record<"input" | "output", ((params?: unknown) => unknown) | undefined>
		}
	).jsonSchema
	const fromStandard = jsonSchema?.[io]
	if (typeof fromStandard === "function") {
		const result = fromStandard({ libraryOptions, target: "draft-2020-12" })
		if (result && typeof result === "object") return result as Record<string, unknown>
	}
	const inst = (schema as { toJSONSchema?: (opts?: Record<string, unknown>) => unknown }).toJSONSchema
	if (typeof inst === "function") {
		const result = inst.call(schema, { ...libraryOptions, io })
		if (result && typeof result === "object") return result as Record<string, unknown>
	}
	if (toJSONSchemaFn) {
		const convert = toJSONSchemaFn as (schema: unknown, opts: Record<string, unknown>) => unknown
		const result = convert(schema, { ...libraryOptions, io })
		if (result && typeof result === "object") return result as Record<string, unknown>
	}
	return undefined
}

function applyZodBag(schema: unknown, json: Record<string, unknown>): Record<string, unknown> {
	const bag = (schema as { _zod?: { bag?: Record<string, unknown> } })._zod?.bag
	if (!bag) return json
	if (typeof bag.format === "string") {
		if (bag.format === "safeint") json.type = "integer"
		else json.format = bag.format
	}
	if (json.type === "string") {
		if (typeof bag.minimum === "number") json.minLength = bag.minimum
		if (typeof bag.maximum === "number") json.maxLength = bag.maximum
	}
	if (json.type === "number" || json.type === "integer") {
		if (typeof bag.minimum === "number") json.minimum = bag.minimum
		if (typeof bag.maximum === "number") json.maximum = bag.maximum
	}
	return json
}

function zodDefOf(schema: unknown): Record<string, unknown> | undefined {
	const s = schema as {
		_def?: Record<string, unknown>
		def?: Record<string, unknown>
		_zod?: { def?: Record<string, unknown> }
	}
	return s._def ?? s.def ?? s._zod?.def
}

function zodDefIsOptional(def: Record<string, unknown>, io: "input" | "output"): boolean {
	const t = String(def.typeName ?? def.type ?? "")
	if (t === "ZodOptional" || t === "optional") return true
	/* a default fills the value in: optional on the way in, always present on the way out */
	if ((t === "ZodDefault" || t === "default" || t === "prefault") && io === "input") return true
	if (
		t === "ZodNullable" ||
		t === "nullable" ||
		t === "ZodDefault" ||
		t === "default" ||
		t === "prefault" ||
		t === "ZodCatch" ||
		t === "catch" ||
		t === "ZodReadonly" ||
		t === "readonly"
	) {
		const inner = def.innerType
		if (inner) {
			const innerDef = zodDefOf(inner)
			if (innerDef) return zodDefIsOptional(innerDef, io)
		}
	}
	return false
}

function literalSchema(values: readonly unknown[]): Record<string, unknown> {
	if (values.length === 1) return { const: values[0] }
	return { enum: [...values] }
}

/** Walk Zod 3/4 internals. Survives Workers bundles that drop `toJSONSchema`. */
function zodDefToJsonSchema(
	schema: unknown,
	io: "input" | "output" = "output",
	depth = 0,
): Record<string, unknown> | undefined {
	if (depth > 24) return {}
	const def = zodDefOf(schema)
	if (!def) return undefined
	const typeName = String(def.typeName ?? def.type ?? "")
	const walk = (child: unknown): Record<string, unknown> => zodDefToJsonSchema(child, io, depth + 1) ?? {}

	switch (typeName) {
		case "ZodString":
		case "string":
			return applyZodBag(schema, { type: "string" })
		case "ZodNumber":
		case "number":
			return applyZodBag(schema, { type: "number" })
		case "ZodBoolean":
		case "boolean":
			return { type: "boolean" }
		case "ZodBigInt":
		case "bigint":
			return { format: "int64", type: "integer" }
		case "ZodDate":
		case "date":
			return { format: "date-time", type: "string" }
		case "ZodFile":
		case "file":
			/* so form emit can see format:binary when toJSONSchema is unavailable */
			return { contentEncoding: "binary", format: "binary", type: "string" }
		case "ZodNull":
		case "null":
			return { type: "null" }
		case "ZodUndefined":
		case "ZodVoid":
		case "undefined":
		case "void":
		case "ZodAny":
		case "ZodUnknown":
		case "any":
		case "unknown":
			return {}
		case "ZodLiteral":
		case "literal": {
			const values = Array.isArray(def.values) ? (def.values as unknown[]) : [def.value]
			return literalSchema(values.map((v) => (typeof v === "bigint" ? Number(v) : v)))
		}
		case "ZodEnum":
		case "enum": {
			const raw = (def.values ?? def.entries) as unknown
			let list: unknown[]
			if (Array.isArray(raw)) list = raw
			else {
				/* a TS numeric enum carries reverse mappings: { A: 0, "0": "A" } — keep the values */
				const entries = raw as Record<string, unknown>
				list = Object.keys(entries)
					.filter((k) => typeof entries[entries[k] as string] !== "number")
					.map((k) => entries[k])
			}
			const types = new Set(list.map((v) => typeof v))
			if (types.size === 1 && types.has("string")) return { enum: list, type: "string" }
			if (types.size === 1 && types.has("number")) return { enum: list, type: "number" }
			return { enum: list }
		}
		case "ZodObject":
		case "object": {
			const rawShape = def.shape as Record<string, unknown> | (() => Record<string, unknown>) | undefined
			const shape = typeof rawShape === "function" ? rawShape() : rawShape
			if (!shape) return { type: "object" }
			const properties: Record<string, unknown> = {}
			const required: string[] = []
			for (const key of Object.keys(shape)) {
				const prop = shape[key]
				properties[key] = walk(prop)
				const propDef = zodDefOf(prop)
				if (!propDef || !zodDefIsOptional(propDef, io)) required.push(key)
			}
			const result: Record<string, unknown> = { properties, type: "object" }
			if (io === "output") result.additionalProperties = false
			if (required.length > 0) result.required = required
			return result
		}
		case "ZodArray":
		case "array":
			return { items: walk(def.element ?? def.type), type: "array" }
		case "ZodOptional":
		case "optional":
			return zodDefToJsonSchema(def.innerType, io, depth + 1)
		case "ZodNullable":
		case "nullable":
			return { anyOf: [walk(def.innerType), { type: "null" }] }
		case "ZodUnion":
		case "ZodDiscriminatedUnion":
		case "union":
			return { anyOf: ((def.options as unknown[]) ?? []).map(walk) }
		case "ZodIntersection":
		case "intersection":
			return { allOf: [walk(def.left), walk(def.right)] }
		case "ZodRecord":
		case "record":
			return { additionalProperties: walk(def.valueType), type: "object" }
		case "ZodTuple":
		case "tuple": {
			const items = ((def.items as unknown[]) ?? []).map(walk)
			const out: Record<string, unknown> = { prefixItems: items, type: "array" }
			if (def.rest) out.items = walk(def.rest)
			else {
				out.items = false
				out.maxItems = items.length
			}
			out.minItems = items.length
			return out
		}
		case "ZodDefault":
		case "default":
		case "prefault": {
			const inner = walk(def.innerType)
			const value = (def as { defaultValue?: unknown }).defaultValue
			const resolved = typeof value === "function" ? undefined : value
			return resolved === undefined ? inner : { ...inner, default: resolved }
		}
		case "ZodCatch":
		case "catch":
		case "ZodReadonly":
		case "readonly":
			return zodDefToJsonSchema(def.innerType, io, depth + 1)
		case "ZodPipeline":
		case "pipe":
			/* a pipe validates `in` and returns `out` */
			return zodDefToJsonSchema(io === "input" ? def.in : def.out, io, depth + 1)
		case "ZodBranded":
			return zodDefToJsonSchema(def.type, io, depth + 1)
		case "ZodLazy":
		case "lazy": {
			const getter = def.getter as (() => unknown) | undefined
			return typeof getter === "function" ? zodDefToJsonSchema(getter(), io, depth + 1) : {}
		}
		default:
			return undefined
	}
}

/** How a schema that cannot be converted at all is handled. Set per `generateOpenApi` call. */
let schemaFailureMode: "throw" | "warn" = "throw"

function schemaConversionFailed(what: string, io: "input" | "output", err: unknown): Record<string, unknown> {
	const msg = err instanceof Error ? err.message : String(err)
	const text = `[honey:codegen] schemaToJsonSchema could not convert ${what} (io=${io}): ${msg}`
	if (schemaFailureMode === "throw") throw new Error(text)
	console.warn(`${text}. Documented as an unconstrained schema.`)
	return {}
}

function schemaToJsonSchema(schema: StandardSchemaLike, io: "input" | "output" = "output"): unknown {
	/* Pre-serialized JSON-schema blob or non-schema value — no ~standard marker.
	 * Arktype schemas are functions but still carry the marker, so pass those through too. */
	if (
		schema === null ||
		(typeof schema !== "object" && typeof schema !== "function") ||
		!("~standard" in (schema as object))
	) {
		return schema
	}
	const vendor = schema["~standard"].vendor

	if (vendor === "zod") {
		const kind = (schema as { _zod?: { def?: { type?: string } } })?._zod?.def?.type ?? "unknown"
		const degraded = new Set<string>()
		let result: Record<string, unknown> | undefined
		try {
			result = zodInstanceToJsonSchema(schema, io, degraded) ?? zodDefToJsonSchema(schema, io)
		} catch (err) {
			return schemaConversionFailed(`zod/${kind}`, io, err)
		}
		if (!result) return schemaConversionFailed(`zod/${kind}`, io, new Error("no converter available"))
		if (degraded.size > 0) {
			console.warn(
				`[honey:codegen] schemaToJsonSchema: zod/${kind} (io=${io}) has ${[...degraded].sort().join(", ")} ` +
					"node(s) JSON Schema cannot express; each is documented as an unconstrained schema. " +
					'Describe them with .meta({ ... }) or z.toJSONSchema\'s "override".',
			)
		}
		return sanitizeZodJsonSchema(result)
	}

	try {
		if (vendor === "valibot") return valibotToJsonSchema(schema)
		if (vendor === "arktype") return arkTypeToJsonSchema(schema)
		if (vendor === "yup") return yupToJsonSchema(schema)
		if (vendor === "effect") return effectToJsonSchema(schema)
	} catch (err) {
		return schemaConversionFailed(vendor, io, err)
	}

	/* no converter for this vendor: say so once per schema, never emit the introspection object */
	console.warn(
		`[honey:codegen] schemaToJsonSchema: no JSON Schema converter for vendor "${vendor}"; ` +
			"documented as an unconstrained schema.",
	)
	return {}
}

/* ---- Manifest generation ---- */

export type GenerateManifestOptions = {
	/** Drop routes the predicate rejects, as `openapi({ filterRoutes })` does. */
	filterRoutes?: (route: OpenApiRouteInfo) => boolean
	/**
	 * `"all"` (default, the `honey generate` artifact): every route and meta key.
	 * `"published"` (a served `/manifest.json`): the OpenAPI document's visibility policy —
	 * `meta.internal` routes are left out, and meta carries only keys the app's `metaSpec`
	 * maps (built-ins included) and does not hide.
	 */
	visibility?: "all" | "published"
}

export function generateManifest<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
	options: GenerateManifestOptions = {},
): RouteManifest {
	const factory = getErrorFactory(app)
	const published = options.visibility === "published"
	const publishable = published ? publishableMetaKeys(metaSpecOf(app)) : null
	const collected: CollectedRoute[] = collectRoutes(app).filter(({ handler, method, path }) => {
		if (published && isMetaInternal(handler)) return false
		return !options.filterRoutes || options.filterRoutes({ meta: handler.mt ?? EMPTY_OBJ, method, path })
	})

	/* each key resolved against the factory of a route that declares it — a mounted sub-app keeps its own */
	const allErrorKeys = new Map<string, Record<string, () => HoneyError> | null>()

	const routes: RouteManifestEntry[] = collected.map(({ handler, method, path }) => {
		const entry: RouteManifestEntry = {
			errors: Array.from(handler.ek),
			meta: publishable
				? Object.fromEntries(Object.entries(handler.mt ?? EMPTY_OBJ).filter(([key]) => publishable(key)))
				: (handler.mt ?? EMPTY_OBJ),
			method,
			middleware: handler.mw.map((mw) => mw.name || "anonymous"),
			params: extractParams(path),
			path,
		}

		const routeFactory = (handler.fac as Record<string, () => HoneyError> | null | undefined) ?? factory
		for (const ek of handler.ek) {
			if (!allErrorKeys.has(ek)) allErrorKeys.set(ek, routeFactory)
		}

		if (handler.iv) {
			entry.input = Object.fromEntries(
				Object.entries(handler.iv)
					.filter(([, v]) => v !== undefined)
					.map(([k, v]) => [k, introspectSchema(unwrapEntry(v as InputSchemaEntry))]),
			)
		}

		if (handler.os) {
			entry.output = Object.fromEntries(
				Object.entries(handler.os)
					.filter(([, v]) => v !== undefined)
					.map(([contentType, schemas]) => {
						if (contentType === "redirect") {
							return [contentType, schemas]
						}
						return [
							contentType,
							Object.fromEntries(
								Object.entries(schemas)
									.filter(([, s]) => s !== undefined)
									.map(([statusKey, s]) => [statusKey, introspectSchema(s as StandardSchemaLike)]),
							),
						]
					}),
			)
		}

		return entry
	})

	return {
		errors: Array.from(allErrorKeys).map(([key, keyFactory]) => resolveErrorInfo(key, keyFactory)),
		routes,
	}
}

/* ---- OpenAPI generation ---- */

export async function generateOpenApi<TEnv, TCtx, TMeta = unknown>(
	app: Honey<TEnv, TCtx, unknown, TMeta, unknown, string, string>,
	options: {
		filterRoutes?: (route: OpenApiRouteInfo<TMeta>) => boolean
		info: OpenApiInfo
		/**
		 * Report mutations that declare no `invalidate`. Default `"warn"` — it drives generated
		 * SDK invalidation, so a gap is a correctness bug, but many mutations correctly refresh
		 * nothing. `"off"` for a document served at runtime.
		 */
		invalidate?: InvalidateCheckConfig
		/**
		 * A schema that cannot be converted at all: `"throw"` (default, `honey generate`) fails
		 * the build; `"warn"` (a served document) logs it and documents an unconstrained schema.
		 * A single node JSON Schema cannot express (`z.date()`, `z.custom()`) never fails either
		 * way — only that node degrades.
		 */
		onSchemaError?: "throw" | "warn"
		/** Named metaSpec profile — selects which emitted keys this document carries */
		profile?: string
		securitySchemes?: Record<string, unknown>
	},
): Promise<OpenApiSpec> {
	await Promise.all([loadToJSONSchema(), loadEffectJsonSchema()])
	const prev = getJsonSchemaConverter()
	const prevMode = schemaFailureMode
	schemaFailureMode = options.onSchemaError ?? "throw"
	setJsonSchemaConverter((schema, io) => schemaToJsonSchema(schema, io) as Record<string, unknown>)
	try {
		const { onSchemaError: _mode, ...rest } = options
		const spec = generateOpenApiFromTree(app, rest)
		return deduplicateSchemas(spec)
	} finally {
		setJsonSchemaConverter(prev)
		schemaFailureMode = prevMode
	}
}

export function extractSchemas<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
): Record<string, Record<string, unknown>> {
	const collected: CollectedRoute[] = collectRoutes(app)

	const result: Record<string, Record<string, unknown>> = {}

	for (const { handler, method, path } of collected) {
		const key = `${method} ${path}`
		result[key] = {}

		if (handler.iv) {
			result[key].input = Object.fromEntries(
				Object.entries(handler.iv)
					.filter(([, v]) => v !== undefined)
					.map(([k, v]) => [k, introspectSchema(unwrapEntry(v as InputSchemaEntry))]),
			)
		}

		if (handler.os) {
			result[key].output = Object.fromEntries(
				Object.entries(handler.os)
					.filter(([, v]) => v !== undefined)
					.map(([contentType, schemas]) => [
						contentType,
						Object.fromEntries(
							Object.entries(schemas)
								.filter(([, s]) => s !== undefined)
								.map(([statusKey, s]) => [statusKey, introspectSchema(s as StandardSchemaLike)]),
						),
					]),
			)
		}
	}

	return result
}

/* ---- Static route tree codegen ---- */

/**
 * Reject meta a generated file cannot reproduce. A route tree is JSON plus topology: a value
 * JSON cannot round-trip (`Date`, `RegExp`, `NaN`, `BigInt`, class instances) would be
 * emitted as something else, or interned together with a different value.
 */
function assertJsonValue(value: unknown, where: string, path: string): void {
	const fail = (what: string): never => {
		throw new Error(`${where}: ${path} is ${what} — route trees carry JSON values only`)
	}
	if (value === null || typeof value === "string" || typeof value === "boolean") return
	if (typeof value === "number") {
		if (!Number.isFinite(value)) fail(String(value))
		return
	}
	if (value === undefined) return
	if (typeof value !== "object") fail(`a ${typeof value}`)
	if (Array.isArray(value)) {
		for (let k = 0; k < value.length; k++) assertJsonValue(value[k], where, `${path}[${k}]`)
		return
	}
	const proto = Object.getPrototypeOf(value) as unknown
	if (proto !== Object.prototype && proto !== null) {
		const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "an object"
		fail(`a ${name}`)
	}
	for (const key of Object.keys(value as Record<string, unknown>)) {
		assertJsonValue((value as Record<string, unknown>)[key], where, `${path}.${key}`)
	}
}

/** Object-literal key that defines an own property even for `__proto__`. */
function keyExpr(key: string): string {
	return key === "__proto__" ? '["__proto__"]' : JSON.stringify(key)
}

type TreeNodeLike = {
	d: { c: TreeNodeLike; n: string } | null
	m: Record<string, string> | null
	s: Record<string, TreeNodeLike>
	w: { m: Record<string, string>; n: string } | null
	ws: string | null
}

function methodMapExpr(m: Record<string, string>, intern: InternPool): string {
	const parts = Object.keys(m).map((method) => `${keyExpr(method)}: ${intern.expr(m[method])}`)
	return `S({ ${parts.join(", ")} })`
}

function serializeNode(node: TreeNodeLike, intern: InternPool): string {
	const statics = Object.keys(node.s)
	const sExpr =
		statics.length > 0
			? `S({ ${statics.map((k) => `${keyExpr(k)}: ${serializeNode(node.s[k], intern)}`).join(", ")} })`
			: "undefined"
	const args = [
		sExpr,
		node.m !== null ? methodMapExpr(node.m, intern) : "null",
		node.d !== null ? `{ n: ${JSON.stringify(node.d.n)}, c: ${serializeNode(node.d.c, intern)} }` : "null",
		node.w !== null ? `{ n: ${JSON.stringify(node.w.n)}, m: ${methodMapExpr(node.w.m, intern)} }` : "null",
		node.ws !== null ? intern.expr(node.ws) : "null",
	]
	while (args.length > 0 && (args[args.length - 1] === "null" || args[args.length - 1] === "undefined")) args.pop()
	return `N(${args.join(", ")})`
}

function collectMetaShape(entries: Array<{ mt: Record<string, unknown> | null | undefined }>): {
	allKeys: Map<string, Set<string>>
	keyCount: Map<string, number>
	metaHandlerCount: number
} {
	const allKeys = new Map<string, Set<string>>()
	const keyCount = new Map<string, number>()
	let metaHandlerCount = 0
	for (const { mt } of entries) {
		if (mt === null || mt === undefined) continue
		metaHandlerCount++
		for (const [k, v] of Object.entries(mt)) {
			if (!allKeys.has(k)) allKeys.set(k, new Set())
			allKeys.get(k)?.add(emitLiteral(v))
			keyCount.set(k, (keyCount.get(k) ?? 0) + 1)
		}
	}
	return { allKeys, keyCount, metaHandlerCount }
}

function emitMetaShapeType(shape: ReturnType<typeof collectMetaShape>): string {
	if (shape.allKeys.size === 0) return ""
	const props = [...shape.allKeys.entries()]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, types]) => {
			const optional = (shape.keyCount.get(key) ?? 0) < shape.metaHandlerCount ? "?" : ""
			const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
			return `\t${safeKey}${optional}: ${[...types].join(" | ")}`
		})
	return `export type MetaShape = {\n${props.join("\n")}\n} & Record<string, unknown>\n`
}

type EmitEntry = {
	bek: string | null
	ek: string[]
	id: string
	internalMeta: boolean
	mt: Record<string, unknown> | null
}

/**
 * Emit a route tree module: topology with `RouteId` leaves plus per-route data (meta, error
 * keys, boundary key). No handler fields — the app that loads the tree registers its routes,
 * which bind to these ids; leaves it does not register are delegated to its catch-all.
 */
function emitRouteTree(tree: RouteTree): string {
	const order: string[] = []
	const seen = new Set<string>()
	forEachLeaf(tree.root, (_method, _path, id) => {
		if (!seen.has(id)) {
			seen.add(id)
			order.push(id)
		}
	})
	const entries: EmitEntry[] = []
	for (const id of order) {
		const entry = tree.routes[id]
		if (entry === undefined) throw new Error(`route tree leaf ${id} has no route entry`)
		const mt = entry.mt ?? null
		if (mt !== null) assertJsonValue(mt, `Route meta for ${id}`, "meta")
		entries.push({
			bek: entry.bek ?? null,
			ek: [...(entry.ek ?? [])],
			id,
			internalMeta: (mt as { internal?: unknown } | null)?.internal === true,
			mt,
		})
	}

	const intern = new InternPool()
	for (const e of entries) {
		intern.count(e.bek)
		if (e.ek.length > 0) intern.count(e.ek)
		intern.count(e.mt)
		intern.count(e.id)
	}
	for (const e of entries) {
		intern.force(e.mt, "M")
		intern.force(e.id, "P")
	}
	intern.seal()

	const metaShape = collectMetaShape(entries)
	const hasMetaShape = metaShape.allKeys.size > 0
	const lines: string[] = []
	lines.push('import type { RouteTree, TreeNode } from "@lovrozagar/honey/tree"')
	lines.push("")
	lines.push("function S<T>(o: Record<string, T>): Record<string, T> {")
	lines.push("\treturn Object.assign(Object.create(null) as Record<string, T>, o)")
	lines.push("}")
	lines.push(
		'function N(s: Record<string, TreeNode> = S({}), m: Record<string, string> | null = null, d: TreeNode["d"] = null, w: TreeNode["w"] = null, ws: string | null = null): TreeNode {',
	)
	lines.push("\treturn { d, m, s, w, ws }")
	lines.push("}")

	const consts = intern.emitConstLines()
	if (consts.length > 0) {
		lines.push("")
		for (const line of consts) {
			if (hasMetaShape && /^const M\d+ = /.test(line)) lines.push(`${line} as unknown as MetaShape`)
			else lines.push(line)
		}
	}

	lines.push("")
	lines.push(`export const tree: TreeNode = ${serializeNode(tree.root as TreeNodeLike, intern)}`)
	lines.push("")
	const routeLines = entries.map((e) => {
		const parts: string[] = []
		if (e.bek !== null) parts.push(`bek: ${intern.expr(e.bek)}`)
		if (e.ek.length > 0) parts.push(`ek: ${intern.expr(e.ek)}`)
		if (e.mt !== null) parts.push(`mt: ${intern.expr(e.mt)}`)
		return `\t[${intern.expr(e.id)}]: ${parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}"}`
	})
	lines.push(`export const routes: RouteTree["routes"] = S({\n${routeLines.join(",\n")}\n})`)
	lines.push("")

	let code = lines.join("\n")

	if (hasMetaShape) code += `\n${emitMetaShapeType(metaShape)}\n`

	const selectors = entries.filter((e) => !e.id.startsWith("WS ") && !e.internalMeta).map((e) => e.id)
	if (selectors.length > 0) {
		const sorted = [...new Set(selectors)].sort()
		const parts = sorted.map((sel) => {
			const ref = intern.id(sel)
			return ref !== undefined ? `typeof ${ref}` : JSON.stringify(sel)
		})
		code += `\nexport type RouteSelector = ${parts.join(" | ")}\n`
	}

	const metaEntries = entries
		.filter((e) => e.mt !== null && Object.keys(e.mt).length > 0)
		.map((e) => `\t[${intern.expr(e.id)}]: ${intern.expr(e.mt)}`)
	const metaType = hasMetaShape ? "Record<string, MetaShape>" : "Record<string, Record<string, unknown>>"
	if (metaEntries.length > 0) {
		code += `export const meta: ${metaType} = S({\n${metaEntries.join(",\n")}\n})\n`
	}
	code += `export const routeTree: RouteTree = { v: ${ROUTE_TREE_VERSION}, root: tree, routes, ${metaEntries.length > 0 ? "meta" : "meta: {}"} }\n`

	return code
}

/** Emit a route tree module from a tree (a `mergeTree` result or an `app.toRouteTree()` snapshot). */
export function generateRouteTree(tree: RouteTree): string {
	return emitRouteTree(tree)
}

export function generateRouteTreeFromApp<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
): string {
	return emitRouteTree(app.toRouteTree())
}

/**
 * Generate static route tree code from a pre-built RouteTree.
 * Supports gateway patterns: import service trees → enrich meta → mergeTree → generate.
 */
export function generateRouteTreeFromRouteTree(rt: RouteTree): string {
	return emitRouteTree(rt)
}

/* ---- Type codegen ---- */

type GenerateTypesOptions = {
	baseCtxName?: string
	inlineEnvType?: string
	inlineMiddlewareType?: string | null
	/** Inline type string for TTaps — emitted as typed tap() override on context */
	inlineTapsType?: string | null
	/** per-route middleware additions keyed by "method /path" (e.g. "get /v1/auth/me") */
	routeMiddleware?: Record<string, string>
	/** structured per-property middleware data for sub-type dedup */
	routeMiddlewareProps?: Record<string, Array<{ name: string; opt: boolean; type: string }>>
}

function emitInputType(handler: RouteHandler, state: TypeEmitState): string {
	if (!handler.iv) return "{}"
	const entries: string[] = []
	for (const [source, schema] of Object.entries(handler.iv)) {
		if (schema === undefined) continue
		const unwrapped = unwrapEntry(schema as InputSchemaEntry)
		entries.push(`${source}: ${emitSchemaType(unwrapped, state)}`)
	}
	if (entries.length === 0) return "{}"
	return `{ ${entries.join("; ")} }`
}

function emitOutputType(handler: RouteHandler, state: TypeEmitState): string {
	if (!handler.os) return "{}"
	const ctEntries: string[] = []
	for (const [contentType, schemas] of Object.entries(handler.os)) {
		if (schemas === undefined) continue
		if (contentType === "redirect") {
			const keys = Object.keys(schemas).filter((k) => schemas[k as keyof typeof schemas])
			if (keys.length > 0) {
				ctEntries.push(`"redirect": { ${keys.map((k) => `${quoteKey(k)}: true`).join("; ")} }`)
			}
			continue
		}
		const statusEntries: string[] = []
		for (const [statusKey, schema] of Object.entries(schemas)) {
			if (schema === undefined) continue
			statusEntries.push(`${quoteKey(statusKey)}: ${emitSchemaType(schema as StandardSchemaLike, state)}`)
		}
		if (statusEntries.length > 0) {
			ctEntries.push(`${JSON.stringify(contentType)}: { ${statusEntries.join("; ")} }`)
		}
	}
	if (ctEntries.length === 0) return "{}"
	return `{ ${ctEntries.join("; ")} }`
}

function emitMetaType(handler: RouteHandler): string {
	if (!handler.mt) return "{}"
	const entries: string[] = []
	for (const [k, v] of Object.entries(handler.mt)) {
		entries.push(`${quoteKey(k)}: ${emitLiteral(v)}`)
	}
	if (entries.length === 0) return "{}"
	return `{ ${entries.join("; ")} }`
}

function emitLiteral(value: unknown): string {
	if (value === null) return "null"
	if (value === undefined) return "undefined"
	if (typeof value === "string") return JSON.stringify(value)
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "number"
	if (typeof value === "boolean") return String(value)
	if (typeof value === "bigint") return `${value}n`
	if (Array.isArray(value)) {
		if (value.length === 0) return "[]"
		return `[${value.map((v) => emitLiteral(v)).join(", ")}]`
	}
	if (typeof value === "object") {
		const obj = value as Record<string, unknown>
		const keys = Object.keys(obj)
		if (keys.length === 0) return "{}"
		return `{ ${keys.map((k) => `${JSON.stringify(k)}: ${emitLiteral(obj[k])}`).join("; ")} }`
	}
	return "unknown"
}

function emitErrorType(handler: RouteHandler): string {
	if (handler.ek.size === 0) return "never"
	return Array.from(handler.ek)
		.sort()
		.map((k) => JSON.stringify(k))
		.join(" | ")
}

function emitErrorShapes(
	handler: RouteHandler,
	meta: Record<string, ErrorMetaEntry> | null,
	state: TypeEmitState,
): string | null {
	if (handler.ek.size === 0) return null
	const entries: string[] = []
	for (const key of Array.from(handler.ek).sort()) {
		const entry = meta?.[key]
		if (entry?.schema) {
			const schemaType = emitSchemaType(entry.schema as StandardSchemaLike, state)
			entries.push(`${quoteKey(key)}: ${schemaType}`)
		} else {
			entries.push(`${quoteKey(key)}: null`)
		}
	}
	return `{ ${entries.join("; ")} }`
}

function emitErrorsByStatus(
	handler: RouteHandler,
	meta: Record<string, ErrorMetaEntry> | null,
	factory: Record<string, () => HoneyError> | null,
	state: TypeEmitState,
): string | null {
	if (handler.ek.size === 0) return null
	const byStatus = new Map<number, string[]>()
	for (const key of handler.ek) {
		const info = resolveErrorInfo(key, factory)
		if (info.status > 0) {
			let keys = byStatus.get(info.status)
			if (!keys) {
				keys = []
				byStatus.set(info.status, keys)
			}
			keys.push(key)
		}
	}

	const entries: string[] = []
	for (const [status, keys] of Array.from(byStatus.entries()).sort((a, b) => a[0] - b[0])) {
		/* build shape union for this status code */
		const shapes: string[] = []
		for (const key of keys.sort()) {
			const entry = meta?.[key]
			if (entry?.schema) {
				shapes.push(emitSchemaType(entry.schema as StandardSchemaLike, state))
			} else {
				shapes.push("null")
			}
		}
		const shapeType = shapes.length === 1 ? shapes[0] : shapes.join(" | ")
		entries.push(`${status}: ${shapeType}`)
	}
	return `{ ${entries.join("; ")} }`
}

function emitErrorsCtxType(handler: RouteHandler): string {
	if (handler.ek.size === 0) return ""
	const entries = Array.from(handler.ek)
		.sort()
		.map(
			(k) =>
				`${quoteKey(k)}: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, string | number> }) => HoneyError`,
		)
	return `readonly errors: { ${entries.join("; ")} }`
}

/**
 * Per-route middleware type additions. The type extractor keys routes by their full path —
 * basePath included — exactly as the router registers them, so the lookup is exact: a route
 * with no entry gets the base ctx, never another route's additions.
 */
function resolveRouteMiddleware(
	routeMiddleware: Record<string, string> | undefined,
	method: string,
	fullPath: string,
): string | undefined {
	if (!routeMiddleware) return undefined
	const key = `${method} ${fullPath}`
	return Object.hasOwn(routeMiddleware, key) ? routeMiddleware[key] : undefined
}

export function generateTypes<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
	options: GenerateTypesOptions,
): string {
	const collected: CollectedRoute[] = collectRoutes(app, true)

	const factory = getErrorFactory(app)
	const errorMeta = getErrorMeta(factory)
	const baseCtxName = options.baseCtxName ?? "BaseCtx"
	const hasErrors = collected.some(({ handler }) => handler.ek.size > 0)
	const lines: string[] = []

	const importParts = ["HoneyContext", "WithOutput"]
	if (hasErrors) importParts.push("HoneyError")
	lines.push(`import type { ${importParts.join(", ")} } from "@lovrozagar/honey"`)
	lines.push("")

	const envType = options.inlineEnvType ?? "Record<string, unknown>"
	const mwPart = options.inlineMiddlewareType ? ` & ${options.inlineMiddlewareType}` : ""
	if (options.inlineTapsType) {
		lines.push(`type TapMap = ${options.inlineTapsType}`)
		lines.push("")
	}
	const ctxBase = options.inlineTapsType ? `Omit<HoneyContext<${envType}>, "tap">` : `HoneyContext<${envType}>`
	const tapPart = options.inlineTapsType ? " & { tap<K extends keyof TapMap>(key: K, payload: TapMap[K]): void }" : ""
	lines.push(`export type ${baseCtxName} = ${ctxBase}${mwPart}${tapPart}`)
	lines.push("")

	/* group routes by path */
	const byPath = new Map<string, Array<{ handler: RouteHandler; method: string }>>()
	for (const { handler, method, path } of collected) {
		let group = byPath.get(path)
		if (!group) {
			group = []
			byPath.set(path, group)
		}
		group.push({ handler, method: method.toLowerCase() })
	}

	/* emit RouteSelector union from route graph */
	const selectors = new Set<string>()
	for (const { handler, method, path } of collected) {
		if (handler._skip || isMetaInternal(handler)) continue
		selectors.add(`${method} ${path}`)
	}
	if (selectors.size > 0) {
		const sorted = [...selectors].sort()
		lines.push(`export type RouteSelector = ${sorted.map((s) => JSON.stringify(s)).join(" | ")}`)
		lines.push("")
		/* augment the module consumers import — an augmentation of any other name silently applies to nothing */
		lines.push('declare module "@lovrozagar/honey" {')
		lines.push("\tinterface HoneyCodegen {")
		lines.push(`\t\trouteSelector: RouteSelector`)
		lines.push("\t}")
		lines.push("}")
		lines.push("")
	}

	/* deduplicate per-route middleware additions into named types,
	 * with sub-property dedup for large repeated property types (e.g. Drizzle DB schemas) */
	const mwTypeMap = new Map<string, string>()
	let mwTypeCounter = 0

	/* use structured property data from type-extractor for sub-type dedup */
	const routeProps = options.routeMiddlewareProps
	const propTypeCount = new Map<string, number>()
	if (routeProps) {
		for (const props of Object.values(routeProps)) {
			for (const prop of props) {
				if (prop.type.length >= 512) {
					propTypeCount.set(prop.type, (propTypeCount.get(prop.type) ?? 0) + 1)
				}
			}
		}
	}

	/* emit shared sub-type aliases for duplicated property types */
	const subTypeMap = new Map<string, string>()
	let subTypeCounter = 0
	for (const [typeStr, count] of propTypeCount) {
		if (count >= 2) {
			const alias = `_MW${subTypeCounter++}`
			subTypeMap.set(typeStr, alias)
			lines.push(`type ${alias} = ${typeStr}`)
			lines.push("")
		}
	}

	function buildMwType(method: string, path: string): string | undefined {
		const key = `${method} ${path}`
		const props = routeProps && Object.hasOwn(routeProps, key) ? routeProps[key] : undefined
		if (props?.length) {
			const entries = props.map((p) => {
				const typeStr = subTypeMap.get(p.type) ?? p.type
				return `${p.name}${p.opt ? "?" : ""}: ${typeStr}`
			})
			return `{ ${entries.join("; ")} }`
		}
		/* fallback to raw string if no structured data */
		return resolveRouteMiddleware(options.routeMiddleware, method, path)
	}

	function dedupeRouteMiddleware(method: string, path: string): string | undefined {
		const mwType = buildMwType(method, path)
		if (!mwType) return undefined
		let alias = mwTypeMap.get(mwType)
		if (!alias) {
			alias = `MwCtx${mwTypeCounter++}`
			mwTypeMap.set(mwType, alias)
			lines.push(`type ${alias} = ${mwType}`)
			lines.push("")
		}
		return alias
	}

	/* pre-scan all routes to emit deduplicated middleware types before Routes */
	for (const [path, methods] of byPath) {
		for (const { method } of methods) {
			dedupeRouteMiddleware(method, path)
		}
	}

	const emitState = createTypeEmitState()
	const routesLines: string[] = []
	routesLines.push("export type Routes = {")

	for (const [path, methods] of byPath) {
		routesLines.push(`\t${JSON.stringify(path)}: {`)
		for (const { handler, method } of methods) {
			const mwType = buildMwType(method, path)
			const mwAlias = mwType ? mwTypeMap.get(mwType) : undefined
			const basePart = mwAlias ? `${baseCtxName} & ${mwAlias}` : baseCtxName
			const additions: string[] = []
			const inputType = emitInputType(handler, emitState)
			if (inputType !== "{}") additions.push(`input: ${inputType}`)
			/* the names ctx.params carries at runtime — an unnamed wildcard is "*" */
			const params = patternParams(parsePattern(path))
			if (params.length > 0) {
				const paramEntries = params.map((p) => `${quoteKey(p)}: string`).join("; ")
				additions.push(`readonly params: { ${paramEntries} }`)
			}
			const errorsCtx = emitErrorsCtxType(handler)
			if (errorsCtx) additions.push(errorsCtx)
			const ctxType = additions.length === 0 ? basePart : `${basePart} & { ${additions.join("; ")} }`
			const errorType = emitErrorType(handler)
			const metaType = emitMetaType(handler)
			const outputType = emitOutputType(handler, emitState)
			routesLines.push(`\t\t${quoteKey(method)}: {`)
			routesLines.push(`\t\t\tctx: WithOutput<${ctxType}, ${outputType}>`)
			routesLines.push(`\t\t\terrors: ${errorType}`)
			/* a mounted sub-app's route keeps its own error factory */
			const routeFactory = (handler.fac as Record<string, () => HoneyError> | null | undefined) ?? factory
			const routeErrorMeta = routeFactory === factory ? errorMeta : getErrorMeta(routeFactory)
			const shapesType = emitErrorShapes(handler, routeErrorMeta, emitState)
			if (shapesType) {
				routesLines.push(`\t\t\terrorShapes: ${shapesType}`)
				const byStatusType = emitErrorsByStatus(handler, routeErrorMeta, routeFactory, emitState)
				if (byStatusType) {
					routesLines.push(`\t\t\terrorsByStatus: ${byStatusType}`)
				}
			}
			routesLines.push(`\t\t\tinput: ${inputType}`)
			routesLines.push(`\t\t\tmeta: ${metaType}`)
			routesLines.push(`\t\t\toutput: ${outputType}`)
			routesLines.push("\t\t}")
		}
		routesLines.push("\t}")
	}
	routesLines.push("}")
	routesLines.push("")

	for (const [name, body] of emitState.aliases) {
		lines.push(`type ${name} = ${body}`)
		lines.push("")
	}
	lines.push(...routesLines)

	/* route-specific type extractors — services use these instead of typeof app */
	lines.push("export type RouteCtx<")
	lines.push("\tTPath extends keyof Routes,")
	lines.push("\tTMethod extends keyof Routes[TPath] & string")
	lines.push("> = Routes[TPath][TMethod] extends { ctx: infer C } ? C : never")
	lines.push("")
	lines.push("export type RouteInput<")
	lines.push("\tTPath extends keyof Routes,")
	lines.push("\tTMethod extends keyof Routes[TPath] & string")
	lines.push("> = Routes[TPath][TMethod] extends { input: infer I } ? I : never")
	lines.push("")
	lines.push("export type RouteOutput<")
	lines.push("\tTPath extends keyof Routes,")
	lines.push("\tTMethod extends keyof Routes[TPath] & string")
	lines.push("> = Routes[TPath][TMethod] extends { output: infer O } ? O : never")
	lines.push("")
	lines.push("export type RouteErrors<")
	lines.push("\tTPath extends keyof Routes,")
	lines.push("\tTMethod extends keyof Routes[TPath] & string")
	lines.push("> = Routes[TPath][TMethod] extends { errors: infer E } ? E : never")
	lines.push("")
	lines.push("export type RouteErrorShapes<")
	lines.push("\tTPath extends keyof Routes,")
	lines.push("\tTMethod extends keyof Routes[TPath] & string")
	lines.push("> = Routes[TPath][TMethod] extends { errorShapes: infer S } ? S : never")
	lines.push("")
	lines.push("export type RouteErrorsByStatus<")
	lines.push("\tTPath extends keyof Routes,")
	lines.push("\tTMethod extends keyof Routes[TPath] & string")
	lines.push("> = Routes[TPath][TMethod] extends { errorsByStatus: infer S } ? S : never")
	lines.push("")
	lines.push("export type RouteMeta<")
	lines.push("\tTPath extends keyof Routes,")
	lines.push("\tTMethod extends keyof Routes[TPath] & string")
	lines.push("> = Routes[TPath][TMethod] extends { meta: infer M } ? M : never")
	lines.push("")

	return lines.join("\n")
}

/* ---- OpenAPI spec utilities ---- */

export type OpenApiSpecInput = {
	components?: {
		schemas?: Record<string, Record<string, unknown>>
		securitySchemes?: Record<string, unknown>
	}
	info: { title: string; version: string }
	openapi: string
	paths: Record<string, Record<string, Record<string, unknown>>>
}

export function mergeSpecs(...specs: OpenApiSpecInput[]): OpenApiSpecInput {
	const merged: OpenApiSpecInput = {
		info: specs[0]?.info ?? { title: "", version: "" },
		openapi: specs[0]?.openapi ?? "3.1.0",
		paths: {},
	}

	let mergedComponents: OpenApiSpecInput["components"] | undefined

	for (const spec of specs) {
		for (const [path, methods] of Object.entries(spec.paths)) {
			if (merged.paths[path] === undefined) {
				merged.paths[path] = {}
			}
			for (const [method, operation] of Object.entries(methods)) {
				if (merged.paths[path][method] !== undefined) {
					throw new Error(`Merge conflict: duplicate ${method.toUpperCase()} ${path}`)
				}
				merged.paths[path][method] = operation
			}
		}

		if (spec.components) {
			if (!mergedComponents) mergedComponents = {}

			if (spec.components.schemas) {
				if (!mergedComponents.schemas) mergedComponents.schemas = {}
				for (const [name, schema] of Object.entries(spec.components.schemas)) {
					if (mergedComponents.schemas[name] !== undefined) {
						/* allow identical schemas (same content-hash name from same app) */
						if (canonicalizeSchema(mergedComponents.schemas[name]) !== canonicalizeSchema(schema)) {
							throw new Error(`Merge conflict: duplicate component schema "${name}"`)
						}
					} else {
						mergedComponents.schemas[name] = schema
					}
				}
			}

			if (spec.components.securitySchemes) {
				if (!mergedComponents.securitySchemes) mergedComponents.securitySchemes = {}
				for (const [name, scheme] of Object.entries(spec.components.securitySchemes)) {
					mergedComponents.securitySchemes[name] = scheme
				}
			}
		}
	}

	if (mergedComponents) merged.components = mergedComponents
	return merged
}

export function scopeSpec(
	spec: OpenApiSpecInput,
	filter: {
		excludeTags?: string[]
		operationIds?: string[]
		pathPrefix?: string
		tags?: string[]
	},
): OpenApiSpecInput {
	const result: OpenApiSpecInput = {
		info: spec.info,
		openapi: spec.openapi,
		paths: {},
	}

	const hasFilter =
		filter.tags !== undefined ||
		filter.excludeTags !== undefined ||
		filter.pathPrefix !== undefined ||
		filter.operationIds !== undefined

	if (spec.components) result.components = spec.components

	if (!hasFilter) {
		result.paths = { ...spec.paths }
		return result
	}

	for (const [path, methods] of Object.entries(spec.paths)) {
		if (filter.pathPrefix && !path.startsWith(filter.pathPrefix)) continue

		for (const [method, operation] of Object.entries(methods)) {
			const op = operation as Record<string, unknown>
			const opTags = (op.tags ?? []) as string[]
			const opId = op.operationId as string | undefined

			if (filter.tags && !opTags.some((t) => filter.tags?.includes(t))) continue
			if (filter.excludeTags && opTags.some((t) => filter.excludeTags?.includes(t))) continue
			if (filter.operationIds && (!opId || !filter.operationIds.includes(opId))) continue

			if (result.paths[path] === undefined) {
				result.paths[path] = {}
			}
			result.paths[path][method] = operation
		}
	}

	return result
}

/* ---- SDK generation ---- */

type ServiceEntry = {
	idempotent?: boolean
	invalidate?: string[]
	method: string
	params?: string[]
	path: string
	realtime?: boolean
	ws?: boolean
	sse?: boolean
	/** The path param that is a wildcard: its value may span segments */
	wildcard?: string
}

type NestedServiceNode =
	| { kind: "leaf"; entry: ServiceEntry }
	| { kind: "ns"; children: Map<string, NestedServiceNode> }

type GeneratedSDK = {
	files: {
		client: string
		index: string
		map: string
		runtime: string | null
		types: string
	}
	serviceMap: Record<string, Record<string, ServiceEntry>>
}

type SDKMethod = {
	action: string
	errorsByStatusType: string | null
	/** Full operationId (explicit or derived) */
	id: string
	inputHasMandatory: boolean
	inputType: string
	realtime: boolean
	resource: string
	responseType: string
	sse: boolean
	ws: boolean
}

export function extractOpenApiPathParams(path: string): string[] {
	const params: string[] = []
	/* any name between braces — `{user-id}` is one parameter, not `{user}` and a literal `-id` */
	const re = /\{([^{}/]+)\}/g
	let match: RegExpExecArray | null = re.exec(path)
	while (match !== null) {
		params.push(match[1])
		match = re.exec(path)
	}
	return params
}

export function isSSEOperation(operation: Record<string, unknown>): boolean {
	const responses = operation.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return false
	for (const response of Object.values(responses)) {
		const content = response.content as Record<string, unknown> | undefined
		if (content && "text/event-stream" in content) return true
	}
	return false
}

/** JSON Schema → TypeScript type string (shim — delegates to IR pipeline). */
export function jsonSchemaToTS(schema: Record<string, unknown> | undefined, depth = 0, binary = "string"): string {
	if (!schema || depth > 8) return "unknown"
	return irToTs(schemaToIR(schema), depth, binary)
}

/* a file part of a multipart body is sent as a Blob/File; the runtime appends it to FormData as is */
const FORM_BINARY_TS = "Blob"

/* the TS SDK input field a request body fills, by its media type */
function sdkBodyField(body: IRBody): "body" | "form" | "json" | null {
	if (body.kind === "stream") return "body"
	if (body.kind === "multipart") return "form"
	const essence = mediaEssence(body.contentType)
	if (isJsonMedia(body.contentType)) return "json"
	if (essence === "multipart/form-data" || essence === "application/x-www-form-urlencoded") return "form"
	return null
}

/* extract input type for an operation */
function emitSDKInputType(op: IROperation): { hasMandatory: boolean; type: string } {
	const mandatoryParts: string[] = []
	const optionalParts: string[] = []

	/* path params — always required */
	if (op.params.path.length > 0) {
		const entries = op.params.path.map((p) => `${sdkSafeName(p.name)}: ${irToTs(p.schema)}`).join("; ")
		mandatoryParts.push(`params: { ${entries} }`)
	}

	/* query params */
	if (op.params.query.length > 0) {
		const entries = op.params.query
			.slice()
			.sort((a, b) => compareCodeUnits(a.name, b.name))
			.map((p) => `${sdkSafeName(p.name)}${p.required === true ? "" : "?"}: ${irToTs(p.schema)}`)
		const searchEntry = `search: { ${entries.join("; ")} }`
		if (op.params.query.some((p) => p.required === true)) mandatoryParts.push(searchEntry)
		else optionalParts.push(searchEntry)
	}

	/* header and cookie params — typed on top of the free-form per-call `headers` / `cookies` */
	for (const [declared, field] of [
		[op.params.header, "headers"],
		[op.params.cookie ?? [], "cookies"],
	] as const) {
		if (declared.length === 0) continue
		const entries = declared
			.slice()
			.sort((a, b) => compareCodeUnits(a.name, b.name))
			.map((p) => {
				/* sent as text: a header or cookie value is a string on the wire */
				const tsType = p.schema.kind === "scalar" && p.schema.enum ? irToTs(p.schema) : "string"
				return `${quoteKey(p.name)}${p.required === true ? "" : "?"}: ${tsType}`
			})
		const entry = `${field}: { ${entries.join("; ")} }`
		if (declared.some((p) => p.required === true)) mandatoryParts.push(entry)
		else optionalParts.push(entry)
	}

	/* request body: one input field per kind; the preferred content type of each kind wins */
	const byField = new Map<string, IRBody>()
	for (const body of bodiesOf(op)) {
		const field = sdkBodyField(body)
		if (field && !byField.has(field)) byField.set(field, body)
	}
	/* raw bytes first, then json, then form: the order the fields always had */
	for (const field of ["body", "json", "form"] as const) {
		const body = byField.get(field)
		if (!body) continue
		let entry: string
		if (field === "body") entry = "body: ReadableStream<Uint8Array> | Blob | ArrayBuffer | Uint8Array"
		else if (field === "json") entry = `json: ${body.kind === "raw" ? irToTs(body.schema) : "unknown"}`
		else {
			const schema = body.kind === "raw" ? body.schema : body.kind === "multipart" ? body.schema : undefined
			entry = `form: ${schema ? irToTs(schema, 0, FORM_BINARY_TS) : "Record<string, unknown>"}`
		}
		if (body.required) mandatoryParts.push(entry)
		else optionalParts.push(entry)
	}

	const allParts = [...mandatoryParts, ...optionalParts]
	const type = allParts.length === 0 ? "{}" : `{ ${allParts.join("; ")} }`
	return { hasMandatory: mandatoryParts.length > 0, type }
}

/* extract response type for an operation */
function emitSDKResponseType(op: IROperation): string {
	/* SSE — shape mirrors runtime _SSEEvent (event/id/retry all optional) */
	if (op.extensions.sse) return "AsyncIterable<{ data: string; event?: string; id?: string; retry?: number }>"

	/* collect success response types (2xx) — `default` and `4XX`-style keys are never success */
	const successTypes: string[] = []
	for (const [status, response] of Object.entries(op.responses)) {
		if (!/^2(?:[0-9][0-9]|XX)$/i.test(status)) continue
		const code = /^2XX$/i.test(status) ? 200 : Number(status)
		if (code === 204 || code === 205 || !response.contentType) {
			successTypes.push("null")
			continue
		}
		/* the same classes the runtime's body parser reads: JSON, text, otherwise bytes */
		if (isJsonMedia(response.contentType)) {
			successTypes.push(response.schema ? irToTs(response.schema) : "unknown")
		} else if (isTextMedia(response.contentType)) {
			successTypes.push("string")
		} else {
			successTypes.push("ArrayBuffer")
		}
	}

	if (successTypes.length === 0) return "void"
	return [...new Set(successTypes)].join(" | ")
}

/* detect whether a JSON schema matches the standard error envelope shape */
export function isStandardErrEnvelope(schema: Record<string, unknown>): { keys: string[]; status: number } | null {
	const props = schema.properties as Record<string, Record<string, unknown>> | undefined
	if (!props) return null

	const successConst = props.success?.const
	if (successConst !== false) return null

	const msg = props.message as Record<string, unknown> | undefined
	if (msg?.type !== "string") return null
	const sk = props.status_key as Record<string, unknown> | undefined
	if (sk?.type !== "string") return null

	const fieldsSchema = props.fields as Record<string, unknown> | undefined
	if (fieldsSchema?.type !== "object") return null
	const addl = fieldsSchema?.additionalProperties as Record<string, unknown> | undefined
	if (addl?.type !== "array") return null
	const itemSchema = addl?.items as Record<string, unknown> | undefined
	if (itemSchema?.type !== "object") return null
	const itemProps = itemSchema?.properties as Record<string, Record<string, unknown>> | undefined
	for (const k of ["error_key", "message", "path"] as const) {
		if (itemProps?.[k]?.type !== "string") return null
	}

	const statusEnum = props.status?.enum as unknown[] | undefined
	if (!Array.isArray(statusEnum) || statusEnum.length !== 1) return null
	const statusVal = statusEnum[0]
	if (typeof statusVal !== "number") return null

	const errKeyEnum = props.error_key?.enum as unknown[] | undefined
	if (!Array.isArray(errKeyEnum) || errKeyEnum.length === 0) return null
	if (!errKeyEnum.every((k) => typeof k === "string")) return null

	return { keys: errKeyEnum as string[], status: statusVal }
}

/* extract error types by status code for an operation (non-2xx responses) */
function emitSDKErrorsByStatusType(op: IROperation, resolve: (schema: IRSchema) => IRSchema): string | null {
	const entries: string[] = []
	for (const [status, response] of Object.entries(op.responses)) {
		/* only concrete error statuses: `default` and `4XX` have no single status to key on */
		if (!/^[45][0-9][0-9]$/.test(status)) continue
		if (!response.schema || !response.contentType || !isJsonMedia(response.contentType)) continue
		const code = Number(status)
		const envelope = irErrorEnvelope(response.schema, resolve)
		if (envelope) {
			const keyUnion = envelope.keys.map((k) => JSON.stringify(k)).join(" | ")
			entries.push(`${code}: _ErrEnvelope<${envelope.status}, ${keyUnion}>`)
		} else {
			entries.push(`${code}: ${irToTs(response.schema)}`)
		}
	}

	if (entries.length === 0) return null
	return `{ ${entries.join("; ")} }`
}

/*
 * Whether a response type string is worth hoisting into a `_Res\d` alias.
 * Skip primitives, void/null, ArrayBuffer, and plain strings — only object or
 * array shapes benefit from dedupe.
 */
function isHoistableResponseType(t: string): boolean {
	if (!t) return false
	if (t === "void" || t === "null" || t === "string" || t === "ArrayBuffer") return false
	const head = t.trimStart()[0]
	return head === "{" || head === "["
}

function buildMethodSig(
	m: SDKMethod,
	inpAliases: Map<string, string>,
	errAliases: Map<string, string>,
	resAliases: Map<string, string>,
): { inputArg: string; returnType: string } {
	let suffixType: string
	if (m.ws) suffixType = "_WsOpts"
	else if (m.sse) suffixType = "_SseOpts"
	else suffixType = "_HttpOpts"
	const inpAlias = inpAliases.get(m.inputType)
	const resolvedInp = inpAlias ? `_Expand<${inpAlias}>` : m.inputType
	const fullInputType = resolvedInp === "{}" ? suffixType : `${resolvedInp} & ${suffixType}`
	const inputArg = `${m.inputHasMandatory ? "input" : "input?"}: ${fullInputType}`
	let resolvedErr: string | null = null
	if (m.errorsByStatusType) {
		const errAlias = errAliases.get(m.errorsByStatusType)
		resolvedErr = errAlias ? `_Expand<${errAlias}>` : m.errorsByStatusType
	}
	const resAlias = resAliases.get(m.responseType)
	const resolvedRes = resAlias ? `_Expand<${resAlias}>` : m.responseType
	let returnType: string
	if (m.ws) returnType = "TypedWebSocket"
	else if (m.sse) returnType = m.responseType
	else if (resolvedErr)
		returnType = `TThrow extends true ? Promise<${resolvedRes}> : Promise<SDKResult<${resolvedRes}, ${resolvedErr}>>`
	else returnType = `TThrow extends true ? Promise<${resolvedRes}> : Promise<SDKResult<${resolvedRes}>>`
	return { inputArg, returnType }
}

function buildTypeAliases(
	types: string[],
	prefix: string,
	minCount: number,
): { aliases: Map<string, string>; lines: string[] } {
	const counts = new Map<string, number>()
	for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1)
	const aliases = new Map<string, string>()
	const lines: string[] = []
	let idx = 0
	for (const [typeStr, count] of [...counts.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
		if (count >= minCount || typeStr.length > 200) {
			const alias = `${prefix}${idx++}`
			aliases.set(typeStr, alias)
			lines.push(`type ${alias} = ${typeStr}`)
		}
	}
	return { aliases, lines }
}

/* TS reserved words that must be quoted when used as object/interface property keys */
const SDK_TS_RESERVED = new Set([
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"let",
	"static",
	"implements",
	"interface",
	"package",
	"private",
	"protected",
	"public",
	"abstract",
	"as",
	"async",
	"await",
	"constructor",
	"declare",
	"from",
	"get",
	"infer",
	"is",
	"keyof",
	"module",
	"namespace",
	"never",
	"of",
	"readonly",
	"require",
	"set",
	"satisfies",
	"symbol",
	"type",
	"unique",
	"unknown",
	"override",
])

function sdkSafeName(name: string): string {
	if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) || SDK_TS_RESERVED.has(name)) {
		return JSON.stringify(name)
	}
	return name
}

function buildSDKTypes(
	sdkName: string,
	sdkMethods: SDKMethod[],
	tree: IRNamespace,
	methodLookup: Map<string, SDKMethod>,
): string {
	const n = sdkName
	const l: string[] = []

	/* shared error aliases (reduce repetition for standard envelope shape) */
	l.push("type _ErrField = { error_key: string; message: string; path: string }")
	l.push("type _ErrEnvelope<TStatus extends number, TKey extends string> = {")
	l.push("\terror_key: TKey")
	l.push("\tfields: Record<string, _ErrField[]>")
	l.push("\tmessage: string")
	l.push("\tstatus: TStatus")
	l.push("\tstatus_key: string")
	l.push("\tsuccess: false")
	l.push("}")
	l.push("")

	/* dedupe repeated errorsByStatusType strings — the primary source of file bloat */
	const { aliases: errAliases, lines: errLines } = buildTypeAliases(
		sdkMethods.flatMap((m) => (m.errorsByStatusType ? [m.errorsByStatusType] : [])),
		"_Errs",
		2,
	)
	if (errLines.length > 0) {
		for (const line of errLines) l.push(line)
		l.push("")
	}

	/*
	 * Dedupe response type shapes used by non-SSE/WS methods. Each method inlines
	 * its response type TWICE (throw branch + safe branch), so hoisting once per
	 * shape roughly halves the per-method cost. Hoist when count >= 2 OR when a
	 * single literal is long enough (>200 chars) to dominate the line.
	 */
	const { aliases: resAliases, lines: resLines } = buildTypeAliases(
		sdkMethods.filter((m) => !m.ws && !m.sse && isHoistableResponseType(m.responseType)).map((m) => m.responseType),
		"_Res",
		2,
	)
	const { aliases: inpAliases, lines: inpLines } = buildTypeAliases(
		sdkMethods.filter((m) => m.inputType !== "{}" && isHoistableResponseType(m.inputType)).map((m) => m.inputType),
		"_Inp",
		2,
	)

	if (resLines.length > 0 || errAliases.size > 0 || inpLines.length > 0) {
		/*
		 * _Expand forces TS to eagerly resolve aliases in hover tooltips. Without
		 * it, `const b = await sdk.x.y(...)` would show `SDKResult<_Res33, _Errs0>`
		 * instead of the full shape. The mapped type + `& {}` intersection is a
		 * well-known trick: TS evaluates the mapped type for display but keeps the
		 * emitted reference compact, so byte-dedupe is preserved. Two levels deep
		 * so error records (`{ 400: _ErrEnvelope<...>; ... }`) expand their
		 * envelope instantiations too, not just the top-level status keys.
		 */
		l.push("type _ExpandShallow<T> = T extends object ? { [K in keyof T]: T[K] } & {} : T")
		l.push("type _Expand<T> = T extends object ? { [K in keyof T]: _ExpandShallow<T[K]> } & {} : T")
		for (const line of resLines) l.push(line)
		for (const line of inpLines) l.push(line)
		l.push("")
	}

	/* SDKResult — typed branch trusts TErrorsByStatus to cover every error status (no unknown fallback) */
	l.push("export type SDKResult<T, TErrorsByStatus = never> =")
	l.push("\t| { data: T; error: null; response: Response; status: number }")
	l.push("\t| ([TErrorsByStatus] extends [never]")
	l.push("\t\t? { data: null; error: unknown; response: Response; status: number }")
	l.push(
		"\t\t: { [S in keyof TErrorsByStatus & number]: { data: null; error: TErrorsByStatus[S]; response: Response; status: S } }[keyof TErrorsByStatus & number])",
	)
	l.push("")

	/* TypedWebSocket */
	l.push("export type TypedWebSocket = {")
	l.push("\tclose(code?: number, reason?: string): void")
	l.push('\toff(event: "close" | "error" | "message" | "open", handler: (...args: never[]) => void): void')
	l.push('\ton(event: "close", handler: (code: number, reason: string) => void): void')
	l.push('\ton(event: "error", handler: (error: unknown) => void): void')
	l.push('\ton(event: "message", handler: (data: string) => void): void')
	l.push('\ton(event: "open", handler: () => void): void')
	l.push("\treadonly readyState: number")
	l.push("\tsend(data: ArrayBuffer | ArrayBufferView | object | string): void")
	l.push("}")
	l.push("")

	/* config type */
	l.push(`export type ${n}Config<TThrow extends boolean = false> = {`)
	l.push("\tbaseURL: string")
	l.push("\tbuildSearchParams?: (query: Record<string, unknown>) => URLSearchParams")
	l.push("\tcredentials?: RequestCredentials")
	l.push("\tfetch?: typeof fetch")
	l.push(
		`\theaders?: Record<string, string> | ((ctx: { method: string; path: string }) => Record<string, string | undefined> | Promise<Record<string, string | undefined>>)`,
	)
	l.push("\tinvalidation?: { maxSourcesPerTarget?: number; staleMaxEntries?: number; staleTime: number }")
	l.push("\tmaxErrorMessageChars?: number")
	l.push("\tmode?: RequestMode")
	l.push(
		`\tonRequest?: Array<(ctx: { body?: BodyInit; headers: Headers; invalidatedBy?: string[]; isStale?: boolean; method: string; path: string; selector?: string; state: Record<string, unknown>; url: string }) => void | Promise<void>>`,
	)
	l.push(
		`\tonResponse?: Array<(ctx: { invalidatedBy?: string[]; isRetry: boolean; isStale?: boolean; method: string; path: string; request: Request; response: Response; retry: () => Promise<Response>; selector?: string; state: Record<string, unknown>; url: string }) => Response | undefined | Promise<Response | undefined>>`,
	)
	l.push("\tonAuthExpired?: (ctx: { rejectedToken: string | null }) => Promise<string | null>")
	l.push("\tauthHeaderName?: string")
	l.push("\tauthHeaderPrefix?: string")
	l.push("\tonLog?: (entry: _LogEntry) => void")
	l.push('\tredirect?: "error" | "follow" | "manual" | "same-origin"')
	l.push("\tsortSearchParams?: boolean")
	l.push("\tsseMaxBufferChars?: number")
	l.push("\tstate?: Record<string, unknown>")
	l.push("\tthrowOnError?: TThrow")
	l.push("\ttimeout?: number")
	l.push("}")
	l.push("")
	l.push(
		`export type _LogEntry = { level: "debug" | "info" | "warn" | "error"; event: "request_start" | "response_received" | "error" | "hook_executed"; operation: string; duration_ms: number; status?: number; error?: unknown }`,
	)
	l.push(
		"export type _HttpOpts = { cookies?: Record<string, string>; headers?: Record<string, string>; idempotencyKey?: string; signal?: AbortSignal; timeout?: number }",
	)
	l.push(
		"export type _SseOpts = { cookies?: Record<string, string>; headers?: Record<string, string>; lastEventId?: string; signal?: AbortSignal; timeout?: number }",
	)
	l.push("export type _WsOpts = { protocols?: string | string[]; reconnectToken?: string }")
	l.push("")

	/* recursive interface emitter — walks IRNamespace tree */
	function emitNsInterface(ns: IRNamespace, indent: string): void {
		const methods = methodsOf(ns)
		const namespaces = namespacesOf(ns)

		for (const [name, op] of methods) {
			const m = methodLookup.get(op.id)
			if (!m) continue
			/* #R6-27: single _call action → promote resource to callable at top level */
			if (name === "_call") continue /* handled by namespace _call promotion below */
			const { inputArg, returnType } = buildMethodSig(m, inpAliases, errAliases, resAliases)
			l.push(`${indent}${sdkSafeName(name)}(${inputArg}): ${returnType}`)
		}

		for (const [name, childNs] of namespaces) {
			const childMethods = methodsOf(childNs)
			/* #R6-27: single _call method in namespace → promote namespace to callable */
			if (childMethods.length === 1 && childMethods[0] && childMethods[0][0] === "_call") {
				const [, op] = childMethods[0]
				const m = methodLookup.get(op.id)
				if (m) {
					const { inputArg, returnType } = buildMethodSig(m, inpAliases, errAliases, resAliases)
					l.push(`${indent}${sdkSafeName(name)}(${inputArg}): ${returnType}`)
					continue
				}
			}
			l.push(`${indent}${sdkSafeName(name)}: {`)
			emitNsInterface(childNs, `${indent}\t`)
			l.push(`${indent}}`)
		}
	}

	l.push(`export interface ${n}<TThrow extends boolean = false> {`)
	l.push("\tstate: Record<string, unknown>")
	l.push("\tdispose(): void")
	emitNsInterface(tree, "\t")
	l.push("}")
	l.push("")

	return l.join("\n")
}

function emitNestedMapNode(node: NestedServiceNode, indent: string): string[] {
	if (node.kind === "leaf") {
		const entry = node.entry
		const parts = [`method: ${JSON.stringify(entry.method)}`, `path: ${JSON.stringify(entry.path)}`]
		if (entry.params) parts.push(`params: ${JSON.stringify(entry.params)}`)
		if (entry.sse) parts.push("sse: true")
		if (entry.wildcard) parts.push(`wildcard: ${JSON.stringify(entry.wildcard)}`)
		if (entry.ws) parts.push("ws: true")
		if (entry.idempotent) parts.push("idempotent: true")
		if (entry.invalidate) parts.push(`invalidate: ${JSON.stringify(entry.invalidate)}`)
		return [`{ ${parts.join(", ")} }`]
	}
	const lines: string[] = ["{"]
	for (const [key, child] of [...node.children.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
		const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
		const childLines = emitNestedMapNode(child, `${indent}\t`)
		if (childLines.length === 1) {
			lines.push(`${indent}\t${safeKey}: ${childLines[0]},`)
		} else {
			lines.push(`${indent}\t${safeKey}: ${childLines[0]}`)
			for (let i = 1; i < childLines.length - 1; i++) lines.push(childLines[i] ?? "")
			lines.push(`${indent}\t${childLines[childLines.length - 1]},`)
		}
	}
	lines.push(`${indent}}`)
	return lines
}

function buildSDKMap(nestedMap: Map<string, NestedServiceNode>): string {
	const l: string[] = []

	l.push("export const serviceMap = {")
	for (const [key, node] of [...nestedMap.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
		const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : JSON.stringify(key)
		const childLines = emitNestedMapNode(node, "\t")
		if (childLines.length === 1) {
			l.push(`\t${safeKey}: ${childLines[0]},`)
		} else {
			l.push(`\t${safeKey}: ${childLines[0]}`)
			for (let i = 1; i < childLines.length - 1; i++) l.push(childLines[i] ?? "")
			l.push(`\t${childLines[childLines.length - 1]},`)
		}
	}
	l.push("} as const")
	l.push("")

	return l.join("\n")
}

function buildSDKIndex(sdkName: string, stem: string): string {
	const n = sdkName
	const l: string[] = []

	const errorNames = ERROR_EXPORT_NAMES.join(", ")
	l.push(`import { ${n} as _${n}Impl, ${errorNames} } from "./${stem}.client.gen"`)
	l.push(`import type { ${n} as _${n}Interface } from "./${stem}.types.gen"`)
	l.push("")
	l.push(`/* declaration merge: Proxy-based class acquires typed resource methods */`)
	l.push(`class ${n}<TThrow extends boolean = false> extends _${n}Impl<TThrow> {}`)
	l.push(`interface ${n}<TThrow extends boolean = false> extends _${n}Interface<TThrow> {}`)
	l.push("")
	l.push(`export { ${n}, ${errorNames} }`)
	l.push(`export { serviceMap } from "./${stem}.map.gen"`)
	l.push(`export type { ${n}Config, SDKResult, TypedWebSocket } from "./${stem}.types.gen"`)
	l.push("")

	return l.join("\n")
}

function buildSDKClient(sdkName: string, stem: string): string {
	const n = sdkName
	return [
		sdkClientHeader(n, stem),
		sdkClientTypes(),
		sdkClientClientError(),
		sdkClientClass(n),
		sdkClientConstructor(n),
		sdkClientProxy(n),
		sdkClientInterpolatePath(),
		sdkClientToColonParams(),
		sdkClientResolveInvalidationTargets(),
		sdkClientPathMatchesPattern(),
		sdkClientLookupStale(),
		sdkClientCreateTypedWebSocket(),
		sdkClientSerializeSearch(),
		sdkClientResolveBaseURL(),
		sdkClientBuildURL(),
		sdkClientNewRequestId(),
		sdkClientBuildHeaders(),
		sdkClientDoRequest(),
		sdkClientParseBody(),
		sdkClientParseErrorBody(),
		sdkClientParseAsClientError(),
		sdkClientBuildSignal(),
		sdkClientRequestThrow(),
		sdkClientRequestSafe(),
		sdkClientRequest(),
		sdkClientRequestSSE(),
		sdkClientConnectWS(),
		sdkClientBuildRequestMeta(),
		sdkClientMarkStale(),
		sdkClientClearStale(),
		sdkClientDispose(),
		sdkClientDoSSE(),
		sdkClientParseSSEBlock(),
		sdkClientFooter(),
	].join("")
}

function buildSDKRuntime(): string {
	return `/* ------------------------------------------------------------------ */
/*  ServerFrame (inlined from protocol — zero external imports)         */
/* ------------------------------------------------------------------ */

export type ServerFrame =
\t| { data: unknown; id: number; t: "msg" }
\t| { t: "pong" }
\t| { reason: string; t: "bye" }
\t| { reconnectToken: string; t: "ready" }

/* ------------------------------------------------------------------ */
/*  Error hierarchy                                                    */
/* ------------------------------------------------------------------ */

export class RealtimeError extends Error {
\treadonly reason: string

\tconstructor(message: string, reason: string) {
\t\tsuper(message)
\t\tthis.reason = reason
\t\tthis.name = "RealtimeError"
\t}
}

export class RealtimeConnectError extends RealtimeError {
\tconstructor(message: string, reason: string) {
\t\tsuper(message, reason)
\t\tthis.name = "RealtimeConnectError"
\t}
}

export class RealtimeAuthError extends RealtimeError {
\tconstructor(message: string, reason: string) {
\t\tsuper(message, reason)
\t\tthis.name = "RealtimeAuthError"
\t}
}

export class RealtimeKickedError extends RealtimeError {
\tconstructor(message: string, reason: string) {
\t\tsuper(message, reason)
\t\tthis.name = "RealtimeKickedError"
\t}
}

export class RealtimeAbortError extends RealtimeError {
\tconstructor(message: string, reason: string) {
\t\tsuper(message, reason)
\t\tthis.name = "RealtimeAbortError"
\t}
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type Transport = "ws" | "sse" | "longpoll"
export type ConnectionState = "idle" | "connecting" | "connected" | "draining" | "reconnecting" | "closed"

export type TransportAdapter = {
\tconnect(url: string, opts: TransportOpts): TransportConnection
}

export type TransportConnection = {
\tsend(data: string): void
\tclose(): void
\tonFrame: (frame: ServerFrame) => void
\tonClose: (reason: string) => void
\tonError: (err: unknown) => void
}

export type TransportOpts = {
\tsignal?: AbortSignal
\theaders?: Record<string, string>
\tlastId?: number
\treconnectToken?: string
}

/* ------------------------------------------------------------------ */
/*  KeepaliveLoop                                                      */
/* ------------------------------------------------------------------ */

export function createKeepaliveLoop(opts: {
\ttransport: Transport
\tsendPing: () => void
\tonDead: () => void
\tinterval?: number
\ttimeout?: number
}): { start(): void; stop(): void; onPong(): void; onFrame(): void } {
\tconst interval = opts.interval ?? 25_000
\tconst timeout = opts.timeout ?? 60_000
\tconst transport = opts.transport

\tlet pingTimer: ReturnType<typeof setInterval> | null = null
\tlet deadTimer: ReturnType<typeof setTimeout> | null = null

\tfunction clearAll(): void {
\t\tif (pingTimer !== null) {
\t\t\tclearInterval(pingTimer)
\t\t\tpingTimer = null
\t\t}
\t\tif (deadTimer !== null) {
\t\t\tclearTimeout(deadTimer)
\t\t\tdeadTimer = null
\t\t}
\t}

\tfunction resetDeadTimer(): void {
\t\tif (deadTimer !== null) {
\t\t\tclearTimeout(deadTimer)
\t\t}
\t\tdeadTimer = setTimeout(() => {
\t\t\topts.onDead()
\t\t}, timeout)
\t}

\tfunction start(): void {
\t\tclearAll()
\t\tif (transport === "longpoll") return
\t\tif (transport === "ws") {
\t\t\tpingTimer = setInterval(() => {
\t\t\t\topts.sendPing()
\t\t\t}, interval)
\t\t\tresetDeadTimer()
\t\t\treturn
\t\t}
\t\tif (transport === "sse") {
\t\t\tresetDeadTimer()
\t\t}
\t}

\tfunction stop(): void {
\t\tclearAll()
\t}

\tfunction onPong(): void {
\t\tif (deadTimer !== null) {
\t\t\tresetDeadTimer()
\t\t}
\t}

\tfunction onFrame(): void {
\t\tif (transport === "sse" && deadTimer !== null) {
\t\t\tresetDeadTimer()
\t\t}
\t}

\treturn { onFrame, onPong, start, stop }
}

/* ------------------------------------------------------------------ */
/*  FallbackChain                                                      */
/* ------------------------------------------------------------------ */

const DEFAULT_FALLBACK_TIMEOUT = 3000

export function createFallbackChain(opts: {
\ttransports: TransportAdapter[]
\ttimeout?: number
}): {
\tconnect(url: string, transportOpts: TransportOpts): Promise<{ conn: TransportConnection; transport: Transport }>
\treadonly provenTransport: Transport | null
} {
\tconst timeout = opts.timeout ?? DEFAULT_FALLBACK_TIMEOUT
\tlet proven: Transport | null = null
\tlet provenIndexStore: number | null = null

\tfunction tryTransport(
\t\tadapter: TransportAdapter,
\t\turl: string,
\t\ttransportOpts: TransportOpts,
\t): Promise<TransportConnection> {
\t\treturn new Promise((resolve, reject) => {
\t\t\tconst conn = adapter.connect(url, transportOpts)

\t\t\tconst timer = setTimeout(() => {
\t\t\t\tconn.close()
\t\t\t\treject(new Error("timeout"))
\t\t\t}, timeout)

\t\t\tconst originalOnFrame = conn.onFrame
\t\t\tconn.onFrame = (frame: ServerFrame) => {
\t\t\t\tif (frame.t === "ready") {
\t\t\t\t\tclearTimeout(timer)
\t\t\t\t\tconn.onFrame = originalOnFrame
\t\t\t\t\tresolve(conn)
\t\t\t\t} else {
\t\t\t\t\toriginalOnFrame(frame)
\t\t\t\t}
\t\t\t}

\t\t\tconn.onError = (err: unknown) => {
\t\t\t\tclearTimeout(timer)
\t\t\t\tconn.close()
\t\t\t\treject(err)
\t\t\t}

\t\t\tconn.onClose = (reason: string) => {
\t\t\t\tclearTimeout(timer)
\t\t\t\treject(new Error(reason))
\t\t\t}
\t\t})
\t}

\tasync function connectInternal(
\t\turl: string,
\t\ttransportOpts: TransportOpts,
\t\ttransports: TransportAdapter[],
\t): Promise<{ conn: TransportConnection; transport: Transport }> {
\t\tif (proven !== null) {
\t\t\tif (provenIndexStore !== null && provenIndexStore < transports.length) {
\t\t\t\ttry {
\t\t\t\t\tconst conn = await tryTransport(transports[provenIndexStore], url, transportOpts)
\t\t\t\t\treturn { conn, transport: proven }
\t\t\t\t} catch {
\t\t\t\t\t/* Proven transport failed — fall through to full chain */
\t\t\t\t}
\t\t\t}
\t\t}

\t\tfor (let i = 0; i < transports.length; i++) {
\t\t\ttry {
\t\t\t\tconst conn = await tryTransport(transports[i], url, transportOpts)
\t\t\t\tlet transportName: Transport = "longpoll"
\t\t\t\tif (i === 0) transportName = "ws"
\t\t\t\telse if (i === 1) transportName = "sse"
\t\t\t\tproven = transportName
\t\t\t\tprovenIndexStore = i
\t\t\t\treturn { conn, transport: transportName }
\t\t\t} catch {
\t\t\t\t/* Try next */
\t\t\t}
\t\t}

\t\tthrow new RealtimeConnectError("All transports failed", "all_failed")
\t}

\tfunction connect(
\t\turl: string,
\t\ttransportOpts: TransportOpts,
\t): Promise<{ conn: TransportConnection; transport: Transport }> {
\t\tconst transports = opts.transports
\t\tif (transports.length === 0) {
\t\t\tconst p = Promise.reject(new RealtimeConnectError("No transports configured", "no_transports"))
\t\t\tp.catch(() => {})
\t\t\treturn p
\t\t}
\t\tconst p = connectInternal(url, transportOpts, transports)
\t\tp.catch(() => {})
\t\treturn p
\t}

\treturn {
\t\tconnect,
\t\tget provenTransport() {
\t\t\treturn proven
\t\t},
\t}
}

/* ------------------------------------------------------------------ */
/*  ResumableConnection                                                */
/* ------------------------------------------------------------------ */

export type ResumableConnectionOpts = {
\turl: string
\ttransports: TransportAdapter[]
\ttoken?: () => string | Promise<string>
\t/** 401 on a request: return a fresh token to retry it once (null = give up). \`rejectedToken\` is the token that failed, so concurrent 401s can share one refresh. */\n\tonAuthExpired?: (ctx: { rejectedToken: string | null }) => Promise<string | null>
\tonReconnecting?: (attempt: number, transport: Transport) => void
\tonReconnected?: () => void
\tsignal?: AbortSignal
\tkeepaliveInterval?: number
\treconnectDelayMs?: number
\tmaxReconnectAttempts?: number
\tfallbackTimeout?: number
\theaders?: Record<string, string>
\treconnectToken?: string
\tlastId?: number
}

type QueueEntry =
\t| { type: "value"; value: unknown }
\t| { type: "done" }
\t| { type: "error"; error: unknown }

export function createResumableConnection(opts: ResumableConnectionOpts): {
\treadonly state: ConnectionState
\treadonly provenTransport: Transport | null
\tsend(data: unknown): void
\tclose(reason?: string): void
\t[Symbol.asyncIterator](): AsyncIterableIterator<unknown>
} {
\tconst reconnectDelayMs = opts.reconnectDelayMs ?? 1000
\tconst maxReconnectAttempts = opts.maxReconnectAttempts ?? 5
\tconst fallbackTimeout = opts.fallbackTimeout ?? 3000
\tlet state: ConnectionState = "idle"
\tlet currentConn: TransportConnection | null = null
\tlet reconnectAttempts = 0
\tlet provenIndex: number | null = null
\tlet lastId: number | undefined = opts.lastId
\tlet reconnectToken: string | undefined = opts.reconnectToken
\tlet started = false
\tlet closed = false

\tfunction indexToTransport(i: number): Transport {
\t\tif (i === 0) return "ws"
\t\tif (i === 1) return "sse"
\t\treturn "longpoll"
\t}

\tif (opts.signal?.aborted) {
\t\tstate = "closed"
\t\tclosed = true
\t}

\tconst queue: QueueEntry[] = []
\tlet pending: {
\t\tresolve: (result: IteratorResult<unknown>) => void
\t\treject: (err: unknown) => void
\t} | null = null

\tfunction enqueue(entry: QueueEntry): void {
\t\tif (pending) {
\t\t\tconst { resolve, reject } = pending
\t\t\tpending = null
\t\t\tif (entry.type === "value") {
\t\t\t\tresolve({ done: false, value: entry.value })
\t\t\t} else if (entry.type === "done") {
\t\t\t\tresolve({ done: true, value: undefined })
\t\t\t} else {
\t\t\t\treject(entry.error)
\t\t\t}
\t\t} else {
\t\t\tqueue.push(entry)
\t\t}
\t}

\tfunction detachConn(): void {
\t\tif (!currentConn) return
\t\tconst conn = currentConn
\t\tcurrentConn = null
\t\tconn.onFrame = () => {}
\t\tconn.onError = () => {}
\t\tconn.onClose = () => {}
\t\ttry {
\t\t\tconn.close()
\t\t} catch {
\t\t\t/* swallow — adapter close() is best-effort */
\t\t}
\t}

\tfunction handleClose(): void {
\t\tif (state === "closed") return
\t\tstate = "closed"
\t\tclosed = true
\t\tdetachConn()
\t\tenqueue({ type: "done" })
\t}

\tfunction handleAbort(): void {
\t\tif (state === "closed") return
\t\tstate = "closed"
\t\tclosed = true
\t\tdetachConn()
\t\tenqueue({ error: new RealtimeAbortError("Connection aborted", "aborted"), type: "error" })
\t}

\tif (opts.signal && !opts.signal.aborted) {
\t\topts.signal.addEventListener("abort", () => {
\t\t\thandleAbort()
\t\t}, { once: true })
\t}

\t/* tryAdapterAt dials a single adapter and wires its onFrame/onError/onClose
\t * straight into the resumable queue + reconnect loop the moment the adapter
\t * returns. No post-ready re-wire hop — frames that arrive between ready and
\t * the caller's await-continuation can't be lost. Resolves when ready frame
\t * seen, rejects on error/close/timeout. */
\tfunction tryAdapterAt(index: number): Promise<TransportConnection> {
\t\treturn new Promise((resolve, reject) => {
\t\t\tconst adapter = opts.transports[index]
\t\t\tif (!adapter) {
\t\t\t\treject(new RealtimeConnectError("adapter index out of range", "no_adapter"))
\t\t\t\treturn
\t\t\t}
\t\t\tconst transportOpts: TransportOpts = {
\t\t\t\theaders: opts.headers,
\t\t\t\tlastId,
\t\t\t\treconnectToken,
\t\t\t\tsignal: opts.signal,
\t\t\t}
\t\t\tconst conn = adapter.connect(opts.url, transportOpts)
\t\t\tlet ready = false
\t\t\tconst timer = setTimeout(() => {
\t\t\t\tif (ready) return
\t\t\t\ttry { conn.close() } catch { /* ignore */ }
\t\t\t\treject(new RealtimeConnectError("transport open timeout", "timeout"))
\t\t\t}, fallbackTimeout)
\t\t\tconn.onFrame = (frame: ServerFrame) => {
\t\t\t\tif (!ready && frame.t === "ready") {
\t\t\t\t\tready = true
\t\t\t\t\tclearTimeout(timer)
\t\t\t\t\treconnectToken = frame.reconnectToken
\t\t\t\t\tresolve(conn)
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tif (frame.t === "msg") {
\t\t\t\t\tlastId = frame.id
\t\t\t\t\tenqueue({ type: "value", value: frame.data })
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tif (frame.t === "ready") {
\t\t\t\t\treconnectToken = frame.reconnectToken
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tif (frame.t === "bye") {
\t\t\t\t\tif (ready) {
\t\t\t\t\t\tdetachConn()
\t\t\t\t\t\tscheduleReconnect(new RealtimeError("server closed connection: " + frame.reason, "bye"))
\t\t\t\t\t}
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t}
\t\t\tconn.onError = (err: unknown) => {
\t\t\t\tclearTimeout(timer)
\t\t\t\tif (!ready) {
\t\t\t\t\ttry { conn.close() } catch { /* ignore */ }
\t\t\t\t\treject(err)
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tdetachConn()
\t\t\t\tscheduleReconnect(err)
\t\t\t}
\t\t\tconn.onClose = (reason: string) => {
\t\t\t\tclearTimeout(timer)
\t\t\t\tif (!ready) {
\t\t\t\t\treject(new RealtimeConnectError("transport closed before ready: " + reason, "closed_early"))
\t\t\t\t\treturn
\t\t\t\t}
\t\t\t\tdetachConn()
\t\t\t\tscheduleReconnect(new RealtimeError("transport closed: " + reason, "closed"))
\t\t\t}
\t\t})
\t}

\tasync function openChain(): Promise<void> {
\t\tif (opts.transports.length === 0) {
\t\t\tthrow new RealtimeConnectError("No transports configured", "no_transports")
\t\t}
\t\t/* Try proven first if memoized */
\t\tif (provenIndex !== null && provenIndex < opts.transports.length) {
\t\t\ttry {
\t\t\t\tconst conn = await tryAdapterAt(provenIndex)
\t\t\t\tcurrentConn = conn
\t\t\t\treturn
\t\t\t} catch {
\t\t\t\t/* fall through to full chain */
\t\t\t}
\t\t}
\t\tlet lastErr: unknown = null
\t\tfor (let i = 0; i < opts.transports.length; i++) {
\t\t\ttry {
\t\t\t\tconst conn = await tryAdapterAt(i)
\t\t\t\tprovenIndex = i
\t\t\t\tcurrentConn = conn
\t\t\t\treturn
\t\t\t} catch (err) {
\t\t\t\tlastErr = err
\t\t\t}
\t\t}
\t\tthrow lastErr ?? new RealtimeConnectError("All transports failed", "all_failed")
\t}

\tfunction scheduleReconnect(_err: unknown): void {
\t\tif (closed) return
\t\treconnectAttempts += 1
\t\tif (maxReconnectAttempts > 0 && reconnectAttempts > maxReconnectAttempts) {
\t\t\tstate = "closed"
\t\t\tclosed = true
\t\t\tenqueue({ type: "done" })
\t\t\treturn
\t\t}
\t\tstate = "reconnecting"
\t\t/* invalidate proven — a drop means that transport isn't healthy */
\t\tprovenIndex = null
\t\tif (opts.onReconnecting) {
\t\t\ttry {
\t\t\t\topts.onReconnecting(reconnectAttempts, indexToTransport(provenIndex ?? 0))
\t\t\t} catch {
\t\t\t\t/* user callback must not break the loop */
\t\t\t}
\t\t}
\t\tsetTimeout(() => {
\t\t\tif (closed) return
\t\t\tvoid connectOnce()
\t\t}, reconnectDelayMs)
\t}

\tasync function connectOnce(): Promise<void> {
\t\tif (closed) return
\t\tif (state === "idle" || state === "closed") state = "connecting"
\t\ttry {
\t\t\tawait openChain()
\t\t\tif (closed) {
\t\t\t\tdetachConn()
\t\t\t\treturn
\t\t\t}
\t\t\tstate = "connected"
\t\t\treconnectAttempts = 0
\t\t\tif (opts.onReconnected) {
\t\t\t\ttry { opts.onReconnected() } catch { /* user cb */ }
\t\t\t}
\t\t} catch (err) {
\t\t\tscheduleReconnect(err)
\t\t}
\t}

\tfunction startConnection(): void {
\t\tif (started || closed) return
\t\tstarted = true
\t\tstate = "connecting"
\t\tvoid connectOnce()
\t}

\tfunction send(data: unknown): void {
\t\tif (closed || !currentConn) return
\t\tcurrentConn.send(JSON.stringify(data))
\t}

\tfunction close(_reason?: string): void {
\t\thandleClose()
\t}

\tfunction next(): Promise<IteratorResult<unknown>> {
\t\tif (!started && !closed) {
\t\t\tstartConnection()
\t\t}
\t\tif (queue.length > 0) {
\t\t\tconst entry = queue.shift()
\t\t\tif (!entry || entry.type === "done") {
\t\t\t\treturn Promise.resolve({ done: true, value: undefined })
\t\t\t}
\t\t\tif (entry.type === "value") {
\t\t\t\treturn Promise.resolve({ done: false, value: entry.value })
\t\t\t}
\t\t\treturn Promise.reject(entry.error)
\t\t}
\t\tif (closed) {
\t\t\treturn Promise.resolve({ done: true, value: undefined })
\t\t}
\t\tconst promise = new Promise<IteratorResult<unknown>>((resolve, reject) => {
\t\t\tpending = { reject, resolve }
\t\t})
\t\tpromise.catch(() => {})
\t\treturn promise
\t}

\tfunction asyncIterator(): AsyncIterableIterator<unknown> {
\t\treturn {
\t\t\tnext,
\t\t\t[Symbol.asyncIterator]() {
\t\t\t\treturn this
\t\t\t},
\t\t}
\t}

\treturn {
\t\t[Symbol.asyncIterator]: asyncIterator,
\t\tclose,
\t\tget provenTransport() {
\t\t\treturn provenIndex === null ? null : indexToTransport(provenIndex)
\t\t},
\t\tsend,
\t\tget state() {
\t\t\treturn state
\t\t},
\t}
}
`
}

function sdkClientHeader(n: string, stem: string): string {
	return `import type { ${n}Config } from "./${stem}.types.gen"
import { serviceMap } from "./${stem}.map.gen"
`
}

function sdkClientTypes(): string {
	return `
type _SSEEvent = { data: string; event?: string; id?: string; retry?: number }

type _TypedWebSocket = {
\tclose(code?: number, reason?: string): void
\toff(event: "close" | "error" | "message" | "open", handler: (...args: never[]) => void): void
\ton(event: "close", handler: (code: number, reason: string) => void): void
\ton(event: "error", handler: (error: unknown) => void): void
\ton(event: "message", handler: (data: string) => void): void
\ton(event: "open", handler: () => void): void
\treadonly readyState: number
\tsend(data: ArrayBuffer | ArrayBufferView | object | string): void
}

type _ServiceEntry = {
\tidempotent?: boolean
\tinvalidate?: readonly string[]
\tmethod: string
\tparams?: readonly string[]
\tpath: string
\tsse?: boolean
\twildcard?: string
\tws?: boolean
}

type _ServiceMapNode = _ServiceEntry | { [key: string]: _ServiceMapNode }
type _ServiceMap = { [key: string]: _ServiceMapNode }

type _RequestOptions = {
\tbody?: ReadableStream<Uint8Array> | Blob | ArrayBuffer | Uint8Array
\tcookies?: Record<string, string>
\tform?: Record<string, unknown>
\theaders?: Record<string, string>
\tidempotencyKey?: string
\tjson?: unknown
\tlastEventId?: string
\tparams?: Record<string, string>
\tprotocols?: string | string[]
\treconnectToken?: string
\tsearch?: Record<string, unknown>
\tsignal?: AbortSignal
\ttimeout?: number
}

type _RequestMeta = {
\tinvalidatedBy: string[]
\tisStale: boolean
\tselector: string
\tseqSnapshot: number
}

type _StaleEntry = { by: string[]; refreshed?: Set<string>; seq: number; until: number }

/* a path parameter value that would change the request's path once a URL parser normalizes it */
class _PathParamError extends Error {
\tconstructor(message: string) {
\t\tsuper(message)
\t\tthis.name = "PathParamError"
\t}
}
`
}

function sdkClientClientError(): string {
	const subclassDecls = STATUS_ERROR_CLASSES.map(
		({ name }) =>
			`class _${name} extends _ClientError { constructor(init: ConstructorParameters<typeof _ClientError>[0]) { super(init); this.name = "${name}" } }`,
	).join("\n")
	const mapEntries = STATUS_ERROR_CLASSES.map(({ name, status }) => `\t${status}: _${name},`).join("\n")
	return `
class _ClientError extends Error {
\treadonly body: unknown
\treadonly data: unknown
\treadonly response: Response
\treadonly status: number

\tconstructor(init: { body: unknown; data: unknown; message: string; response: Response; status: number }) {
\t\tsuper(init.message)
\t\t;(Error as unknown as { captureStackTrace?: (t: object, c: Function) => void }).captureStackTrace?.(this, _ClientError)
\t\tthis.name = "ClientError"
\t\tthis.body = init.body
\t\tthis.data = init.data
\t\tthis.response = init.response
\t\tthis.status = init.status
\t}
}

${subclassDecls}

const _STATUS_ERROR_MAP: Record<number, new (init: ConstructorParameters<typeof _ClientError>[0]) => _ClientError> = {
${mapEntries}
}
`
}

function sdkClientClass(n: string): string {
	return `
export class ${n}<TThrow extends boolean = false> {
\tstate: Record<string, unknown>
\t#config: ${n}Config<TThrow>
\t#fetchFn: typeof fetch
\t#resourceCache = new Map<string, Record<string, unknown>>()
\t#searchSerializer: (query: Record<string, unknown>) => URLSearchParams
\t#staleTime: number
\t#staleUntil: Map<string, _StaleEntry> | null
\t#stalePatterns = new Map<string, Map<string, _StaleEntry>>()
\t#patternRegexCache = new Map<string, RegExp>()
\t#invalidationSeq = 0
\t#staleMaxEntries: number
\t#maxSourcesPerTarget: number
\t#maxErrorMessageChars: number
\t#sseMaxBufferChars: number
\t#disposeCtrl = new AbortController()
\t#disposed = false
\t#refreshing: Promise<string | null> | null = null
\t#token: string | null = null
`
}

function sdkClientConstructor(n: string): string {
	return `
\tconstructor(config: ${n}Config<TThrow>) {
\t\tconst ownState = config.state ?? {}
\t\tthis.state = ownState
\t\tthis.#config = { ...config, state: ownState }
\t\tthis.#fetchFn = config.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : globalThis.fetch)
\t\tthis.#searchSerializer = config.buildSearchParams ?? ((q: Record<string, unknown>) => this.#serializeSearch(q))
\t\tthis.#staleTime = config.invalidation?.staleTime ?? 0
\t\tthis.#staleUntil = this.#staleTime > 0 ? new Map<string, _StaleEntry>() : null
\t\tthis.#staleMaxEntries = config.invalidation?.staleMaxEntries ?? 1000
\t\tthis.#maxSourcesPerTarget = Math.max(config.invalidation?.maxSourcesPerTarget ?? 16, 1)
\t\tthis.#maxErrorMessageChars = config.maxErrorMessageChars ?? 512
\t\tthis.#sseMaxBufferChars = config.sseMaxBufferChars ?? 1024 * 1024
`
}

function sdkClientProxy(n: string): string {
	return `
\t\tconst self = this
\t\tconst callable = (entry: _ServiceEntry, name: string): ((input?: Record<string, unknown>) => unknown) => {
\t\t\tconst entryPath = self.#toColonParams(entry.path, entry.wildcard)
\t\t\tlet fn: (input?: Record<string, unknown>) => unknown
\t\t\tif (entry.ws) {
\t\t\t\tfn = (input?: Record<string, unknown>) => self.#connectWS(entry, entryPath, (input ?? {}) as _RequestOptions)
\t\t\t} else if (entry.sse) {
\t\t\t\tfn = (input?: Record<string, unknown>) => self.#requestSSE(entry, entryPath, (input ?? {}) as _RequestOptions)
\t\t\t} else {
\t\t\t\tfn = (input?: Record<string, unknown>) => self.#request(entry, input ?? {})
\t\t\t}
\t\t\tObject.defineProperty(fn, "name", { value: name })
\t\t\treturn fn
\t\t}
\t\tconst isEntry = (node: unknown): node is _ServiceEntry =>
\t\t\ttypeof node === "object" && node !== null && Object.hasOwn(node, "method") && typeof (node as Record<string, unknown>)["method"] === "string"
\t\t/* only the map's own keys are operations — never toString, constructor or then */
\t\tconst childOf = (node: _ServiceMapNode, key: string): _ServiceMapNode | undefined =>
\t\t\tObject.hasOwn(node, key) ? (node as Record<string, _ServiceMapNode>)[key] : undefined

\t\tfunction makeNodeProxy(node: _ServiceMapNode, path: string[]): object {
\t\t\tconst actionCache = new Map<string, (input?: Record<string, unknown>) => unknown>()
\t\t\tconst childCache = new Map<string, object>()
\t\t\treturn new Proxy({} as Record<string, unknown>, {
\t\t\t\tget: (target, key: string | symbol) => {
\t\t\t\t\tif (typeof key === "symbol") return Reflect.get(target, key)
\t\t\t\t\tconst child = childOf(node, key)
\t\t\t\t\tif (child === undefined) return Reflect.get(target, key)

\t\t\t\t\tif (isEntry(child)) {
\t\t\t\t\t\tconst cached = actionCache.get(key)
\t\t\t\t\t\tif (cached) return cached
\t\t\t\t\t\tconst fn = callable(child, [...path, key].join("."))
\t\t\t\t\t\tactionCache.set(key, fn)
\t\t\t\t\t\treturn fn
\t\t\t\t\t}

\t\t\t\t\tconst cachedChild = childCache.get(key)
\t\t\t\t\tif (cachedChild) return cachedChild
\t\t\t\t\tconst childProxy = makeNodeProxy(child, [...path, key])
\t\t\t\t\tchildCache.set(key, childProxy)
\t\t\t\t\treturn childProxy
\t\t\t\t},
\t\t\t})
\t\t}

\t\treturn new Proxy(this, {
\t\t\tget: (target, key: string | symbol) => {
\t\t\t\t/* the client's own members (state, dispose, toString, ...) always win */
\t\t\t\tif (typeof key === "symbol" || key in target) return Reflect.get(target, key)

\t\t\t\tconst cached = target.#resourceCache.get(key)
\t\t\t\tif (cached) return cached

\t\t\t\tconst node = childOf(serviceMap as _ServiceMap, key)
\t\t\t\tif (node === undefined) return undefined

\t\t\t\t/* root-level leaf (single-segment operationId) */
\t\t\t\tif (isEntry(node)) {
\t\t\t\t\tconst fn = callable(node, key)
\t\t\t\t\ttarget.#resourceCache.set(key, fn as unknown as Record<string, unknown>)
\t\t\t\t\treturn fn
\t\t\t\t}

\t\t\t\t/* namespace node — check for single _call promotion */
\t\t\t\tconst nodeKeys = Object.keys(node)
\t\t\t\tconst only = childOf(node, "_call")
\t\t\t\tif (nodeKeys.length === 1 && only !== undefined && isEntry(only)) {
\t\t\t\t\tconst fn = callable(only, key)
\t\t\t\t\ttarget.#resourceCache.set(key, fn as unknown as Record<string, unknown>)
\t\t\t\t\treturn fn
\t\t\t\t}

\t\t\t\tconst proxy = makeNodeProxy(node, [key])
\t\t\t\ttarget.#resourceCache.set(key, proxy as Record<string, unknown>)
\t\t\t\treturn proxy
\t\t\t},
\t\t}) as ${n}<TThrow>
\t}
`
}

function sdkClientInterpolatePath(): string {
	return `
\t/* Keep in sync with client/path.ts — :name (whole segment), *name (rest), {name} (inside a segment). */
\t#encodeSegmentValue(key: string, value: string): string {
\t\tif (value === "" || value === "." || value === "..") {
\t\t\tthrow new _PathParamError(\`Invalid path param \${JSON.stringify(key)}: \${JSON.stringify(value)} is not a path segment\`)
\t\t}
\t\treturn encodeURIComponent(value)
\t}

\t#encodeWildcardValue(key: string, value: string): string {
\t\tif (value === "") return ""
\t\treturn value.split("/").map((part) => this.#encodeSegmentValue(key, part)).join("/")
\t}

\t#paramValue(params: Record<string, string> | undefined, key: string): string | undefined {
\t\tif (!params || !Object.hasOwn(params, key)) return undefined
\t\tconst raw = params[key] as unknown
\t\tif (raw === undefined || raw === null) return undefined
\t\treturn typeof raw === "string" ? raw : String(raw)
\t}

\t#interpolatePath(path: string, params: Record<string, string> | undefined, partial = false): string {
\t\tconst segments = path.split("/")
\t\tconst out: string[] = []
\t\tfor (let i = 0; i < segments.length; i++) {
\t\t\tconst seg = segments[i] ?? ""
\t\t\tif (seg.length > 1 && seg.charCodeAt(0) === 58) {
\t\t\t\tconst optional = seg.endsWith("?")
\t\t\t\tconst name = optional ? seg.slice(1, -1) : seg.slice(1)
\t\t\t\tconst value = this.#paramValue(params, name)
\t\t\t\tif (value === undefined) {
\t\t\t\t\tif (partial) { out.push(seg); continue }
\t\t\t\t\tif (optional) continue
\t\t\t\t\tthrow new _PathParamError(\`Missing path param: \${name}\`)
\t\t\t\t}
\t\t\t\tout.push(this.#encodeSegmentValue(name, value))
\t\t\t\tcontinue
\t\t\t}
\t\t\tif (seg.charCodeAt(0) === 42 && i === segments.length - 1) {
\t\t\t\tconst name = seg.length > 1 ? seg.slice(1) : "*"
\t\t\t\tconst value = this.#paramValue(params, name)
\t\t\t\tif (value === undefined) {
\t\t\t\t\tif (partial) { out.push(seg); continue }
\t\t\t\t\tif (seg.length === 1) { out.push(""); continue }
\t\t\t\t\tthrow new _PathParamError(\`Missing path param: \${name}\`)
\t\t\t\t}
\t\t\t\tout.push(this.#encodeWildcardValue(name, value))
\t\t\t\tcontinue
\t\t\t}
\t\t\tout.push(
\t\t\t\tseg.replace(/\\{([^{}/]+)\\}/g, (match: string, name: string) => {
\t\t\t\t\tconst value = this.#paramValue(params, name)
\t\t\t\t\tif (value === undefined) {
\t\t\t\t\t\tif (partial) return match
\t\t\t\t\t\tthrow new _PathParamError(\`Missing path param: \${name}\`)
\t\t\t\t\t}
\t\t\t\t\treturn this.#encodeSegmentValue(name, value)
\t\t\t\t}),
\t\t\t)
\t\t}
\t\treturn out.join("/")
\t}

\t#hasPlaceholder(path: string): boolean {
\t\tfor (const seg of path.split("/")) {
\t\t\tif (seg.length > 1 && seg.charCodeAt(0) === 58) return true
\t\t\tif (seg.charCodeAt(0) === 42) return true
\t\t\tif (/\\{[^{}/]+\\}/.test(seg)) return true
\t\t}
\t\treturn false
\t}
`
}

function sdkClientToColonParams(): string {
	return `
\t/* OpenAPI template → route pattern: a whole-segment {name} is :name, the wildcard *name; {name} inside a segment stays */
\t#toColonParams(path: string, wildcard?: string): string {
\t\treturn path
\t\t\t.split("/")
\t\t\t.map((seg) => {
\t\t\t\tconst m = /^\\{([^{}/]+)\\}$/.exec(seg)
\t\t\t\tif (!m) return seg
\t\t\t\treturn m[1] === wildcard ? \`*\${m[1]}\` : \`:\${m[1]}\`
\t\t\t})
\t\t\t.join("/")
\t}
`
}

function sdkClientResolveInvalidationTargets(): string {
	return `
\t/* params that are present are substituted; a target left partly unresolved stays a narrower pattern */
\t#resolveInvalidationTargets(
\t\ttargets: readonly string[],
\t\tparams: Record<string, string> | undefined,
\t): string[] {
\t\tconst resolved: string[] = []
\t\tfor (const target of targets) {
\t\t\tconst spaceIdx = target.indexOf(" ")
\t\t\tif (spaceIdx <= 0) continue
\t\t\tconst targetMethod = target.slice(0, spaceIdx)
\t\t\tconst targetPath = target.slice(spaceIdx + 1)
\t\t\ttry {
\t\t\t\tresolved.push(\`\${targetMethod} \${this.#interpolatePath(targetPath, params, true)}\`)
\t\t\t} catch {
\t\t\t\t/* a param value that is not a path segment marks nothing */
\t\t\t}
\t\t}
\t\treturn resolved
\t}
`
}

function sdkClientPathMatchesPattern(): string {
	return `
\t#pathMatchesPattern(concretePath: string, pattern: string): boolean {
\t\tlet re = this.#patternRegexCache.get(pattern)
\t\tif (!re) {
\t\t\tconst esc = (text: string) => text.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&")
\t\t\tconst segments = pattern.split("/")
\t\t\tlet source = ""
\t\t\tfor (let i = 0; i < segments.length; i++) {
\t\t\t\tconst seg = segments[i] ?? ""
\t\t\t\tconst sep = i === 0 ? "" : "/"
\t\t\t\tif (seg.length > 1 && seg.charCodeAt(0) === 58) {
\t\t\t\t\tsource += seg.endsWith("?") ? \`(?:\${sep}[^/]+)?\` : \`\${sep}[^/]+\`
\t\t\t\t\tcontinue
\t\t\t\t}
\t\t\t\tif (seg.charCodeAt(0) === 42 && i === segments.length - 1) {
\t\t\t\t\tsource += \`(?:\${sep}.*)?\`
\t\t\t\t\tcontinue
\t\t\t\t}
\t\t\t\tsource += sep + seg.split(/\\{[^{}/]+\\}/).map(esc).join("[^/]+")
\t\t\t}
\t\t\tre = new RegExp(\`^\${source}$\`)
\t\t\tif (this.#patternRegexCache.size >= 1024) {
\t\t\t\tconst oldest = this.#patternRegexCache.keys().next().value
\t\t\t\tif (oldest !== undefined) this.#patternRegexCache.delete(oldest)
\t\t\t}
\t\t\tthis.#patternRegexCache.set(pattern, re)
\t\t}
\t\treturn re.test(concretePath)
\t}
`
}

function sdkClientLookupStale(): string {
	return `
\t/* Keep in sync with client/sdk.ts StaleIndex — exact keys and pattern keys are kept apart, so a
\t   concrete path containing ":" is never read as a pattern, and a lookup scans only its method. */
\t#lookupStale(
\t\tconcreteSelector: string,
\t\tconcretePath: string,
\t\tmethod: string,
\t\tnow: number,
\t): { by: string[]; isStale: boolean } {
\t\tconst by = new Set<string>()
\t\tconst exact = this.#staleUntil?.get(concreteSelector)
\t\tif (exact) {
\t\t\tif (exact.until > now) for (const m of exact.by) by.add(m)
\t\t\telse this.#staleUntil?.delete(concreteSelector)
\t\t}
\t\tconst table = this.#stalePatterns.get(method)
\t\tif (table) {
\t\t\tfor (const [key, entry] of table) {
\t\t\t\tif (entry.until <= now) { table.delete(key); continue }
\t\t\t\tif (entry.refreshed?.has(concretePath)) continue
\t\t\t\tif (this.#pathMatchesPattern(concretePath, key.slice(key.indexOf(" ") + 1))) {
\t\t\t\t\tfor (const m of entry.by) by.add(m)
\t\t\t\t}
\t\t\t}
\t\t}
\t\treturn { by: [...by], isStale: by.size > 0 }
\t}
`
}

function sdkClientCreateTypedWebSocket(): string {
	return `
\t#createTypedWebSocket(url: string, protocols?: string | string[]): _TypedWebSocket {
\t\tconst ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
\t\t/* keyed by event and handler: one function may listen to several events */
\t\tconst listenerMap = new Map<string, WeakMap<(...args: never[]) => void, EventListener>>()
\t\tconst sendBuffer: Array<ArrayBuffer | ArrayBufferView | string> = []
\t\tlet buffering = true

\t\tws.addEventListener("open", () => {
\t\t\tbuffering = false
\t\t\tfor (const msg of sendBuffer) ws.send(msg as Parameters<WebSocket["send"]>[0])
\t\t\tsendBuffer.length = 0
\t\t})
\t\t/* a socket that never opens must not hold messages forever */
\t\tconst drop = () => {
\t\t\tbuffering = false
\t\t\tsendBuffer.length = 0
\t\t}
\t\tws.addEventListener("close", drop)
\t\tws.addEventListener("error", drop)

\t\tfunction close(code?: number, reason?: string) {
\t\t\tdrop()
\t\t\tws.close(code, reason)
\t\t}

\t\tfunction on(event: string, handler: (...args: never[]) => void): void {
\t\t\tlet wrapped: EventListener
\t\t\tswitch (event) {
\t\t\t\tcase "message":
\t\t\t\t\twrapped = (e: Event) => (handler as (data: unknown) => void)((e as MessageEvent).data)
\t\t\t\t\tbreak
\t\t\t\tcase "open":
\t\t\t\t\twrapped = () => (handler as () => void)()
\t\t\t\t\tbreak
\t\t\t\tcase "close":
\t\t\t\t\twrapped = (e: Event) => (handler as (code: number, reason: string) => void)((e as CloseEvent).code, (e as CloseEvent).reason)
\t\t\t\t\tbreak
\t\t\t\tcase "error":
\t\t\t\t\twrapped = (e: Event) => (handler as (error: unknown) => void)(e)
\t\t\t\t\tbreak
\t\t\t\tdefault:
\t\t\t\t\treturn
\t\t\t}
\t\t\tlet byHandler = listenerMap.get(event)
\t\t\tif (!byHandler) {
\t\t\t\tbyHandler = new WeakMap()
\t\t\t\tlistenerMap.set(event, byHandler)
\t\t\t}
\t\t\tbyHandler.set(handler, wrapped)
\t\t\tws.addEventListener(event, wrapped)
\t\t}

\t\tfunction off(event: string, handler: (...args: never[]) => void): void {
\t\t\tconst byHandler = listenerMap.get(event)
\t\t\tconst wrapped = byHandler?.get(handler)
\t\t\tif (wrapped) {
\t\t\t\tws.removeEventListener(event, wrapped)
\t\t\t\tbyHandler?.delete(handler)
\t\t\t}
\t\t}

\t\tfunction send(data: ArrayBuffer | ArrayBufferView | object | string) {
\t\t\tlet payload: ArrayBuffer | ArrayBufferView | string | Blob
\t\t\tif (typeof data === "string") {
\t\t\t\tpayload = data
\t\t\t} else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
\t\t\t\tpayload = data
\t\t\t} else if (typeof Blob !== "undefined" && data instanceof Blob) {
\t\t\t\tpayload = data
\t\t\t} else {
\t\t\t\tpayload = JSON.stringify(data)
\t\t\t}
\t\t\tif (buffering) { sendBuffer.push(payload as ArrayBuffer | ArrayBufferView | string) } else if (ws.readyState === 1) { ws.send(payload as Parameters<WebSocket["send"]>[0]) }
\t\t}

\t\tconst typed: _TypedWebSocket = { close, off, on, get readyState() { return ws.readyState }, send }
\t\tObject.defineProperty(typed, "_ws", { enumerable: false, value: ws })
\t\treturn typed
\t}
`
}

function sdkClientSerializeSearch(): string {
	return `
\t#serializeSearch(query: Record<string, unknown>): URLSearchParams {
\t\tconst params = new URLSearchParams()
\t\tconst coerce = (v: unknown): string | null => {
\t\t\tif (v === undefined || v === null) return null
\t\t\tif (v instanceof Date) return v.toISOString()
\t\t\tif (typeof v === "symbol") return null
\t\t\treturn String(v)
\t\t}
\t\tfor (const [k, v] of Object.entries(query)) {
\t\t\tif (Array.isArray(v)) {
\t\t\t\tfor (const item of v) { const s = coerce(item); if (s !== null) params.append(k, s) }
\t\t\t} else {
\t\t\t\tconst s = coerce(v); if (s !== null) params.set(k, s)
\t\t\t}
\t\t}
\t\treturn params
\t}
`
}

/* Keep in sync with client/defaults.ts — generated SDKs have zero runtime imports. */
function sdkClientResolveBaseURL(): string {
	return `
	#resolveBaseURL(baseURL: string): URL {
		if (/^(?:https?|wss?):\\/\\//i.test(baseURL)) return new URL(baseURL)
		let origin: unknown
		try {
			origin = globalThis.location?.origin
		} catch {
			origin = undefined
		}
		if (typeof origin === "string" && origin !== "" && origin !== "null" && /^(?:https?|wss?):\\/\\//i.test(origin)) {
			try {
				return new URL(baseURL, origin)
			} catch {
				throw new Error(\`Invalid baseURL \${JSON.stringify(baseURL)}: expected an absolute http(s): or ws(s): URL. Path-only values such as "/api" resolve against location.origin in browsers.\`)
			}
		}
		throw new Error(\`Invalid baseURL \${JSON.stringify(baseURL)}: expected an absolute http(s): or ws(s): URL. Path-only values such as "/api" resolve against location.origin in browsers.\`)
	}
`
}

function sdkClientBuildURL(): string {
	return `
\t#buildURL(path: string, opts: _RequestOptions): string {
\t\tconst resolvedPath = this.#interpolatePath(path, opts.params)
\t\tconst baseUrl = this.#resolveBaseURL(this.#config.baseURL)
\t\tconst basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : \`\${baseUrl.pathname}/\`
\t\tconst relative = resolvedPath.startsWith("/") ? resolvedPath.slice(1) : resolvedPath
\t\tconst url = new URL(\`\${basePath}\${relative}\`, baseUrl)
\t\t/* a request (and its credentials) never leaves the configured origin */
\t\tif (url.origin !== baseUrl.origin) {
\t\t\tthrow new _PathParamError(\`Invalid path param: \${JSON.stringify(path)} resolves outside \${baseUrl.origin}\`)
\t\t}
\t\tfor (const [k, v] of baseUrl.searchParams.entries()) url.searchParams.append(k, v)
\t\tif (opts.search) {
\t\t\tconst sp = this.#searchSerializer(opts.search)
\t\t\tif (this.#config.sortSearchParams) sp.sort()
\t\t\tfor (const [k, v] of sp.entries()) url.searchParams.append(k, v)
\t\t}
\t\treturn url.toString()
\t}
`
}

function sdkClientNewRequestId(): string {
	return `
\t#newRequestId(): string {
\t\tconst c = globalThis.crypto as Crypto | undefined
\t\tif (c && typeof c.randomUUID === "function") return c.randomUUID()
\t\tif (c && typeof c.getRandomValues === "function") {
\t\t\tconst bytes = new Uint8Array(16)
\t\t\tc.getRandomValues(bytes)
\t\t\tbytes[6] = (bytes[6]! & 0x0f) | 0x40
\t\t\tbytes[8] = (bytes[8]! & 0x3f) | 0x80
\t\t\tlet out = ""
\t\t\tfor (let i = 0; i < 16; i++) {
\t\t\t\tif (i === 4 || i === 6 || i === 8 || i === 10) out += "-"
\t\t\t\tout += bytes[i]!.toString(16).padStart(2, "0")
\t\t\t}
\t\t\treturn out
\t\t}
\t\tthrow new Error("honey: no crypto.randomUUID or crypto.getRandomValues in this runtime")
\t}
`
}

function sdkClientBuildHeaders(): string {
	return `
\tasync #buildHeaders(
\t\topts: _RequestOptions,
\t\tctx: { method: string; path: string },
\t): Promise<Headers> {
\t\tconst headers = new Headers()

\t\tif (this.#config.headers) {
\t\t\tconst resolved =
\t\t\t\ttypeof this.#config.headers === "function"
\t\t\t\t\t? await this.#config.headers(ctx)
\t\t\t\t\t: this.#config.headers
\t\t\tfor (const [k, v] of Object.entries(resolved)) {
\t\t\t\tif (v !== undefined) headers.set(k, v)
\t\t\t}
\t\t}

\t\t/* a token from onAuthExpired replaces the configured one until the next refresh */
\t\tif (this.#token !== null) {
\t\t\theaders.set(this.#config.authHeaderName ?? "Authorization", \`\${this.#config.authHeaderPrefix ?? "Bearer "}\${this.#token}\`)
\t\t}

\t\tif (opts.headers) {
\t\t\tfor (const [k, v] of Object.entries(opts.headers)) {
\t\t\t\tif (v !== undefined) headers.set(k, v)
\t\t\t}
\t\t}

\t\tif (opts.cookies) {
\t\t\tconst existing = headers.get("cookie")
\t\t\tconst pairs = Object.entries(opts.cookies)
\t\t\t\t.map(([k, v]) => \`\${encodeURIComponent(k)}=\${encodeURIComponent(v)}\`)
\t\t\t\t.join("; ")
\t\t\tif (pairs) {
\t\t\t\theaders.set("cookie", existing ? \`\${existing}; \${pairs}\` : pairs)
\t\t\t}
\t\t}

\t\tif (!headers.has("x-request-id")) {
\t\t\theaders.set("x-request-id", this.#newRequestId())
\t\t}

\t\treturn headers
\t}
`
}

function sdkClientDoRequest(): string {
	return `
\t/* the body of a request, and the content-type it needs — shared by plain requests and SSE */
\t#buildBody(opts: _RequestOptions, headers: Headers): BodyInit | undefined {
\t\tif (opts.body !== undefined) {
\t\t\tif (!headers.has("content-type")) headers.set("content-type", "application/octet-stream")
\t\t\treturn opts.body as BodyInit
\t\t}
\t\tif (opts.json !== undefined) {
\t\t\theaders.set("content-type", "application/json")
\t\t\ttry {
\t\t\t\treturn JSON.stringify(opts.json)
\t\t\t} catch (e) {
\t\t\t\tthrow new _ClientError({
\t\t\t\t\tbody: opts.json,
\t\t\t\t\tdata: null,
\t\t\t\t\tmessage: \`JSON serialization failed: \${e instanceof Error ? e.message : String(e)}\`,
\t\t\t\t\tresponse: new Response(null, { status: 0 }),
\t\t\t\t\tstatus: 0,
\t\t\t\t})
\t\t\t}
\t\t}
\t\tif (opts.form === undefined) return undefined
\t\tconst isFile = (v: unknown) =>
\t\t\t(typeof File !== "undefined" && v instanceof File) || (typeof Blob !== "undefined" && v instanceof Blob)
\t\tconst hasFiles = Object.values(opts.form).some(
\t\t\t(v) =>
\t\t\t\tisFile(v) ||
\t\t\t\t(typeof FileList !== "undefined" && v instanceof FileList) ||
\t\t\t\t(Array.isArray(v) && v.some(isFile)),
\t\t)
\t\tconst text = (v: unknown): string | null => {
\t\t\tif (v === undefined || v === null || typeof v === "symbol") return null
\t\t\tif (v instanceof Date) return v.toISOString()
\t\t\tif (typeof v === "object") throw new TypeError("form: nested objects cannot be form-encoded; send json instead")
\t\t\treturn String(v)
\t\t}
\t\tif (hasFiles) {
\t\t\tconst fd = new FormData()
\t\t\tfor (const [k, v] of Object.entries(opts.form)) {
\t\t\t\tif (typeof FileList !== "undefined" && v instanceof FileList) {
\t\t\t\t\tfor (let i = 0; i < v.length; i++) { const f = v[i]; if (f) fd.append(k, f) }
\t\t\t\t\tcontinue
\t\t\t\t}
\t\t\t\tfor (const item of Array.isArray(v) ? v : [v]) {
\t\t\t\t\tif (isFile(item)) fd.append(k, item as Blob)
\t\t\t\t\telse {
\t\t\t\t\t\tconst s = text(item)
\t\t\t\t\t\tif (s !== null) fd.append(k, s)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}
\t\t\treturn fd
\t\t}
\t\theaders.set("content-type", "application/x-www-form-urlencoded")
\t\tconst sp = new URLSearchParams()
\t\t/* arrays repeat the key, as they do in multipart and in the query */
\t\tfor (const [k, v] of Object.entries(opts.form)) {
\t\t\tfor (const item of Array.isArray(v) ? v : [v]) {
\t\t\t\tconst s = text(item)
\t\t\t\tif (s !== null) sp.append(k, s)
\t\t\t}
\t\t}
\t\treturn sp.toString()
\t}

\t/* a stream body is sent once and needs duplex: "half" (Node's fetch throws without it) */
\t#requestInit(init: RequestInit): RequestInit {
\t\tif (typeof ReadableStream !== "undefined" && init.body instanceof ReadableStream) {
\t\t\t;(init as RequestInit & { duplex?: string }).duplex = "half"
\t\t}
\t\treturn init
\t}

\t/* the Request a response hook sees; a stream body was consumed by the send, so it is left off */
\t#hookRequest(url: string, init: RequestInit): Request {
\t\tconst consumed = typeof ReadableStream !== "undefined" && init.body instanceof ReadableStream
\t\treturn new Request(url, consumed ? { ...init, body: null } : init)
\t}

\tasync #doRequest(
\t\tmethod: string,
\t\tpath: string,
\t\topts: _RequestOptions,
\t\tisRetry: boolean,
\t\trequestMeta?: _RequestMeta,
\t): Promise<{ done: () => void; response: Response }> {
\t\tconst url = this.#buildURL(path, opts)
\t\tconst headers = await this.#buildHeaders(opts, { method, path })
\t\tlet body = this.#buildBody(opts, headers)

\t\tif (this.#config.onRequest) {
\t\t\tconst reqCtx: { body?: BodyInit; headers: Headers; invalidatedBy?: string[]; isStale?: boolean; method: string; path: string; selector?: string; state: Record<string, unknown>; url: string } = { body, headers, method, path, state: this.#config.state ?? {}, url }
\t\t\tif (requestMeta) {
\t\t\t\treqCtx.invalidatedBy = requestMeta.invalidatedBy
\t\t\t\treqCtx.isStale = requestMeta.isStale
\t\t\t\treqCtx.selector = requestMeta.selector
\t\t\t}
\t\t\tfor (const hook of this.#config.onRequest) {
\t\t\t\tawait hook(reqCtx)
\t\t\t}
\t\t\tif (reqCtx.body !== body) body = reqCtx.body
\t\t}

\t\tconst { signal, cleanup } = this.#buildSignal(opts)
\t\tconst init = this.#requestInit({ body, headers, method, signal })
\t\tif (this.#config.credentials) init.credentials = this.#config.credentials
\t\tif (this.#config.mode) init.mode = this.#config.mode

\t\tconst _logOp = \`\${method.toUpperCase()} \${path}\`
\t\tconst _logStart = Date.now()
\t\tthis.#config.onLog?.({ duration_ms: 0, event: "request_start", level: "debug", operation: _logOp })

\t\ttry {
\t\t\tsignal?.throwIfAborted()
\t\t\tlet response = await this.#send(url, init)

\t\t\t/* FormData, Blob, and strings can be sent again; a stream was consumed by the first attempt */
\t\t\tif (response.status === 401 && this.#config.onAuthExpired && !isRetry && !(body instanceof ReadableStream)) {
\t\t\t\tconst authName = this.#config.authHeaderName ?? "Authorization"
\t\t\t\tconst authPrefix = this.#config.authHeaderPrefix ?? "Bearer "
\t\t\t\tconst sent = new Headers(headers).get(authName)
\t\t\t\tconst rejectedToken = sent?.startsWith(authPrefix) ? sent.slice(authPrefix.length) : (sent ?? null)
\t\t\t\tconst newToken = await this.#refreshToken(rejectedToken)
\t\t\t\tif (newToken !== null) {
\t\t\t\t\tconst retryHeaders = new Headers(headers)
\t\t\t\t\tretryHeaders.set(authName, \`\${authPrefix}\${newToken}\`)
\t\t\t\t\tawait response.body?.cancel().catch(() => {})
\t\t\t\t\tresponse = await this.#send(url, { ...init, headers: retryHeaders })
\t\t\t\t}
\t\t\t}

\t\t\tthis.#config.onLog?.({
\t\t\t\tduration_ms: Date.now() - _logStart,
\t\t\t\tevent: "response_received",
\t\t\t\tlevel: response.status >= 400 ? "warn" : "info",
\t\t\t\toperation: _logOp,
\t\t\t\tstatus: response.status,
\t\t\t})

\t\t\tif (this.#config.onResponse) {
\t\t\t\tconst resCtx: { invalidatedBy?: string[]; isRetry: boolean; isStale?: boolean; method: string; path: string; request: Request; response: Response; retry: () => Promise<Response>; selector?: string; state: Record<string, unknown>; url: string } = {
\t\t\t\t\tisRetry,
\t\t\t\t\tmethod,
\t\t\t\t\tpath,
\t\t\t\t\trequest: this.#hookRequest(url, init),
\t\t\t\t\tresponse,
\t\t\t\t\tretry: () => {
\t\t\t\t\t\tif (isRetry) throw new Error("Max 1 retry per request")
\t\t\t\t\t\tif (body instanceof ReadableStream) throw new Error("A streamed request body cannot be sent again")
\t\t\t\t\t\treturn this.#doRequest(method, path, opts, true, requestMeta)
\t\t\t\t\t\t\t.then(async (r) => {
\t\t\t\t\t\t\t\tr.done()
\t\t\t\t\t\t\t\tif (!r.response.ok) throw await this.#parseAsClientError(r.response)
\t\t\t\t\t\t\t\treturn r.response
\t\t\t\t\t\t\t})
\t\t\t\t\t},
\t\t\t\t\tstate: this.#config.state ?? {},
\t\t\t\t\turl,
\t\t\t\t}
\t\t\t\tif (requestMeta) {
\t\t\t\t\tresCtx.invalidatedBy = requestMeta.invalidatedBy
\t\t\t\t\tresCtx.isStale = requestMeta.isStale
\t\t\t\t\tresCtx.selector = requestMeta.selector
\t\t\t\t}
\t\t\t\tfor (const hook of this.#config.onResponse) {
\t\t\t\t\tconst result = await hook(resCtx)
\t\t\t\t\tif (result instanceof Response) {
\t\t\t\t\t\tresponse = result
\t\t\t\t\t\tresCtx.response = result
\t\t\t\t\t}
\t\t\t\t}
\t\t\t}

\t\t\t/* the caller releases the timer after reading the body: the timeout covers the whole exchange */
\t\t\treturn { done: cleanup, response }
\t\t} catch (err) {
\t\t\tcleanup()
\t\t\tconst _errStatus = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : undefined
\t\t\tthis.#config.onLog?.({
\t\t\t\tduration_ms: Date.now() - _logStart,
\t\t\t\terror: err,
\t\t\t\tevent: "error",
\t\t\t\tlevel: "error",
\t\t\t\toperation: _logOp,
\t\t\t\t...(_errStatus !== undefined ? { status: _errStatus } : {}),
\t\t\t})
\t\t\tthrow err
\t\t}
\t}

\t/* one refresh for every 401 in flight; the new token is kept for later requests */
\t#refreshToken(rejectedToken: string | null): Promise<string | null> {
\t\tconst hook = this.#config.onAuthExpired
\t\tif (!hook) return Promise.resolve(null)
\t\tif (rejectedToken !== null && this.#token !== null && rejectedToken !== this.#token) {
\t\t\t/* another request already refreshed past the rejected token */
\t\t\treturn Promise.resolve(this.#token)
\t\t}
\t\tthis.#refreshing ??= Promise.resolve()
\t\t\t.then(() => hook({ rejectedToken }))
\t\t\t.then((token) => {
\t\t\t\tthis.#token = typeof token === "string" && token.length > 0 ? token : null
\t\t\t\treturn this.#token
\t\t\t})
\t\t\t.finally(() => {
\t\t\t\tthis.#refreshing = null
\t\t\t})
\t\treturn this.#refreshing
\t}

\t/* Same rules as client/http.ts; the cross-origin header allowlist comes from
\t   client/redirect-policy.ts. "same-origin" (default) follows a redirect only while it stays on
\t   the base URL's origin; "follow" also follows cross-origin ones, carrying only allowlisted
\t   headers and never a replayed body.
\t   Browsers hide redirect targets from script, so there the platform follows. */
\tasync #send(url: string, init: RequestInit): Promise<Response> {
\t\tconst policy = this.#config.redirect ?? "same-origin"
\t\tconst g = globalThis as { document?: unknown; WorkerGlobalScope?: unknown }
\t\tconst platformFollows = typeof g.document !== "undefined" || typeof g.WorkerGlobalScope !== "undefined"
\t\tif (policy === "manual" || policy === "error" || platformFollows) {
\t\t\treturn this.#fetchFn(url, policy === "same-origin" ? init : { ...init, redirect: policy })
\t\t}
\t\tconst origin = new URL(url).origin
\t\tlet current = new URL(url)
\t\tlet currentInit: RequestInit = { ...init, redirect: "manual" }
\t\tconst replayable = (b: unknown) =>
\t\t\tb == null || typeof b === "string" || (typeof Blob !== "undefined" && b instanceof Blob) || (typeof FormData !== "undefined" && b instanceof FormData) || b instanceof URLSearchParams || b instanceof ArrayBuffer || ArrayBuffer.isView(b)
\t\tfor (let hop = 0; ; hop++) {
\t\t\tconst response = await this.#fetchFn(current.toString(), currentInit)
\t\t\tconst location = response.headers.get("location")
\t\t\tif (![301, 302, 303, 307, 308].includes(response.status) || location === null || hop >= 20) return response
\t\t\tlet target: URL
\t\t\ttry {
\t\t\t\ttarget = new URL(location, current)
\t\t\t} catch {
\t\t\t\treturn response
\t\t\t}
\t\t\tif (target.protocol !== "http:" && target.protocol !== "https:") return response
\t\t\tconst crossOrigin = target.origin !== origin
\t\t\tif (crossOrigin && policy !== "follow") return response
\t\t\tconst nextInit: RequestInit = { ...currentInit, headers: new Headers(currentInit.headers) }
\t\t\tif (response.status === 307 || response.status === 308) {
\t\t\t\tif (currentInit.body != null && (crossOrigin || !replayable(currentInit.body))) return response
\t\t\t} else {
\t\t\t\tconst method = (currentInit.method ?? "GET").toUpperCase()
\t\t\t\tif (response.status === 303 ? method !== "HEAD" : method === "POST") {
\t\t\t\t\tnextInit.method = "GET"
\t\t\t\t\tnextInit.body = undefined
\t\t\t\t\t;(nextInit.headers as Headers).delete("content-type")
\t\t\t\t}
\t\t\t}
\t\t\tif (crossOrigin) {
\t\t\t\t/* only allowlisted headers cross: no credential, configured, per-call or hook header */
\t\t\t\tconst safe = new Headers()
\t\t\t\tfor (const name of [${CROSS_ORIGIN_SAFE_HEADERS.map((h) => JSON.stringify(h)).join(", ")}]) {
\t\t\t\t\tconst value = (nextInit.headers as Headers).get(name)
\t\t\t\t\tif (value !== null) safe.set(name, value)
\t\t\t\t}
\t\t\t\tnextInit.headers = safe
\t\t\t}
\t\t\tawait response.body?.cancel().catch(() => {})
\t\t\tcurrent = target
\t\t\tcurrentInit = nextInit
\t\t}
\t}
`
}

function sdkClientParseBody(): string {
	return `
\t#parseBody(response: Response): Promise<unknown> {
\t\tif (response.status === 204) return Promise.resolve(null)

\t\tconst rawCt = response.headers.get("content-type") ?? ""
\t\tconst ct = rawCt.split(";")[0]?.trim().toLowerCase() ?? ""
\t\tif (ct === "application/json" || ct.endsWith("+json")) {
\t\t\treturn response.json()
\t\t}
\t\tif (ct === "application/octet-stream" || ct === "application/pdf") {
\t\t\treturn response.arrayBuffer()
\t\t}
\t\t/* the classes the generated types use: text/*, XML, otherwise bytes */
\t\tif (ct.startsWith("text/") || ct === "application/xml" || ct.endsWith("+xml")) return response.text()
\t\t/* unknown content type \u2014 binary-safe fallback */
\t\treturn response.arrayBuffer()
\t}
`
}

function sdkClientParseErrorBody(): string {
	return `
\tasync #parseErrorBody(response: Response): Promise<unknown> {
\t\ttry {
\t\t\treturn await response.json()
\t\t} catch {
\t\t\treturn undefined
\t\t}
\t}
`
}

function sdkClientParseAsClientError(): string {
	return `
\tasync #parseAsClientError(response: Response): Promise<_ClientError> {
\t\tconst preserved = response.clone()
\t\tconst body = await this.#parseErrorBody(response)
\t\tconst msgVal = typeof body === "object" && body !== null && "message" in body
\t\t\t? (body as Record<string, unknown>)["message"]
\t\t\t: undefined
\t\tconst rawMsg = typeof msgVal === "string" ? msgVal : null
\t\tconst safeMsg = rawMsg !== null
\t\t\t? rawMsg.replace(/[\\x00-\\x1f]/g, "").slice(0, this.#maxErrorMessageChars)
\t\t\t: \`HTTP \${response.status}\`
\t\tconst Cls = _STATUS_ERROR_MAP[response.status] ?? _ClientError
\t\treturn new Cls({ body, data: body, message: safeMsg, response: preserved, status: response.status })
\t}
`
}

function sdkClientBuildSignal(): string {
	return `
\t#buildSignal(opts: _RequestOptions, isStream?: boolean): { cleanup: () => void; signal: AbortSignal } {
\t\tconst userSignal = opts.signal
\t\tconst timeout = isStream ? undefined : (opts.timeout ?? this.#config.timeout)
\t\tif (!timeout && !userSignal) return { cleanup: () => {}, signal: this.#disposeCtrl.signal }
\t\tconst ctrl = new AbortController()
\t\tlet timer: ReturnType<typeof setTimeout> | undefined
\t\tif (timeout) {
\t\t\ttimer = setTimeout(() => ctrl.abort(new Error("timeout")), timeout)
\t\t\tif (typeof (timer as unknown as { unref?: () => void }).unref === "function") {
\t\t\t\t(timer as unknown as { unref: () => void }).unref()
\t\t\t}
\t\t}
\t\tconst abort = (reason?: unknown) => { if (!ctrl.signal.aborted) ctrl.abort(reason) }
\t\tconst onDispose = () => abort(this.#disposeCtrl.signal.reason)
\t\tconst onUserAbort = () => abort(userSignal?.reason)
\t\tif (this.#disposeCtrl.signal.aborted) {
\t\t\tabort(this.#disposeCtrl.signal.reason)
\t\t} else {
\t\t\tthis.#disposeCtrl.signal.addEventListener("abort", onDispose, { once: true })
\t\t}
\t\tif (userSignal?.aborted) {
\t\t\tabort(userSignal.reason)
\t\t} else if (userSignal) {
\t\t\tuserSignal.addEventListener("abort", onUserAbort, { once: true })
\t\t}
\t\treturn {
\t\t\tcleanup: () => {
\t\t\t\tif (timer !== undefined) clearTimeout(timer)
\t\t\t\tthis.#disposeCtrl.signal.removeEventListener("abort", onDispose)
\t\t\t\tuserSignal?.removeEventListener("abort", onUserAbort)
\t\t\t},
\t\t\tsignal: ctrl.signal,
\t\t}
\t}
`
}

function sdkClientRequestThrow(): string {
	return `
\tasync #requestThrow(
\t\tmethod: string,
\t\tpath: string,
\t\topts: _RequestOptions,
\t\trequestMeta?: _RequestMeta,
\t): Promise<unknown> {
\t\tconst { done, response } = await this.#doRequest(method, path, opts, false, requestMeta)
\t\ttry {
\t\t\tif (!response.ok) throw await this.#parseAsClientError(response)
\t\t\treturn await this.#parseBody(response)
\t\t} finally {
\t\t\tdone()
\t\t}
\t}
`
}

function sdkClientRequestSafe(): string {
	return `
\tasync #requestSafe(
\t\tmethod: string,
\t\tpath: string,
\t\topts: _RequestOptions,
\t\trequestMeta?: _RequestMeta,
\t): Promise<{
\t\tdata: unknown
\t\terror: unknown
\t\tresponse: Response
\t\tstatus: number
\t}> {
\t\tlet doResponse: { done: () => void; response: Response }
\t\ttry {
\t\t\tdoResponse = await this.#doRequest(method, path, opts, false, requestMeta)
\t\t} catch (e) {
\t\t\tif (e instanceof _ClientError) return { data: null, error: e, response: e.response, status: e.status }
\t\t\tthrow e
\t\t}
\t\tconst { done, response } = doResponse
\t\ttry {
\t\t\tif (!response.ok) {
\t\t\t\tconst preserved = response.clone()
\t\t\t\tconst parsed = await this.#parseErrorBody(response)
\t\t\t\t/* a failed request always has a truthy error: the JSON body, or a ClientError for any other body */
\t\t\t\tconst error = parsed !== undefined && parsed !== null && parsed !== false && parsed !== "" && parsed !== 0
\t\t\t\t\t? parsed
\t\t\t\t\t: await this.#parseAsClientError(preserved.clone())
\t\t\t\treturn { data: null, error, response: preserved, status: response.status }
\t\t\t}
\t\t\tlet data: unknown
\t\t\ttry {
\t\t\t\tdata = await this.#parseBody(response)
\t\t\t} catch (e) {
\t\t\t\treturn { data: null, error: e, response, status: response.status }
\t\t\t}
\t\t\treturn { data, error: null, response, status: response.status }
\t\t} finally {
\t\t\tdone()
\t\t}
\t}
`
}

function sdkClientRequest(): string {
	return `
\tasync #request(entry: _ServiceEntry, input: Record<string, unknown>): Promise<unknown> {
\t\tconst path = this.#toColonParams(entry.path, entry.wildcard)
\t\tconst method = entry.method
\t\t/* a copy: the caller's input object is never written to, so reusing it never reuses a key */
\t\tconst opts = { ...input } as _RequestOptions
\t\tif (entry.idempotent) {
\t\t\tconst existing = opts.headers?.["Idempotency-Key"] ?? opts.headers?.["idempotency-key"]
\t\t\tif (existing === undefined) {
\t\t\t\tconst key = opts.idempotencyKey ?? this.#newRequestId()
\t\t\t\topts.headers = { ...(opts.headers ?? {}), "Idempotency-Key": key }
\t\t\t}
\t\t}
\t\tconst params = opts.params
\t\tlet cp: string
\t\ttry {
\t\t\tcp = this.#interpolatePath(path, params)
\t\t} catch (e) {
\t\t\tif (!(e instanceof _PathParamError)) throw e
\t\t\tconst err = new _ClientError({
\t\t\t\tbody: null,
\t\t\t\tdata: null,
\t\t\t\tmessage: \`\${e.message} for \${method} \${entry.path}\`,
\t\t\t\tresponse: Response.error(),
\t\t\t\tstatus: 0,
\t\t\t})
\t\t\tif (!this.#config.throwOnError) return { data: null, error: err, response: err.response, status: 0 }
\t\t\tthrow err
\t\t}
\t\tconst cs = \`\${method} \${cp}\`
\t\tconst requestMeta = this.#buildRequestMeta(cs, cp, method)
\t\tif (!this.#config.throwOnError) {
\t\t\tconst r = await this.#requestSafe(method, path, opts, requestMeta)
\t\t\tif (r.status >= 200 && r.status < 300) {
\t\t\t\tthis.#markStale(entry.invalidate??[], params, cs)
\t\t\t\tif (requestMeta?.isStale) this.#clearStale(cs, cp, method, requestMeta.seqSnapshot)
\t\t\t}
\t\t\treturn r
\t\t}
\t\tconst data = await this.#requestThrow(method, path, opts, requestMeta)
\t\tthis.#markStale(entry.invalidate??[], params, cs)
\t\tif (requestMeta?.isStale) this.#clearStale(cs, cp, method, requestMeta?.seqSnapshot ?? 0)
\t\treturn data
\t}
`
}

function sdkClientRequestSSE(): string {
	return `
\t#requestSSE(entry: _ServiceEntry, path: string, opts: _RequestOptions): AsyncIterable<_SSEEvent> {
\t\treturn { [Symbol.asyncIterator]: () => this.#doSSE(entry, path, opts) }
\t}
`
}

function sdkClientConnectWS(): string {
	return `
\t#connectWS(entry: _ServiceEntry, path: string, opts: _RequestOptions): _TypedWebSocket {
\t\tconst built = new URL(this.#buildURL(path, opts))
\t\t/* only the scheme changes: an https URL elsewhere in the query is left alone */
\t\tif (built.protocol === "https:") built.protocol = "wss:"
\t\telse if (built.protocol === "http:") built.protocol = "ws:"
\t\tif (opts.reconnectToken) built.searchParams.append("reconnect_token", opts.reconnectToken)
\t\tconst ws = this.#createTypedWebSocket(built.toString(), opts.protocols)
\t\tif (entry.invalidate && entry.invalidate.length > 0) {
\t\t\tconst invalidate = entry.invalidate
\t\t\tconst params = opts.params
\t\t\tconst cs = \`WS \${this.#interpolatePath(path, params)}\`
\t\t\tws.on("open", () => this.#markStale(invalidate, params, cs))
\t\t}
\t\treturn ws
\t}
`
}

function sdkClientBuildRequestMeta(): string {
	return `
\t#buildRequestMeta(concreteSelector: string, concretePath: string, method: string): _RequestMeta | undefined {
\t\tif (!this.#staleUntil) return undefined
\t\tconst now = Date.now()
\t\tconst { by, isStale } = this.#lookupStale(concreteSelector, concretePath, method, now)
\t\treturn { invalidatedBy: by, isStale, selector: concreteSelector, seqSnapshot: this.#invalidationSeq }
\t}
`
}

function sdkClientMarkStale(): string {
	return `
\t#markStale(invalidate: readonly string[], params: Record<string, string> | undefined, mutationSelector: string): void {
\t\tconst exactTable = this.#staleUntil
\t\tif (!exactTable || invalidate.length === 0) return
\t\tconst seq = ++this.#invalidationSeq
\t\tconst until = Date.now() + this.#staleTime
\t\tfor (const target of this.#resolveInvalidationTargets(invalidate, params)) {
\t\t\tconst spaceIdx = target.indexOf(" ")
\t\t\tconst method = target.slice(0, spaceIdx)
\t\t\tconst isPattern = this.#hasPlaceholder(target.slice(spaceIdx + 1))
\t\t\tlet table: Map<string, _StaleEntry>
\t\t\tif (isPattern) {
\t\t\t\ttable = this.#stalePatterns.get(method) ?? new Map<string, _StaleEntry>()
\t\t\t\tthis.#stalePatterns.set(method, table)
\t\t\t} else {
\t\t\t\ttable = exactTable
\t\t\t}
\t\t\tconst existing = table.get(target)
\t\t\tif (existing) {
\t\t\t\tif (!existing.by.includes(mutationSelector)) {
\t\t\t\t\texisting.by.push(mutationSelector)
\t\t\t\t\tif (existing.by.length > this.#maxSourcesPerTarget) existing.by.shift()
\t\t\t\t}
\t\t\t\texisting.until = until
\t\t\t\texisting.seq = seq
\t\t\t\t/* a new mutation re-marks every instance */
\t\t\t\texisting.refreshed?.clear()
\t\t\t} else {
\t\t\t\ttable.set(target, { by: [mutationSelector], refreshed: isPattern ? new Set<string>() : undefined, seq, until })
\t\t\t}
\t\t}
\t\tif (exactTable.size > this.#staleMaxEntries) {
\t\t\tconst now = Date.now()
\t\t\tfor (const [k, entry] of exactTable) if (entry.until <= now) exactTable.delete(k)
\t\t\t/* still over: drop the oldest marks */
\t\t\tfor (const k of exactTable.keys()) {
\t\t\t\tif (exactTable.size <= this.#staleMaxEntries) break
\t\t\t\texactTable.delete(k)
\t\t\t}
\t\t}
\t}
`
}

function sdkClientClearStale(): string {
	return `
\t/* a successful stale read clears that resource only: its exact mark, and this path's share of a pattern mark */
\t#clearStale(concreteSelector: string, concretePath: string, method: string, seqSnapshot: number): void {
\t\tif (!this.#staleUntil) return
\t\tconst exact = this.#staleUntil.get(concreteSelector)
\t\tif (exact && exact.seq <= seqSnapshot) this.#staleUntil.delete(concreteSelector)
\t\tconst table = this.#stalePatterns.get(method)
\t\tif (!table) return
\t\tfor (const [key, entry] of table) {
\t\t\tif (entry.seq > seqSnapshot || !entry.refreshed) continue
\t\t\tif (!this.#pathMatchesPattern(concretePath, key.slice(key.indexOf(" ") + 1))) continue
\t\t\tif (entry.refreshed.size >= 1024) {
\t\t\t\tconst oldest = entry.refreshed.values().next().value
\t\t\t\tif (oldest !== undefined) entry.refreshed.delete(oldest)
\t\t\t}
\t\t\tentry.refreshed.add(concretePath)
\t\t}
\t}
`
}

function sdkClientDispose(): string {
	return `
\tdispose(): void {
\t\tif (this.#disposed) return
\t\tthis.#disposed = true
\t\tthis.#disposeCtrl.abort()
\t\tthis.#staleUntil?.clear()
\t\tthis.#stalePatterns.clear()
\t\tthis.#resourceCache.clear()
\t\tthis.#patternRegexCache.clear()
\t}
`
}

function sdkClientDoSSE(): string {
	return `
\tasync *#doSSE(entry: _ServiceEntry, path: string, opts: _RequestOptions): AsyncGenerator<_SSEEvent> {
\t\tconst method = entry.method
\t\tconst url = this.#buildURL(path, opts)
\t\tconst headers = await this.#buildHeaders(opts, { method, path })
\t\theaders.set("accept", "text/event-stream")
\t\tif (opts.lastEventId) {
\t\t\theaders.set("last-event-id", opts.lastEventId)
\t\t}
\t\t/* a streamed operation carries its body like any other request */
\t\tlet body = this.#buildBody(opts, headers)
\t\tconst { signal, cleanup } = this.#buildSignal(opts, true)
\t\ttry {
\t\t\tif (this.#config.onRequest) {
\t\t\t\tconst reqCtx: { body?: BodyInit; headers: Headers; invalidatedBy?: string[]; isStale?: boolean; method: string; path: string; selector?: string; state: Record<string, unknown>; url: string } = { body, headers, method, path, state: this.#config.state ?? {}, url }
\t\t\t\tfor (const hook of this.#config.onRequest) {
\t\t\t\t\tawait hook(reqCtx)
\t\t\t\t}
\t\t\t\tif (reqCtx.body !== body) body = reqCtx.body
\t\t\t}
\t\t\tconst sseInit = this.#requestInit({ body, headers, method, signal })
\t\t\tif (this.#config.credentials) sseInit.credentials = this.#config.credentials
\t\t\tif (this.#config.mode) sseInit.mode = this.#config.mode
\t\t\tsignal?.throwIfAborted()
\t\t\tlet response = await this.#fetchFn(url, sseInit)
\t\t\tif (this.#config.onResponse) {
\t\t\t\tconst resCtx: { invalidatedBy?: string[]; isRetry: boolean; isStale?: boolean; method: string; path: string; request: Request; response: Response; retry: () => Promise<Response>; selector?: string; state: Record<string, unknown>; url: string } = {
\t\t\t\t\tisRetry: false, method, path, request: this.#hookRequest(url, sseInit), response,
\t\t\t\t\tretry: () => { throw new Error("SSE streams do not support retry") },
\t\t\t\t\tstate: this.#config.state ?? {}, url,
\t\t\t\t}
\t\t\t\tfor (const hook of this.#config.onResponse) {
\t\t\t\t\tconst result = await hook(resCtx)
\t\t\t\t\tif (result instanceof Response) { response = result; resCtx.response = result }
\t\t\t\t}
\t\t\t}
\t\t\tif (!response.ok) {
\t\t\t\tthrow await this.#parseAsClientError(response)
\t\t\t}
\t\t\tif (entry.invalidate && entry.invalidate.length > 0) {
\t\t\t\tconst cs = \`\${method} \${this.#interpolatePath(path, opts.params)}\`
\t\t\t\tthis.#markStale(entry.invalidate, opts.params, cs)
\t\t\t}
\t\t\tif (!response.body) return
\t\t\tyield* this.#parseSSE(response.body)
\t\t} finally {
\t\t\tcleanup()
\t\t}
\t}
`
}

function sdkClientParseSSEBlock(): string {
	return `
\t/* Keep in sync with client/sse.ts — the WHATWG event-stream rules: lines end at CRLF, LF or CR;
\t   a leading BOM is skipped; id is sticky and ignored if it holds NUL; retry is digits only; an
\t   event still open when the stream ends is discarded, never dispatched. */
\tasync *#parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<_SSEEvent> {
\t\tconst decoder = new TextDecoder()
\t\tconst reader = stream.getReader()
\t\tconst maxBuffer = this.#sseMaxBufferChars
\t\tlet pending = ""
\t\tlet first = true
\t\tlet data: string[] = []
\t\tlet dataSize = 0
\t\tlet hasData = false
\t\tlet event: string | undefined
\t\tlet lastId = ""
\t\tlet retry: number | undefined
\t\tconst dispatch = (): _SSEEvent | undefined => {
\t\t\tconst out: _SSEEvent | undefined = hasData ? { data: data.join("\\n") } : undefined
\t\t\tif (out) {
\t\t\t\tif (event !== undefined && event !== "") out.event = event
\t\t\t\tif (lastId !== "") out.id = lastId
\t\t\t\tif (retry !== undefined) out.retry = retry
\t\t\t\tretry = undefined
\t\t\t}
\t\t\tdata = []
\t\t\tdataSize = 0
\t\t\thasData = false
\t\t\tevent = undefined
\t\t\treturn out
\t\t}
\t\tconst processLine = (line: string): void => {
\t\t\tif (line.charCodeAt(0) === 58) return
\t\t\tconst colon = line.indexOf(":")
\t\t\tconst field = colon === -1 ? line : line.slice(0, colon)
\t\t\tlet value = colon === -1 ? "" : line.slice(colon + 1)
\t\t\tif (value.charCodeAt(0) === 32) value = value.slice(1)
\t\t\tswitch (field) {
\t\t\t\tcase "data":
\t\t\t\t\tdataSize += value.length + 1
\t\t\t\t\tif (dataSize > maxBuffer) throw new Error(\`SSE event exceeded \${maxBuffer} characters\`)
\t\t\t\t\tdata.push(value)
\t\t\t\t\thasData = true
\t\t\t\t\tbreak
\t\t\t\tcase "event":
\t\t\t\t\tevent = value
\t\t\t\t\tbreak
\t\t\t\tcase "id":
\t\t\t\t\tif (!value.includes("\\0")) lastId = value
\t\t\t\t\tbreak
\t\t\t\tcase "retry":
\t\t\t\t\tif (/^\\d+$/.test(value)) retry = Number(value)
\t\t\t\t\tbreak
\t\t\t}
\t\t}
\t\ttry {
\t\t\twhile (true) {
\t\t\t\tconst { done, value } = await reader.read()
\t\t\t\tif (done) break
\t\t\t\tpending += decoder.decode(value, { stream: true })
\t\t\t\tif (first && pending.length > 0) {
\t\t\t\t\tif (pending.charCodeAt(0) === 0xfeff) pending = pending.slice(1)
\t\t\t\t\tfirst = false
\t\t\t\t}
\t\t\t\tlet start = 0
\t\t\t\twhile (start < pending.length) {
\t\t\t\t\tlet end = start
\t\t\t\t\twhile (end < pending.length) {
\t\t\t\t\t\tconst c = pending.charCodeAt(end)
\t\t\t\t\t\tif (c === 10 || c === 13) break
\t\t\t\t\t\tend++
\t\t\t\t\t}
\t\t\t\t\tif (end === pending.length) break
\t\t\t\t\t/* a CR as the last character may be the first half of CRLF */
\t\t\t\t\tif (pending.charCodeAt(end) === 13 && end === pending.length - 1) break
\t\t\t\t\tconst line = pending.slice(start, end)
\t\t\t\t\tstart = end + (pending.charCodeAt(end) === 13 && pending.charCodeAt(end + 1) === 10 ? 2 : 1)
\t\t\t\t\tif (line === "") {
\t\t\t\t\t\tconst out = dispatch()
\t\t\t\t\t\tif (out) yield out
\t\t\t\t\t} else {
\t\t\t\t\t\tprocessLine(line)
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tpending = pending.slice(start)
\t\t\t\tif (pending.length > maxBuffer) throw new Error(\`SSE buffer exceeded \${maxBuffer} characters\`)
\t\t\t}
\t\t\t/* a lone CR held back at the end of the stream still terminates its line */
\t\t\tif (pending === "\\r") {
\t\t\t\tconst out = dispatch()
\t\t\t\tif (out) yield out
\t\t\t}
\t\t\t/* anything else still open is an incomplete event: discard it */
\t\t} finally {
\t\t\tawait reader.cancel().catch(() => {})
\t\t\treader.releaseLock()
\t\t}
\t}
`
}

function sdkClientFooter(): string {
	const reexports = ["\t_ClientError as ClientError,"]
		.concat(STATUS_ERROR_CLASSES.map(({ name }) => `\t_${name} as ${name},`))
		.join("\n")
	return `}

export {
${reexports}
}

export function isClientError(e: unknown): e is _ClientError {
\treturn e instanceof _ClientError
}
`
}

/** The IR every TypeScript SDK emitter reads: refs inlined, derived ids, duplicate ids refused. */
export function sdkIR(spec: OpenApiSpecInput): IR {
	return toIR(resolveRefs(spec), { deriveOperationIds: true, duplicateOperationIds: "throw" })
}

/** Flat `resource → action → entry` map of every operation, for SDK result objects. */
export function serviceMapOf(ir: IR): Record<string, Record<string, ServiceEntry>> {
	/* null-prototype: an operationId of "__proto__.x" must not reach Object.prototype */
	const serviceMap: Record<string, Record<string, ServiceEntry>> = Object.create(null)
	for (const op of ir.operations) {
		const segments = op.id.split(".")
		const resource = segments.length === 1 ? op.id : (segments[0] ?? op.id)
		const action = segments.length === 1 ? "_call" : segments.slice(1).join(".")
		if (!Object.hasOwn(serviceMap, resource)) serviceMap[resource] = Object.create(null)
		serviceMap[resource][action] = buildServiceEntryForOp(op)
	}
	return serviceMap
}

export function collectSDKMethods(
	spec: OpenApiSpecInput,
	/* toIR validates namespace collisions; an operation without an operationId gets a derived
	   one instead of silently vanishing from the SDK */
	ir = sdkIR(spec),
): {
	serviceMap: Record<string, Record<string, ServiceEntry>>
	nestedMap: Map<string, NestedServiceNode>
	methods: SDKMethod[]
} {
	const resolve = irResolver(ir.schemas)
	const methods: SDKMethod[] = []

	for (const op of ir.operations) {
		const operationId = op.id
		const segments = operationId.split(".")
		const isTopLevel = segments.length === 1
		const resource = isTopLevel ? operationId : (segments[0] ?? operationId)
		const action = isTopLevel ? "_call" : segments.slice(1).join(".")

		const inputResult = emitSDKInputType(op)
		methods.push({
			action,
			errorsByStatusType: emitSDKErrorsByStatusType(op, resolve),
			id: operationId,
			inputHasMandatory: inputResult.hasMandatory,
			inputType: inputResult.type,
			realtime: op.extensions.realtime === true,
			resource,
			responseType: emitSDKResponseType(op),
			sse: op.extensions.sse === true,
			ws: op.extensions.websocket === true,
		})
	}

	const nestedMap = buildNestedServiceMap(safeMemberTree(ir.tree, true))
	return { methods, nestedMap, serviceMap: serviceMapOf(ir) }
}

function buildServiceEntryForOp(op: IROperation): ServiceEntry {
	const params = openApiPathParams(op.path)
	const entry: ServiceEntry = { method: op.method, path: op.path }
	if (params.length > 0) entry.params = params
	const wildcard = op.params.path.find((p) => p.wildcard === true)
	if (wildcard) entry.wildcard = wildcard.name
	if (op.extensions.sse) entry.sse = true
	if (op.extensions.websocket) entry.ws = true
	if (op.extensions.realtime) entry.realtime = true
	if (op.extensions.idempotencyKey) entry.idempotent = true
	const inv = op.extensions.invalidates
	if (inv && inv.length > 0) entry.invalidate = inv
	return entry
}

/** Members a generated client already has; a resource of the same name would hide them. */
const SDK_ROOT_MEMBERS = new Set(["dispose", "state"])

/**
 * Names JavaScript machinery reads off any object: a `then` member makes the client a
 * thenable, `toString` breaks `String(sdk)`, `__proto__` sets the prototype.
 */
const SDK_OBJECT_MEMBERS = new Set([
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
	"__proto__",
	"constructor",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"then",
	"toJSON",
	"toLocaleString",
	"toString",
	"valueOf",
])

/**
 * The resource tree with every member name a client can expose. A name that would shadow a
 * client member or an `Object.prototype` name gets a trailing `_` (`state` → `state_`), the
 * same rename in the interface and the service map, so types and runtime agree.
 */
function safeMemberTree(ns: IRNamespace, root: boolean): IRNamespace {
	const entries = new Map<string, IRNamespace["entries"] extends Map<string, infer E> ? E : never>()
	const sorted = [...ns.entries.entries()].sort(([a], [b]) => compareCodeUnits(a, b))
	for (const [key, entry] of sorted) {
		let name = key
		if ((root && SDK_ROOT_MEMBERS.has(key)) || SDK_OBJECT_MEMBERS.has(key)) {
			name = `${key}_`
			while (ns.entries.has(name) || entries.has(name)) name += "_"
		}
		entries.set(name, entry.kind === "namespace" ? { kind: "namespace", ns: safeMemberTree(entry.ns, false) } : entry)
	}
	return { entries }
}

/**
 * The member path of every operation on a generated TypeScript client, after the renames
 * `safeMemberTree` applies: `["state_", "get"]` for an operation `state.get`. A namespace whose
 * only method is `_call` is callable itself, so its path ends at the namespace.
 */
export function sdkMemberPaths(ir: IR): Map<string, string[]> {
	const out = new Map<string, string[]>()
	const walk = (ns: IRNamespace, prefix: string[]): void => {
		const methods = methodsOf(ns)
		for (const [key, entry] of ns.entries) {
			if (entry.kind === "namespace") {
				walk(entry.ns, [...prefix, key])
			} else if (key !== "_call") {
				out.set(entry.op.id, [...prefix, key])
			} else if (methods.length === 1) {
				/* the interface promotes a lone `_call` to the namespace itself and drops any other */
				out.set(entry.op.id, prefix)
			}
		}
	}
	walk(safeMemberTree(ir.tree, true), [])
	return out
}

function buildNestedServiceMap(ns: IRNamespace): Map<string, NestedServiceNode> {
	function walkNs(namespace: IRNamespace): Map<string, NestedServiceNode> {
		const map = new Map<string, NestedServiceNode>()
		for (const [key, entry] of [...namespace.entries.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
			if (entry.kind === "method") map.set(key, { entry: buildServiceEntryForOp(entry.op), kind: "leaf" })
			else map.set(key, { children: walkNs(entry.ns), kind: "ns" })
		}
		return map
	}

	return walkNs(ns)
}

const TS_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The SDK class name lands in source, the stem in import specifiers and file names. */
function validateSdkNames(name: string, stem: string): void {
	if (!TS_IDENTIFIER.test(name) || SDK_TS_RESERVED.has(name)) {
		throw new Error(`generateSDK: name ${JSON.stringify(name)} is not a TypeScript identifier`)
	}
	if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(stem)) {
		throw new Error(
			`generateSDK: stem ${JSON.stringify(stem)} must be a plain file name (letters, digits, ".", "_", "-")`,
		)
	}
}

export function generateSDK(spec: OpenApiSpecInput, options?: { name?: string; stem?: string }): GeneratedSDK {
	const sdkName = options?.name ?? "SDK"
	const stem = options?.stem ?? "sdk"
	validateSdkNames(sdkName, stem)
	const ir = sdkIR(spec)
	const { methods: sdkMethods, nestedMap, serviceMap } = collectSDKMethods(spec, ir)
	const hasRealtime = sdkMethods.some((m) => m.realtime)
	const fullMethodLookup = new Map<string, SDKMethod>()
	for (const m of sdkMethods) fullMethodLookup.set(m.id, m)

	return {
		files: {
			client: buildSDKClient(sdkName, stem),
			index: buildSDKIndex(sdkName, stem),
			map: buildSDKMap(nestedMap),
			runtime: hasRealtime ? buildSDKRuntime() : null,
			types: buildSDKTypes(sdkName, sdkMethods, safeMemberTree(ir.tree, true), fullMethodLookup),
		},
		serviceMap,
	}
}
