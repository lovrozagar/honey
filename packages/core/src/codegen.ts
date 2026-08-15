import {
	deriveErrorEnvelopeName,
	deriveSchemaName,
	isErrorEnvelope,
	shortHash,
} from "./codegen-schema-naming.ts"
import type { SchemaNameContext } from "./codegen-schema-naming.ts"
import { methodsOf, namespacesOf, schemaToIR, toIR } from "./codegen-ir.ts"
import type { IRNamespace } from "./codegen-ir.ts"
import type { HoneyError } from "./error.ts"
import { ERROR_META } from "./errors.ts"
import type { ErrorMetaEntry } from "./errors.ts"
import type { Honey } from "./index.ts"
import type { RouteHandler, TreeNode } from "./tree.ts"
import { irToTs } from "./ts-type-emitter.ts"
import { emitSchemaType } from "./type-emitter.ts"
import type {
	InputSchemaEntry,
	InputSchemasDef,
	OutputSchemaDef,
	StandardSchemaLike,
} from "./types.ts"
import { EMPTY_OBJ, statusKeyToCode } from "./types.ts"

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

let _toJSONSchema: ((schema: unknown, opts?: { io?: "input" | "output" }) => unknown) | undefined
let _toJSONSchemaLoaded = false

async function loadToJSONSchema(): Promise<
	((schema: unknown, opts?: { io?: "input" | "output" }) => unknown) | undefined
> {
	if (_toJSONSchemaLoaded) return _toJSONSchema
	_toJSONSchemaLoaded = true
	try {
		const id = "zod"
		const zod = await import(id)
		if (typeof zod.toJSONSchema === "function") {
			_toJSONSchema = zod.toJSONSchema as (
				schema: unknown,
				opts?: { io?: "input" | "output" },
			) => unknown
		}
	} catch {
		/* zod not available */
	}
	return _toJSONSchema
}

let _effectJsonSchema: ((schema: unknown) => unknown) | undefined
let _effectLoaded = false

async function loadEffectJsonSchema(): Promise<((schema: unknown) => unknown) | undefined> {
	if (_effectLoaded) return _effectJsonSchema
	_effectLoaded = true
	try {
		const id = "effect"
		const effect = await import(id)
		if (effect.JSONSchema && typeof effect.JSONSchema.make === "function") {
			_effectJsonSchema = effect.JSONSchema.make as (schema: unknown) => unknown
		}
	} catch {
		/* effect not available */
	}
	return _effectJsonSchema
}

/**
 * Pre-warm dynamic JSON Schema loaders (zod, effect). Safe to call multiple times;
 * both loaders cache their result. Required before invoking any sync codegen entrypoint
 * (`generateRouteTree`, `generateRouteTreeFromApp`, `generateRouteTreeFromRouteTree`)
 * on an app whose schemas are Zod or Effect — otherwise `schemaToJsonSchema` falls back
 * to metadata-only `introspectSchema`.
 */
export async function prepareCodegen(): Promise<void> {
	await Promise.all([loadToJSONSchema(), loadEffectJsonSchema()])
}

/* ---- Valibot → JSON Schema converter ---- */

type ValibotSchema = Record<string, unknown> & { type: string }

function valibotToJsonSchema(schema: unknown): unknown {
	const s = schema as ValibotSchema
	const t = s.type

	switch (t) {
		case "string":
			return { type: "string" }
		case "number":
			return { type: "number" }
		case "boolean":
			return { type: "boolean" }
		case "bigint":
			return { type: "integer" }
		case "date":
			return { format: "date-time", type: "string" }
		case "undefined":
		case "void":
			return {}
		case "null":
			return { type: "null" }
		case "any":
		case "unknown":
			return {}
		case "literal": {
			const val = s.literal
			return { const: val }
		}
		case "object": {
			const entries = s.entries as Record<string, unknown>
			const keys = Object.keys(entries)
			if (keys.length === 0) return { type: "object" }
			const properties: Record<string, unknown> = {}
			const required: string[] = []
			for (const k of keys) {
				const entry = entries[k] as ValibotSchema
				if (entry.type === "optional") {
					properties[k] = valibotToJsonSchema(entry.wrapped as unknown)
				} else {
					properties[k] = valibotToJsonSchema(entry)
					required.push(k)
				}
			}
			const result: Record<string, unknown> = { properties, type: "object" }
			if (required.length > 0) result.required = required
			return result
		}
		case "array":
			return { items: valibotToJsonSchema(s.item as unknown), type: "array" }
		case "optional":
			return valibotToJsonSchema(s.wrapped as unknown)
		case "nullable": {
			const inner = valibotToJsonSchema(s.wrapped as unknown) as Record<string, unknown>
			return { anyOf: [inner, { type: "null" }] }
		}
		case "nullish": {
			const inner = valibotToJsonSchema(s.wrapped as unknown) as Record<string, unknown>
			return { anyOf: [inner, { type: "null" }] }
		}
		case "union":
			return {
				anyOf: (s.options as unknown[]).map((o) => valibotToJsonSchema(o)),
			}
		case "intersect":
			return {
				allOf: (s.options as unknown[]).map((o) => valibotToJsonSchema(o)),
			}
		case "picklist":
			return { enum: s.options }
		case "enum": {
			const enumObj = s.enum as Record<string, string>
			return { enum: Object.values(enumObj) }
		}
		case "record": {
			return {
				additionalProperties: valibotToJsonSchema(s.value as unknown),
				type: "object",
			}
		}
		case "tuple": {
			const items = (s.items as unknown[]).map((i) => valibotToJsonSchema(i))
			return {
				items,
				maxItems: items.length,
				minItems: items.length,
				type: "array",
			}
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
				items,
				maxItems: items.length,
				minItems: items.length,
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
	if (_effectJsonSchema) {
		try {
			return _effectJsonSchema(schema)
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

type OpenApiInfo = {
	description?: string
	title: string
	version: string
}

export type OpenApiSpec = {
	components?: {
		schemas?: Record<string, Record<string, unknown>>
		securitySchemes?: Record<string, unknown>
	}
	info: OpenApiInfo
	openapi: string
	paths: Record<string, Record<string, Record<string, unknown>>>
}

function extractParams(path: string): string[] {
	const params: string[] = []
	for (const seg of path.split("/")) {
		if (seg.startsWith(":")) {
			params.push(seg.endsWith("?") ? seg.slice(1, -1) : seg.slice(1))
		}
	}
	return params
}

function toOpenApiPath(path: string): string {
	return path.replace(/:(\w+)\??/g, "{$1}")
}

type CollectedRoute = {
	handler: RouteHandler
	method: string
	path: string
}

function walkTree(
	node: TreeNode,
	currentPath: string,
	routes: CollectedRoute[],
	includeSkipped?: boolean,
): void {
	if (node.m !== null) {
		for (const [method, handler] of Object.entries(node.m)) {
			if (handler._skip && !includeSkipped) continue
			routes.push({ handler, method, path: currentPath || "/" })
		}
	}

	for (const [seg, child] of Object.entries(node.s)) {
		walkTree(child, `${currentPath}/${seg}`, routes, includeSkipped)
	}

	if (node.d !== null) {
		walkTree(node.d.c, `${currentPath}/:${node.d.n}`, routes, includeSkipped)
	}

	if (node.w !== null) {
		for (const [method, handler] of Object.entries(node.w.m)) {
			if (handler._skip && !includeSkipped) continue
			routes.push({ handler, method, path: `${currentPath}/*${node.w.n}` })
		}
	}
}

type CollectedWSRoute = {
	handler: import("./tree.ts").WSRouteHandler
	path: string
}

function walkWSRoutes(node: TreeNode, currentPath: string, routes: CollectedWSRoute[]): void {
	if (node.ws !== null) {
		routes.push({ handler: node.ws, path: currentPath || "/" })
	}
	for (const [seg, child] of Object.entries(node.s)) {
		walkWSRoutes(child, `${currentPath}/${seg}`, routes)
	}
	if (node.d !== null) {
		walkWSRoutes(node.d.c, `${currentPath}/:${node.d.n}`, routes)
	}
}

type ErrorInfo = { errorKey: string; status: number; statusKey: string }

function resolveErrorInfo(
	errorKey: string,
	factory: Record<string, () => HoneyError> | null,
): ErrorInfo {
	if (factory?.[errorKey]) {
		try {
			const err = factory[errorKey]()
			return { errorKey, status: err.status, statusKey: err.statusKey }
		} catch {
			/* factory call failed */
		}
	}
	return { errorKey, status: 0, statusKey: "unknown" }
}

function getErrorFactory<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
): Record<string, () => HoneyError> | null {
	return (app as unknown as { _errorFactory: Record<string, () => HoneyError> | null })
		._errorFactory
}

export const DEFAULT_ERROR_JSON_SCHEMA: Record<string, unknown> = {
	properties: {
		error_key: { type: "string" },
		fields: {
			additionalProperties: {
				items: {
					properties: {
						error_key: { type: "string" },
						message: { type: "string" },
						path: { type: "string" },
					},
					required: ["error_key", "message", "path"],
					type: "object",
				},
				type: "array",
			},
			type: "object",
		},
		message: { type: "string" },
		status: { type: "integer" },
		status_key: { type: "string" },
		success: { const: false },
	},
	required: ["error_key", "fields", "message", "status", "status_key", "success"],
	type: "object",
}

function getErrorSchema<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
): StandardSchemaLike | null {
	return (app as unknown as { _errorSchema: StandardSchemaLike | null })._errorSchema
}

function getCustomErrorSchema<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
): StandardSchemaLike | null {
	return (app as unknown as { _customErrorSchema: StandardSchemaLike | null })._customErrorSchema
}

function getErrorMeta(
	factory: Record<string, () => HoneyError> | null,
): Record<string, ErrorMetaEntry> | null {
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

/* Normalize security shorthand → standard OpenAPI security array */
export function normalizeSecurity(raw: unknown): Record<string, string[]>[] {
	if (typeof raw === "string") return [{ [raw]: [] }]
	if (!Array.isArray(raw)) return []
	if (raw.length === 0) return []
	if (raw.every((entry) => typeof entry === "string")) {
		return raw.map((entry) => ({ [entry]: [] }))
	}
	if (raw.every((entry) => Array.isArray(entry))) {
		return (raw as string[][]).map((group) =>
			Object.fromEntries(group.map((s) => [s, []])),
		)
	}
	if (raw.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))) {
		return raw as Record<string, string[]>[]
	}
	/* mixed shapes — refuse to guess */
	return []
}

/* Strip properties marked with x-internal from an object JSON schema */
function stripInternalProps(schema: Record<string, unknown>): Record<string, unknown> {
	const props = schema.properties as Record<string, Record<string, unknown>> | undefined
	if (!props) return schema
	const filtered: Record<string, unknown> = {}
	for (const [key, val] of Object.entries(props)) {
		if (val?.["x-internal"] === true) continue
		filtered[key] = val
	}
	const required = schema.required as string[] | undefined
	const result: Record<string, unknown> = { ...schema, properties: filtered }
	if (required) {
		result.required = required.filter((k) => filtered[k] !== undefined)
	}
	return result
}

export function canonicalizeSchema(schema: Record<string, unknown>): string {
	return JSON.stringify(schema, (_, value) => {
		if (value && typeof value === "object" && !Array.isArray(value)) {
			return Object.fromEntries(
				Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
			)
		}
		return value
	})
}

type SchemaSlot = {
	canonical: string
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

function collectSchemaSlots(
	paths: Record<string, Record<string, Record<string, unknown>>>,
): SchemaSlot[] {
	const slots: SchemaSlot[] = []

	for (const [pathKey, methods] of Object.entries(paths)) {
		for (const [method, operation] of Object.entries(methods)) {
			const op = operation as Record<string, unknown>
			const m = method.toLowerCase()

			const requestBody = op.requestBody as Record<string, unknown> | undefined
			if (requestBody) {
				const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
				if (content) {
					for (const mediaType of Object.values(content)) {
						const schema = mediaType.schema as Record<string, unknown> | undefined
						if (schema && !schema.$ref) {
							const context: SchemaNameContext = { method: m, path: pathKey, role: "request" }
							slots.push({ canonical: canonicalizeSchema(schema), context, pathKey, schema })
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
						for (const mediaType of Object.values(content)) {
							const schema = mediaType.schema as Record<string, unknown> | undefined
							if (schema && !schema.$ref) {
								const statusNum = Number(status)
								const context: SchemaNameContext = {
									method: m,
									path: pathKey,
									role: "response",
									status: statusNum,
								}
								slots.push({ canonical: canonicalizeSchema(schema), context, pathKey, schema })
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

function walkNestedObjects(
	schema: Record<string, unknown>,
	slotName: string,
	fieldPath: string[],
	nestedMap: Map<string, NestedEntry>,
	isEnvelopeOwner: boolean,
): void {
	const props = schema.properties as Record<string, unknown> | undefined
	if (!props) return
	for (const [key, val] of Object.entries(props)) {
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
	reservedNames: Set<string>,
): HoistedResult {
	const nestedMap = new Map<string, NestedEntry>()
	for (const slot of slots) {
		const slotName = slotNames.get(slot)
		/* Mark slots whose schema is an error envelope — their nested objects (e.g. `fields`)
		 * are env-specific and must not be named after the parent envelope's owner slot. */
		if (slotName)
			walkNestedObjects(slot.schema, slotName, [], nestedMap, isErrorEnvelope(slot.schema))
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
			return na.localeCompare(nb)
		})[0]

		const fieldPart = owner.fieldPath.map((f) => f.charAt(0).toUpperCase() + f.slice(1)).join("")
		let name = `${owner.slotName}${fieldPart}`
		if (reservedNames.has(name)) name = `${name}_${shortHash(canonical)}`
		if (schemas[name]) continue

		schemas[name] = entry.schema
		canonicalToName.set(canonical, name)
		reservedNames.add(name)
	}

	return { canonicalToName, schemas }
}

/*
 * Builds a new paths object by shallow-copying only the containers that need schema
 * replacement. Avoids structuredClone (which fails on arktype schemas containing
 * native functions). Original schema objects are dropped; only $ref objects are new.
 * Also rewrites nested inline object properties that were hoisted (canonicalToName).
 */

function rewriteNestedRefs(
	schema: Record<string, unknown>,
	canonicalToName: Map<string, string>,
): Record<string, unknown> {
	const props = schema.properties as Record<string, unknown> | undefined
	if (!props) return schema
	let newProps: Record<string, unknown> | undefined
	for (const [key, val] of Object.entries(props)) {
		if (!isObjectSchema(val)) continue
		const child = val as Record<string, unknown>
		const name = canonicalToName.get(canonicalizeSchema(child))
		if (!name) continue
		if (!newProps) newProps = { ...props }
		newProps[key] = { $ref: `#/components/schemas/${name}` }
	}
	if (!newProps) return schema
	return { ...schema, properties: newProps }
}

function rewritePathsToRefs(
	paths: Record<string, Record<string, Record<string, unknown>>>,
	slots: SchemaSlot[],
	slotNames: Map<SchemaSlot, string>,
	hoistedCanonicalToName: Map<string, string>,
): Record<string, Record<string, Record<string, unknown>>> {
	const ctxKey = (pathKey: string, method: string, role: string, status?: number): string =>
		`${pathKey}::${method}::${role}::${status ?? ""}`

	const lookup = new Map<string, string>()
	for (const slot of slots) {
		const name = slotNames.get(slot)
		if (name)
			lookup.set(
				ctxKey(slot.pathKey, slot.context.method, slot.context.role, slot.context.status),
				name,
			)
	}

	const newPaths: Record<string, Record<string, Record<string, unknown>>> = {}

	for (const [pathKey, methods] of Object.entries(paths)) {
		const newMethods: Record<string, Record<string, unknown>> = {}

		for (const [method, operation] of Object.entries(methods)) {
			const op = operation as Record<string, unknown>
			const m = method.toLowerCase()
			let newOp = op

			const requestBody = op.requestBody as Record<string, unknown> | undefined
			if (requestBody) {
				const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
				if (content) {
					const reqName = lookup.get(ctxKey(pathKey, m, "request"))
					const newContent: Record<string, Record<string, unknown>> = {}
					for (const [ct, mediaType] of Object.entries(content)) {
						const schema = mediaType.schema as Record<string, unknown> | undefined
						if (schema && !schema.$ref) {
							if (reqName) {
								newContent[ct] = {
									...mediaType,
									schema: { $ref: `#/components/schemas/${reqName}` },
								}
							} else if (hoistedCanonicalToName.size > 0) {
								newContent[ct] = {
									...mediaType,
									schema: rewriteNestedRefs(schema, hoistedCanonicalToName),
								}
							} else {
								newContent[ct] = mediaType
							}
						} else {
							newContent[ct] = mediaType
						}
					}
					if (Object.keys(newContent).length > 0) {
						newOp = { ...op, requestBody: { ...requestBody, content: newContent } }
					}
				}
			}

			const responses = (newOp as Record<string, unknown>).responses as
				| Record<string, Record<string, unknown>>
				| undefined
			if (responses) {
				let newResponses: Record<string, Record<string, unknown>> | undefined
				for (const [status, response] of Object.entries(responses)) {
					const content = (response as Record<string, unknown>).content as
						| Record<string, Record<string, unknown>>
						| undefined
					if (!content) continue
					const statusNum = Number(status)
					const respName = lookup.get(ctxKey(pathKey, m, "response", statusNum))
					const newContent: Record<string, Record<string, unknown>> = {}
					let changed = false
					for (const [ct, mediaType] of Object.entries(content)) {
						const schema = mediaType.schema as Record<string, unknown> | undefined
						if (schema && !schema.$ref) {
							if (respName) {
								newContent[ct] = {
									...mediaType,
									schema: { $ref: `#/components/schemas/${respName}` },
								}
								changed = true
							} else if (hoistedCanonicalToName.size > 0) {
								const rewritten = rewriteNestedRefs(schema, hoistedCanonicalToName)
								newContent[ct] = { ...mediaType, schema: rewritten }
								if (rewritten !== schema) changed = true
								else newContent[ct] = mediaType
							} else {
								newContent[ct] = mediaType
							}
						} else {
							newContent[ct] = mediaType
						}
					}
					if (changed) {
						if (!newResponses) newResponses = { ...responses }
						newResponses[status] = { ...(response as Record<string, unknown>), content: newContent }
					}
				}
				if (newResponses) newOp = { ...newOp, responses: newResponses }
			}

			newMethods[method] = newOp
		}

		newPaths[pathKey] = newMethods
	}

	return newPaths
}

export function deduplicateSchemas(spec: OpenApiSpec): OpenApiSpec {
	/* Sort paths lexicographically for determinism — input order must not affect output. */
	const sortedPaths: Record<string, Record<string, Record<string, unknown>>> = {}
	for (const key of Object.keys(spec.paths).sort()) sortedPaths[key] = spec.paths[key]

	const slots = collectSchemaSlots(sortedPaths)

	/* Group slots by canonical shape — same shape = one component. */
	const groups = new Map<string, SchemaSlot[]>()
	for (const slot of slots) {
		const existing = groups.get(slot.canonical)
		if (existing) existing.push(slot)
		else groups.set(slot.canonical, [slot])
	}

	/*
	 * Tier resolution per canonical group:
	 *   Tier 1: unique shape (group.length === 1) → operation-derived name
	 *   Tier 2: shared error envelope → Err{status}* name
	 *   Tier 3: shared non-error → first-slot operation-derived name
	 * Collision (two canonicals → same tier name) → hash suffix on second.
	 */
	const canonicalToName = new Map<string, string>()
	const nameToCanonical = new Map<string, string>()

	for (const [canonical, groupSlots] of groups) {
		const firstSlot = groupSlots[0]
		let name: string

		if (groupSlots.length === 1) {
			name = deriveSchemaName(firstSlot.context)
		} else if (isErrorEnvelope(firstSlot.schema)) {
			const fallbackStatus =
				firstSlot.context.role === "response" ? firstSlot.context.status : undefined
			name = deriveErrorEnvelopeName(firstSlot.schema, fallbackStatus)
		} else {
			name = deriveSchemaName(firstSlot.context)
		}

		/* Collision: different canonical claims same name → suffix second with hash. */
		const claimed = nameToCanonical.get(name)
		if (claimed !== undefined && claimed !== canonical) {
			name = `${name}_${shortHash(canonical)}`
		}
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
	const allTopLevelNames = new Set(slotNames.values())
	const { schemas: hoistedSchemas, canonicalToName: hoistedCanonicalToName } =
		collectHoistedSchemas(slots, slotNames, allTopLevelNames)

	/* Build components map, rewriting nested fields → $refs where hoisted */
	const extractedSchemas: Record<string, Record<string, unknown>> = {}
	const seenNames = new Set<string>()
	for (const slot of slots) {
		const name = slotNames.get(slot)
		if (name && !seenNames.has(name)) {
			seenNames.add(name)
			extractedSchemas[name] =
				hoistedCanonicalToName.size > 0
					? rewriteNestedRefs(slot.schema, hoistedCanonicalToName)
					: slot.schema
		}
	}
	Object.assign(extractedSchemas, hoistedSchemas)

	const hasNewSchemas = Object.keys(extractedSchemas).length > 0
	/* Nothing to extract and no existing components — return unchanged */
	if (!hasNewSchemas && !spec.components) return spec

	const paths =
		slotNames.size > 0 || hoistedCanonicalToName.size > 0
			? rewritePathsToRefs(sortedPaths, slots, slotNames, hoistedCanonicalToName)
			: sortedPaths

	const mergedSchemas = { ...spec.components?.schemas, ...extractedSchemas }
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

export function sanitizeOpenApiSpec(
	spec: OpenApiSpec,
	options: OpenApiSanitizeOptions,
): OpenApiSpec {
	const result = structuredClone(spec)

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

function resolveSchema(
	schema: Record<string, unknown>,
	schemas: Record<string, Record<string, unknown>>,
	visited = new Set<string>(),
): Record<string, unknown> {
	if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/components/schemas/")) {
		const name = schema.$ref.slice("#/components/schemas/".length)
		/* circular ref guard — return empty schema which maps to unknown in IR */
		if (visited.has(name)) return {}
		const resolved = schemas[name]
		if (!resolved) throw new Error(`$ref points to nonexistent component: ${schema.$ref}`)
		const next = new Set(visited)
		next.add(name)
		return resolveSchemaDeep(structuredClone(resolved), schemas, next)
	}
	return resolveSchemaDeep(schema, schemas, visited)
}

function resolveSchemaDeep(
	schema: Record<string, unknown>,
	schemas: Record<string, Record<string, unknown>>,
	visited: Set<string>,
): Record<string, unknown> {
	for (const key of ["oneOf", "anyOf", "allOf"] as const) {
		const arr = schema[key]
		if (Array.isArray(arr)) {
			schema[key] = arr.map((item: unknown) => {
				if (item && typeof item === "object" && !Array.isArray(item)) {
					return resolveSchema(item as Record<string, unknown>, schemas, visited)
				}
				return item
			})
		}
	}
	/* resolve array items */
	if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
		schema.items = resolveSchema(schema.items as Record<string, unknown>, schemas, visited)
	}
	/* resolve object properties */
	if (schema.properties && typeof schema.properties === "object") {
		const props = schema.properties as Record<string, unknown>
		for (const [k, v] of Object.entries(props)) {
			if (v && typeof v === "object" && !Array.isArray(v)) {
				props[k] = resolveSchema(v as Record<string, unknown>, schemas, visited)
			}
		}
	}
	/* resolve additionalProperties */
	if (schema.additionalProperties && typeof schema.additionalProperties === "object" && !Array.isArray(schema.additionalProperties)) {
		schema.additionalProperties = resolveSchema(schema.additionalProperties as Record<string, unknown>, schemas, visited)
	}
	return schema
}

export function resolveRefs(spec: OpenApiSpecInput): OpenApiSpecInput {
	const schemas = spec.components?.schemas
	if (!schemas || Object.keys(schemas).length === 0) return spec

	const paths = structuredClone(spec.paths)

	for (const methods of Object.values(paths)) {
		for (const operation of Object.values(methods)) {
			const op = operation as Record<string, unknown>

			const requestBody = op.requestBody as Record<string, unknown> | undefined
			if (requestBody) {
				const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
				if (content) {
					for (const [ct, mediaType] of Object.entries(content)) {
						const schema = mediaType.schema as Record<string, unknown> | undefined
						if (schema) content[ct] = { ...mediaType, schema: resolveSchema(schema, schemas) }
					}
				}
			}

			const responses = op.responses as Record<string, Record<string, unknown>> | undefined
			if (responses) {
				for (const [status, response] of Object.entries(responses)) {
					const content = response.content as Record<string, Record<string, unknown>> | undefined
					if (content) {
						for (const [ct, mediaType] of Object.entries(content)) {
							const schema = mediaType.schema as Record<string, unknown> | undefined
							if (schema) {
								responses[status] = {
									...response,
									content: {
										...content,
										[ct]: { ...mediaType, schema: resolveSchema(schema, schemas) },
									},
								}
							}
						}
					}
				}
			}
		}
	}

	const { schemas: _schemas, ...restComponents } = spec.components ?? {}
	const components = Object.keys(restComponents).length > 0 ? restComponents : undefined

	return { ...spec, components, paths }
}

/**
 * Convert schema to JSON Schema. Supports Zod (+ mini), Valibot, ArkType, Yup, and Effect.
 * Falls back to metadata for unknown StandardSchema vendors.
 */
/**
 * Post-process Zod's toJSONSchema output for OpenAPI compatibility:
 * - Strip $schema (top-level JSON Schema meta, invalid in inline OpenAPI)
 * - Convert anyOf → oneOf (API responses are exclusive unions, oneOf renders better in docs)
 */
function sanitizeZodJsonSchema(obj: Record<string, unknown>): void {
	delete obj["$schema"]
	if (Array.isArray(obj["anyOf"])) {
		obj["oneOf"] = obj["anyOf"]
		delete obj["anyOf"]
	}
	/* recurse into nested schemas */
	for (const val of Object.values(obj)) {
		if (val && typeof val === "object" && !Array.isArray(val)) {
			sanitizeZodJsonSchema(val as Record<string, unknown>)
		} else if (Array.isArray(val)) {
			for (const item of val) {
				if (item && typeof item === "object") {
					sanitizeZodJsonSchema(item as Record<string, unknown>)
				}
			}
		}
	}
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

	if (vendor === "zod" && _toJSONSchema) {
		try {
			const result = _toJSONSchema(schema, { io }) as Record<string, unknown>
			sanitizeZodJsonSchema(result)
			return result
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			const defType =
				(schema as { _zod?: { def?: { type?: string } } })?._zod?.def?.type ?? "unknown"
			console.warn(
				`[honey:codegen] schemaToJsonSchema failed for zod/${defType} (io=${io}): ${msg}. Falling back to metadata-only introspection.`,
			)
		}
	}

	if (vendor === "valibot") {
		return valibotToJsonSchema(schema)
	}

	if (vendor === "arktype") {
		return arkTypeToJsonSchema(schema)
	}

	if (vendor === "yup") {
		return yupToJsonSchema(schema)
	}

	if (vendor === "effect") {
		return effectToJsonSchema(schema)
	}

	return introspectSchema(schema)
}

function asJsonSchema(
	entry: StandardSchemaLike | Record<string, unknown>,
	io: "input" | "output" = "output",
): Record<string, unknown> {
	if (entry !== null && entry !== undefined && "~standard" in (entry as object)) {
		return schemaToJsonSchema(entry as StandardSchemaLike, io) as Record<string, unknown>
	}
	return entry as Record<string, unknown>
}

/* ---- Manifest generation ---- */

export function generateManifest<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
): RouteManifest {
	const tree = (app as unknown as { _tree: TreeNode })._tree
	const factory = getErrorFactory(app)
	const collected: CollectedRoute[] = []
	walkTree(tree, "", collected)

	const allErrorKeys = new Set<string>()

	const routes: RouteManifestEntry[] = collected.map(({ handler, method, path }) => {
		const entry: RouteManifestEntry = {
			errors: Array.from(handler.ek),
			meta: handler.mt ?? EMPTY_OBJ,
			method,
			middleware: handler.mw.map((mw) => mw.name || "anonymous"),
			params: extractParams(path),
			path,
		}

		for (const ek of handler.ek) {
			allErrorKeys.add(ek)
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
		errors: Array.from(allErrorKeys).map((key) => resolveErrorInfo(key, factory)),
		routes,
	}
}

/* ---- OpenAPI generation ---- */

export type OpenApiRouteInfo<TMeta = Record<string, unknown> | null> = {
	meta: TMeta
	method: string
	path: string
}

export async function generateOpenApi<TEnv, TCtx, TMeta = Record<string, unknown> | null>(
	app: Honey<TEnv, TCtx, unknown, TMeta, unknown, string, string>,
	options: {
		filterRoutes?: (route: OpenApiRouteInfo<TMeta>) => boolean
		info: OpenApiInfo
		securitySchemes?: Record<string, unknown>
	},
): Promise<OpenApiSpec> {
	await Promise.all([loadToJSONSchema(), loadEffectJsonSchema()])
	const factory = getErrorFactory(app)
	const errorMeta = getErrorMeta(factory)

	/* resolve error response schema — custom StandardSchema → JSON Schema, or default */
	const rawErrorSchema = getErrorSchema(app)
	const baseErrorJsonSchema = rawErrorSchema
		? (schemaToJsonSchema(rawErrorSchema) as Record<string, unknown>)
		: DEFAULT_ERROR_JSON_SCHEMA

	/* resolve custom error formatter schema (for merging into custom schema errors) */
	const rawCustomErrorSchema = getCustomErrorSchema(app)
	const customErrorAddsSchema = rawCustomErrorSchema
		? (schemaToJsonSchema(rawCustomErrorSchema) as Record<string, unknown>)
		: null

	const tree = (app as unknown as { _tree: TreeNode })._tree
	const collected: CollectedRoute[] = []
	walkTree(tree, "", collected)

	const routeFilter = options.filterRoutes
	const paths: Record<string, Record<string, Record<string, unknown>>> = {}

	for (const { handler, method, path } of collected) {
		if (routeFilter) {
			const meta = handler.mt as TMeta
			if (!routeFilter({ meta, method, path })) continue
		}
		const oaPath = toOpenApiPath(path)
		if (paths[oaPath] === undefined) {
			paths[oaPath] = {}
		}

		const methodKey = method.toLowerCase()
		const operation: Record<string, unknown> = {}
		const responses: Record<string, unknown> = {}
		const parameters: Array<Record<string, unknown>> = []

		/* meta → openApi operation fields (flat on meta) */
		const meta = handler.mt as Record<string, unknown> | null
		if (meta?.summary) operation.summary = meta.summary
		if (meta?.description) operation.description = meta.description
		if (meta?.tags) operation.tags = typeof meta.tags === "string" ? [meta.tags] : meta.tags
		if (meta?.deprecated) operation.deprecated = meta.deprecated
		if (meta?.operationId) operation.operationId = meta.operationId
		if (meta?.security) operation.security = normalizeSecurity(meta.security)
		const inv = meta?.invalidate
		if (Array.isArray(inv) && inv.length > 0) operation["x-invalidate"] = inv
		if (meta?.mcp === true) operation["x-mcp"] = true

		/* path params */
		const params = extractParams(path)
		for (const name of params) {
			const isOptional = path.includes(`:${name}?`)
			parameters.push({
				in: "path",
				name,
				required: !isOptional,
				schema: { type: "string" },
			})
		}

		/* input → requestBody / parameters */
		if (handler.iv) {
			for (const [source, entry] of Object.entries(handler.iv)) {
				if (entry === undefined) continue
				const unwrapped =
					"~standard" in (entry as object)
						? unwrapEntry(entry as InputSchemaEntry)
						: (entry as Record<string, unknown>)
				const jsonSchema = asJsonSchema(unwrapped, "input")

				if (source === "json" || source === "form") {
					const ct = source === "form" ? "application/x-www-form-urlencoded" : "application/json"
					operation.requestBody = {
						content: { [ct]: { schema: stripInternalProps(jsonSchema) } },
						required: true,
					}
				} else if (source === "search" || source === "headers" || source === "cookies") {
					let location: "cookie" | "header" | "query" = "cookie"
					if (source === "search") location = "query"
					else if (source === "headers") location = "header"
					/* decompose object schema properties into individual parameters */
					const props = jsonSchema.properties as Record<string, unknown> | undefined
					const required = (jsonSchema.required as string[]) ?? []
					if (props) {
						for (const [propName, propSchema] of Object.entries(props)) {
							if ((propSchema as Record<string, unknown>)?.["x-internal"] === true) continue
							parameters.push({
								in: location,
								name: propName,
								required: required.includes(propName),
								schema: propSchema,
							})
						}
					}
				} else if (source === "params") {
					/* override path param schemas with actual schema types */
					const props = jsonSchema.properties as Record<string, unknown> | undefined
					if (props) {
						for (const param of parameters) {
							const propSchema = props[param.name as string]
							if (propSchema && param.in === "path") {
								param.schema = propSchema
							}
						}
					}
				}
			}
		}

		if (parameters.length > 0) {
			operation.parameters = parameters
		}

		/* output → responses */
		if (handler.os) {
			for (const [contentType, schemas] of Object.entries(handler.os)) {
				if (schemas === undefined) continue
				if (contentType === "redirect") {
					for (const statusKey of Object.keys(schemas)) {
						const statusCode = statusKeyToCode[statusKey as keyof typeof statusKeyToCode]
						if (statusCode) {
							responses[String(statusCode)] = {
								description: statusKey.replace(/_/g, " "),
								headers: {
									Location: {
										description: "Redirect target URL",
										schema: { format: "uri", type: "string" },
									},
								},
							}
						}
					}
					continue
				}
				for (const [statusKey, schema] of Object.entries(schemas)) {
					if (schema === undefined) continue
					const statusCode = statusKeyToCode[statusKey as keyof typeof statusKeyToCode]
					if (statusCode) {
						responses[String(statusCode)] = {
							content: {
								[contentType]: {
									schema: asJsonSchema(schema as StandardSchemaLike | Record<string, unknown>),
								},
							},
							description: statusKey.replace(/_/g, " "),
						}
					}
				}
			}
		}

		/* error responses from declared error keys */
		if (handler.ek.size > 0) {
			type ErrorEntry = { key: string; schema: Record<string, unknown> | null }
			const byStatus = new Map<number, ErrorEntry[]>()
			for (const ek of handler.ek) {
				const info = resolveErrorInfo(ek, factory)
				if (info.status > 0) {
					let entries = byStatus.get(info.status)
					if (!entries) {
						entries = []
						byStatus.set(info.status, entries)
					}
					/* check if this error has a custom schema */
					const meta = errorMeta?.[ek]
					let customSchema: Record<string, unknown> | null = null
					if (meta?.schema) {
						const converted = schemaToJsonSchema(meta.schema as StandardSchemaLike)
						if (converted) {
							customSchema = customErrorAddsSchema
								? { allOf: [converted, customErrorAddsSchema] }
								: (converted as Record<string, unknown>)
						}
					}
					entries.push({ key: ek, schema: customSchema })
				}
			}
			for (const [status, entries] of byStatus) {
				if (responses[String(status)] === undefined) {
					const standardKeys = entries.filter((e) => !e.schema).map((e) => e.key)
					const customSchemas = entries
						.filter((e) => e.schema)
						.map((e) => e.schema as Record<string, unknown>)

					let schema: Record<string, unknown>

					if (customSchemas.length === 0) {
						/* all standard errors at this status — use base error schema with constrained enums */
						schema = structuredClone(baseErrorJsonSchema)
						const props = schema.properties as Record<string, unknown> | undefined
						if (props?.error_key) {
							props.error_key = { enum: standardKeys.sort(), type: "string" }
						}
						if (props?.status) {
							props.status = { enum: [status], type: "integer" }
						}
					} else if (standardKeys.length === 0 && customSchemas.length === 1) {
						/* single custom schema error — use it directly */
						schema = customSchemas[0]
					} else {
						/* mixed standard + custom, or multiple custom — use oneOf */
						const schemas: Record<string, unknown>[] = []
						if (standardKeys.length > 0) {
							const stdSchema = structuredClone(baseErrorJsonSchema)
							const props = stdSchema.properties as Record<string, unknown> | undefined
							if (props?.error_key) {
								props.error_key = { enum: standardKeys.sort(), type: "string" }
							}
							if (props?.status) {
								props.status = { enum: [status], type: "integer" }
							}
							schemas.push(stdSchema)
						}
						schemas.push(...customSchemas)
						schema = { oneOf: schemas }
					}

					responses[String(status)] = {
						content: {
							"application/json": { schema },
						},
						description: entries
							.map((e) => e.key)
							.sort()
							.join(", "),
					}
				}
			}
		}

		if (Object.keys(responses).length === 0) {
			responses["200"] = { description: "Success" }
		}
		operation.responses = responses

		paths[oaPath][methodKey] = operation
	}

	/* WS routes */
	const wsRoutes: CollectedWSRoute[] = []
	walkWSRoutes(tree, "", wsRoutes)

	for (const { handler, path } of wsRoutes) {
		const oaPath = toOpenApiPath(path)
		if (paths[oaPath] === undefined) {
			paths[oaPath] = {}
		}

		const operation: Record<string, unknown> = { "x-websocket": true }
		const parameters: Array<Record<string, unknown>> = []

		const meta = handler.mt as Record<string, unknown> | null
		if (meta?.summary) operation.summary = meta.summary
		if (meta?.description) operation.description = meta.description
		if (meta?.tags) operation.tags = typeof meta.tags === "string" ? [meta.tags] : meta.tags
		if (meta?.operationId) operation.operationId = meta.operationId

		/* path params */
		const wsParams = extractParams(path)
		for (const name of wsParams) {
			parameters.push({
				in: "path",
				name,
				required: true,
				schema: { type: "string" },
			})
		}

		/* query params from input schemas — use same conversion as HTTP routes */
		if (handler.iv?.search) {
			const searchEntry = handler.iv.search
			const searchSchema =
				"_tag" in searchEntry
					? (searchEntry as { schema: StandardSchemaLike }).schema
					: (searchEntry as StandardSchemaLike)
			const jsonSchema = asJsonSchema(
				searchSchema as StandardSchemaLike | Record<string, unknown>,
				"input",
			)
			if (jsonSchema && typeof jsonSchema === "object") {
				const props = (jsonSchema as Record<string, unknown>).properties as
					| Record<string, unknown>
					| undefined
				const required = new Set(
					((jsonSchema as Record<string, unknown>).required ?? []) as string[],
				)
				if (props) {
					for (const [name, schema] of Object.entries(props)) {
						parameters.push({
							in: "query",
							name,
							required: required.has(name),
							schema,
						})
					}
				}
			}
		}

		if (parameters.length > 0) operation.parameters = parameters
		operation.responses = { "101": { description: "WebSocket upgrade" } }

		paths[oaPath].get = operation
	}

	const result: OpenApiSpec = {
		info: options.info,
		openapi: "3.1.0",
		paths,
	}
	if (options.securitySchemes) {
		result.components = {
			...result.components,
			securitySchemes: options.securitySchemes,
		}
	}
	return deduplicateSchemas(result)
}

export function extractSchemas<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
): Record<string, Record<string, unknown>> {
	const tree = (app as unknown as { _tree: TreeNode })._tree
	const collected: CollectedRoute[] = []
	walkTree(tree, "", collected)

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

type RouteConfig = {
	boundaryErrorKey: string | null
	errorKeys: string[]
	/** JSON Schema per input source — { json?, form?, params?, search?, headers?, cookies? }; null = no input validation */
	inputSchemas: Record<string, Record<string, unknown>> | null
	meta: Record<string, unknown> | null
	method: string
	middlewareNames: string[]
	/**
	 * JSON Schema per (contentType, statusKey). Special case: `redirect` contentType holds
	 * `Record<statusKey, true>` with no schema (declaration-only, no body to validate).
	 * null = no output validation declared.
	 */
	outputSchemas: Record<string, Record<string, unknown>> | null
	path: string
}

function serializeInputSchemas(
	iv: InputSchemasDef | null,
): Record<string, Record<string, unknown>> | null {
	if (!iv) return null
	const result: Record<string, Record<string, unknown>> = {}
	for (const [source, entry] of Object.entries(iv)) {
		if (entry === undefined) continue
		const unwrapped = unwrapEntry(entry as InputSchemaEntry)
		result[source] = schemaToJsonSchema(unwrapped, "input") as Record<string, unknown>
	}
	return Object.keys(result).length > 0 ? result : null
}

function serializeOutputSchemas(
	os: OutputSchemaDef | null,
): Record<string, Record<string, unknown>> | null {
	if (!os) return null
	const result: Record<string, Record<string, unknown>> = {}
	for (const [contentType, schemas] of Object.entries(os)) {
		if (schemas === undefined) continue
		if (contentType === "redirect") {
			/* redirect map is Record<statusKey, true> — copy as-is, no schema conversion */
			result[contentType] = { ...(schemas as Record<string, true>) }
			continue
		}
		const converted: Record<string, unknown> = {}
		for (const [statusKey, schema] of Object.entries(schemas)) {
			if (schema === undefined) continue
			converted[statusKey] = schemaToJsonSchema(schema as StandardSchemaLike)
		}
		if (Object.keys(converted).length > 0) {
			result[contentType] = converted
		}
	}
	return Object.keys(result).length > 0 ? result : null
}

function buildRouteConfig(handler: RouteHandler, method: string, path: string): RouteConfig {
	return {
		boundaryErrorKey: handler.bek,
		errorKeys: Array.from(handler.ek),
		inputSchemas: serializeInputSchemas(handler.iv as InputSchemasDef | null),
		meta: handler.mt,
		method,
		middlewareNames: handler.mw.map((mw) => mw.name || "anonymous"),
		outputSchemas: serializeOutputSchemas(handler.os as OutputSchemaDef | null),
		path,
	}
}

function collectRoutesForTree(node: TreeNode, currentPath: string, routes: RouteConfig[]): void {
	if (node.m !== null) {
		for (const [method, handler] of Object.entries(node.m)) {
			routes.push(buildRouteConfig(handler, method, currentPath || "/"))
		}
	}

	for (const [seg, child] of Object.entries(node.s)) {
		collectRoutesForTree(child, `${currentPath}/${seg}`, routes)
	}

	if (node.d !== null) {
		collectRoutesForTree(node.d.c, `${currentPath}/:${node.d.n}`, routes)
	}

	if (node.w !== null) {
		for (const [method, handler] of Object.entries(node.w.m)) {
			routes.push(buildRouteConfig(handler, method, `${currentPath}/*${node.w.n}`))
		}
	}
}

type TreeBuild = {
	children: Record<string, TreeBuild>
	dynamic: { child: TreeBuild; name: string } | null
	handlers: Array<{ handler: string; method: string }>
	wildcard: {
		handlers: Array<{ handler: string; method: string }>
		name: string
	} | null
}

function createTreeBuild(): TreeBuild {
	return { children: {}, dynamic: null, handlers: [], wildcard: null }
}

function serializeNode(node: TreeBuild): string {
	const staticEntries = Object.entries(node.children)
	const sExpr =
		staticEntries.length > 0
			? `Object.assign(Object.create(null), { ${staticEntries.map(([k, v]) => `${JSON.stringify(k)}: ${serializeNode(v)}`).join(", ")} })`
			: "E"

	const dExpr = node.dynamic
		? `{ n: ${JSON.stringify(node.dynamic.name)}, c: ${serializeNode(node.dynamic.child)} }`
		: "null"

	const wExpr = node.wildcard
		? `{ n: ${JSON.stringify(node.wildcard.name)}, m: { ${node.wildcard.handlers.map((h) => `${h.method}: ${h.handler}`).join(", ")} } }`
		: "null"

	const mExpr =
		node.handlers.length > 0
			? `{ ${node.handlers.map((h) => `${h.method}: ${h.handler}`).join(", ")} }`
			: "null"

	return `{ s: ${sExpr}, d: ${dExpr}, w: ${wExpr}, m: ${mExpr}, ws: null }`
}

function toTsLiteral(v: unknown): string {
	if (v === null) return "null"
	if (v === true) return "true"
	if (v === false) return "false"
	if (Array.isArray(v)) return "unknown[]"
	if (typeof v === "string") return JSON.stringify(v)
	if (typeof v === "number") return String(v)
	if (typeof v === "object") return "Record<string, unknown>"
	return typeof v
}

export function generateRouteTree(routes: RouteConfig[]): string {
	const lines: string[] = []
	lines.push('import type { TreeNode, RouteHandler, RouteTree } from "honey/tree"')
	lines.push("")
	lines.push("const E = Object.create(null) as Record<string, TreeNode>")
	lines.push("")

	/* unique handler per route — no dedup, patching shared handlers would corrupt */
	const handlerEntries: Array<{ index: number; route: RouteConfig }> = []
	for (let i = 0; i < routes.length; i++) {
		handlerEntries.push({ index: i, route: routes[i] })
	}

	/* emit handler configs with pre-built ek and mt */
	for (const { index, route } of handlerEntries) {
		const mwList = "[]"
		const bekExpr =
			route.boundaryErrorKey !== null ? JSON.stringify(route.boundaryErrorKey) : "null"
		const ekSet =
			route.errorKeys.length > 0 ? `new Set(${JSON.stringify(route.errorKeys)})` : "new Set()"
		const mtExpr = route.meta !== null ? JSON.stringify(route.meta) : "null"
		const ivExpr =
			route.inputSchemas !== null
				? `${JSON.stringify(route.inputSchemas)} as unknown as RouteHandler["iv"]`
				: "null"
		const osExpr =
			route.outputSchemas !== null
				? `${JSON.stringify(route.outputSchemas)} as unknown as RouteHandler["os"]`
				: "null"
		lines.push(
			`const H${index}: RouteHandler = { bek: ${bekExpr}, ef: null, fn: null as unknown as RouteHandler["fn"], mw: ${mwList}, ek: ${ekSet}, iv: ${ivExpr}, os: ${osExpr}, mt: ${mtExpr}, ov: null, rp: "" }`,
		)
	}

	lines.push("")

	/* build tree structure */
	const rootBuild = createTreeBuild()

	for (const { index, route } of handlerEntries) {
		const hName = `H${index}`
		const segments = route.path.split("/").filter((s) => s.length > 0)
		let node = rootBuild

		for (let i = 0; i < segments.length; i++) {
			const seg = segments[i]
			if (seg.startsWith("*")) {
				const name = seg.length > 1 ? seg.slice(1) : "*"
				if (node.wildcard === null) {
					node.wildcard = { handlers: [], name }
				}
				node.wildcard.handlers.push({ handler: hName, method: route.method })
				break
			}
			if (seg.startsWith(":")) {
				const name = seg.endsWith("?") ? seg.slice(1, -1) : seg.slice(1)
				if (node.dynamic === null) {
					node.dynamic = { child: createTreeBuild(), name }
				}
				if (i === segments.length - 1) {
					node.dynamic.child.handlers.push({
						handler: hName,
						method: route.method,
					})
				} else {
					node = node.dynamic.child
				}
				continue
			}
			if (node.children[seg] === undefined) {
				node.children[seg] = createTreeBuild()
			}
			if (i === segments.length - 1) {
				node.children[seg].handlers.push({
					handler: hName,
					method: route.method,
				})
			} else {
				node = node.children[seg]
			}
		}

		if (segments.length === 0) {
			node.handlers.push({ handler: hName, method: route.method })
		}
	}

	lines.push(`export const tree: TreeNode = ${serializeNode(rootBuild)}`)
	lines.push("")

	/* emit handler lookup map for .routeTree() patching */
	const handlerMapEntries = handlerEntries.map(
		({ index, route }) => `\t${JSON.stringify(`${route.method} ${route.path}`)}: H${index}`,
	)
	lines.push(
		`export const handlers: Record<string, RouteHandler> = {\n${handlerMapEntries.join(",\n")}\n}`,
	)
	lines.push("")

	return lines.join("\n")
}

function generateFromTreeRoot(root: TreeNode): string {
	const routes: RouteConfig[] = []
	collectRoutesForTree(root, "", routes)

	const collected: CollectedRoute[] = []
	walkTree(root, "", collected)

	let code = generateRouteTree(routes)

	/* emit meta export — full meta for gateway/external consumers */
	const metaEntries: string[] = []
	for (const { handler, method, path } of collected) {
		if (handler.mt === null || Object.keys(handler.mt).length === 0) continue
		metaEntries.push(`\t${JSON.stringify(`${method} ${path}`)}: ${JSON.stringify(handler.mt)}`)
	}

	/* emit MetaShape type from handler metas — preserve literal types */
	const allKeys = new Map<string, Set<string>>()
	let metaHandlerCount = 0
	for (const { handler } of collected) {
		if (handler.mt === null) continue
		metaHandlerCount++
		for (const [k, v] of Object.entries(handler.mt)) {
			if (!allKeys.has(k)) allKeys.set(k, new Set())
			allKeys.get(k)?.add(toTsLiteral(v))
		}
	}

	/* count per-key occurrences to determine optionality */
	const keyCount = new Map<string, number>()
	for (const { handler } of collected) {
		if (handler.mt === null) continue
		for (const k of Object.keys(handler.mt)) {
			keyCount.set(k, (keyCount.get(k) ?? 0) + 1)
		}
	}

	if (allKeys.size > 0) {
		const props = [...allKeys.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, types]) => {
				const optional = (keyCount.get(key) ?? 0) < metaHandlerCount ? "?" : ""
				const safeKey = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `"${key}"`
				return `\t${safeKey}${optional}: ${[...types].join(" | ")}`
			})
		code += `\nexport type MetaShape = {\n${props.join("\n")}\n}\n\n`
	}

	/* emit RouteSelector union from route graph */
	const selectors = new Set<string>()
	for (const { handler, method, path } of collected) {
		if (handler._skip) continue
		selectors.add(`${method} ${path}`)
	}
	if (selectors.size > 0) {
		const sorted = [...selectors].sort()
		code += `\nexport type RouteSelector = ${sorted.map((s) => JSON.stringify(s)).join(" | ")}\n`
	}

	if (metaEntries.length > 0) {
		const metaType =
			allKeys.size > 0 ? "Record<string, MetaShape>" : "Record<string, Record<string, unknown>>"
		code += `export const meta: ${metaType} = {\n${metaEntries.join(",\n")}\n}\n`
	}

	/* emit routeTree convenience export for .routeTree() */
	const hasMetaExport = metaEntries.length > 0
	code += `export const routeTree: RouteTree = { root: tree, ${hasMetaExport ? "meta, " : "meta: {}, "}handlers }\n`

	return code
}

export function generateRouteTreeFromApp<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
): string {
	const root = (app as unknown as { _tree: TreeNode })._tree
	return generateFromTreeRoot(root)
}

/**
 * Generate static route tree code from a pre-built RouteTree.
 * Supports gateway patterns: import service trees → enrich meta → mergeTree → generate.
 */
export function generateRouteTreeFromRouteTree(rt: { root: TreeNode }): string {
	return generateFromTreeRoot(rt.root)
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

function emitInputType(handler: RouteHandler): string {
	if (!handler.iv) return "{}"
	const entries: string[] = []
	for (const [source, schema] of Object.entries(handler.iv)) {
		if (schema === undefined) continue
		const unwrapped = unwrapEntry(schema as InputSchemaEntry)
		entries.push(`${source}: ${emitSchemaType(unwrapped)}`)
	}
	if (entries.length === 0) return "{}"
	return `{ ${entries.join("; ")} }`
}

function emitOutputType(handler: RouteHandler): string {
	if (!handler.os) return "{}"
	const ctEntries: string[] = []
	for (const [contentType, schemas] of Object.entries(handler.os)) {
		if (schemas === undefined) continue
		if (contentType === "redirect") {
			const keys = Object.keys(schemas).filter((k) => schemas[k as keyof typeof schemas])
			if (keys.length > 0) {
				ctEntries.push(`"redirect": { ${keys.map((k) => `${k}: true`).join("; ")} }`)
			}
			continue
		}
		const statusEntries: string[] = []
		for (const [statusKey, schema] of Object.entries(schemas)) {
			if (schema === undefined) continue
			statusEntries.push(`${statusKey}: ${emitSchemaType(schema as StandardSchemaLike)}`)
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
		const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : JSON.stringify(k)
		entries.push(`${key}: ${emitLiteral(v)}`)
	}
	if (entries.length === 0) return "{}"
	return `{ ${entries.join("; ")} }`
}

function emitLiteral(value: unknown): string {
	if (value === null) return "null"
	if (value === undefined) return "undefined"
	if (typeof value === "string") return JSON.stringify(value)
	if (typeof value === "number" || typeof value === "boolean") return String(value)
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
): string | null {
	if (handler.ek.size === 0) return null
	const entries: string[] = []
	for (const key of Array.from(handler.ek).sort()) {
		const entry = meta?.[key]
		if (entry?.schema) {
			const schemaType = emitSchemaType(entry.schema as StandardSchemaLike)
			entries.push(`${key}: ${schemaType}`)
		} else {
			entries.push(`${key}: null`)
		}
	}
	return `{ ${entries.join("; ")} }`
}

function emitErrorsByStatus(
	handler: RouteHandler,
	meta: Record<string, ErrorMetaEntry> | null,
	factory: Record<string, () => HoneyError> | null,
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
				shapes.push(emitSchemaType(entry.schema as StandardSchemaLike))
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
				`${k}: (opts?: { cause?: unknown; fields?: Record<string, { error_key: string; message: string; path: string }[]>; headers?: Record<string, string>; vars?: Record<string, string | number> }) => HoneyError`,
		)
	return `readonly errors: { ${entries.join("; ")} }`
}

/**
 * Look up per-route middleware type additions.
 * The type extractor stores keys as `"method /route-path"` (no basePath prefix),
 * but the codegen resolves routes to full paths (with basePath).
 * Try exact match first, then strip leading segments until a match is found.
 */
function resolveRouteMiddleware(
	routeMiddleware: Record<string, string> | undefined,
	method: string,
	fullPath: string,
): string | undefined {
	if (!routeMiddleware) return undefined
	const exact = routeMiddleware[`${method} ${fullPath}`]
	if (exact) return exact

	/* strip leading path segments (basePath) until match */
	let p = fullPath
	while (p.includes("/", 1)) {
		const nextSlash = p.indexOf("/", 1)
		p = p.slice(nextSlash)
		const key = `${method} ${p}`
		if (routeMiddleware[key]) return routeMiddleware[key]
	}
	return undefined
}

export function generateTypes<TEnv, TCtx>(
	app: Honey<TEnv, TCtx, unknown, unknown, unknown, string, string>,
	options: GenerateTypesOptions,
): string {
	const tree = (app as unknown as { _tree: TreeNode })._tree
	const collected: CollectedRoute[] = []
	walkTree(tree, "", collected, true)

	const factory = getErrorFactory(app)
	const errorMeta = getErrorMeta(factory)
	const baseCtxName = options.baseCtxName ?? "BaseCtx"
	const hasErrors = collected.some(({ handler }) => handler.ek.size > 0)
	const lines: string[] = []

	const importParts = ["HoneyContext"]
	if (hasErrors) importParts.push("HoneyError")
	lines.push(`import type { ${importParts.join(", ")} } from "honey"`)
	lines.push("")

	const envType = options.inlineEnvType ?? "Record<string, unknown>"
	const mwPart = options.inlineMiddlewareType ? ` & ${options.inlineMiddlewareType}` : ""
	if (options.inlineTapsType) {
		lines.push(`type TapMap = ${options.inlineTapsType}`)
		lines.push("")
	}
	const ctxBase = options.inlineTapsType
		? `Omit<HoneyContext<${envType}>, "tap">`
		: `HoneyContext<${envType}>`
	const tapPart = options.inlineTapsType
		? " & { tap<K extends keyof TapMap>(key: K, payload: TapMap[K]): void }"
		: ""
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
		if (handler._skip) continue
		selectors.add(`${method} ${path}`)
	}
	if (selectors.size > 0) {
		const sorted = [...selectors].sort()
		lines.push(`export type RouteSelector = ${sorted.map((s) => JSON.stringify(s)).join(" | ")}`)
		lines.push("")
		lines.push('declare module "honey" {')
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
		const props = routeProps?.[key]
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

	lines.push("export type Routes = {")

	for (const [path, methods] of byPath) {
		lines.push(`\t"${path}": {`)
		for (const { handler, method } of methods) {
			const mwType = buildMwType(method, path)
			const mwAlias = mwType ? mwTypeMap.get(mwType) : undefined
			const basePart = mwAlias ? `${baseCtxName} & ${mwAlias}` : baseCtxName
			const additions: string[] = []
			const inputType = emitInputType(handler)
			if (inputType !== "{}") additions.push(`input: ${inputType}`)
			const params = extractParams(path)
			if (params.length > 0) {
				const paramEntries = params.map((p) => `${p}: string`).join("; ")
				additions.push(`readonly params: { ${paramEntries} }`)
			}
			const errorsCtx = emitErrorsCtxType(handler)
			if (errorsCtx) additions.push(errorsCtx)
			const ctxType =
				additions.length === 0 ? basePart : `${basePart} & { ${additions.join("; ")} }`
			const errorType = emitErrorType(handler)
			const metaType = emitMetaType(handler)
			const outputType = emitOutputType(handler)
			lines.push(`\t\t${method}: {`)
			lines.push(`\t\t\tctx: ${ctxType}`)
			lines.push(`\t\t\terrors: ${errorType}`)
			const shapesType = emitErrorShapes(handler, errorMeta)
			if (shapesType) {
				lines.push(`\t\t\terrorShapes: ${shapesType}`)
				const byStatusType = emitErrorsByStatus(handler, errorMeta, factory)
				if (byStatusType) {
					lines.push(`\t\t\terrorsByStatus: ${byStatusType}`)
				}
			}
			lines.push(`\t\t\tinput: ${inputType}`)
			lines.push(`\t\t\tmeta: ${metaType}`)
			lines.push(`\t\t\toutput: ${outputType}`)
			lines.push("\t\t}")
		}
		lines.push("\t}")
	}
	lines.push("}")
	lines.push("")

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
	const re = /\{(\w+)\}/g
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
export function jsonSchemaToTS(schema: Record<string, unknown> | undefined, depth = 0): string {
	if (!schema || depth > 8) return "unknown"
	return irToTs(schemaToIR(schema), depth)
}

/* extract input type for an operation */
function emitSDKInputType(
	op: Record<string, unknown>,
	path: string,
): { hasMandatory: boolean; type: string } {
	const mandatoryParts: string[] = []
	const optionalParts: string[] = []

	/* path params — always required */
	const pathParamNames = extractOpenApiPathParams(path)
	if (pathParamNames.length > 0) {
		const allParameters = op.parameters as Array<Record<string, unknown>> | undefined
		const entries = pathParamNames
			.map((name) => {
				const paramDef = allParameters?.find((p) => p.name === name && p.in === "path")
				const schema = paramDef?.schema as Record<string, unknown> | undefined
				const tsType = schema ? jsonSchemaToTS(schema) : "string"
				const safeParamName = sdkSafeName(name)
				return `${safeParamName}: ${tsType}`
			})
			.join("; ")
		mandatoryParts.push(`params: { ${entries} }`)
	}

	/* query params */
	const parameters = op.parameters as Array<Record<string, unknown>> | undefined
	if (parameters) {
		const queryParams = parameters.filter((p) => p.in === "query")
		if (queryParams.length > 0) {
			const hasRequired = queryParams.some((p) => p.required === true)
			const entries = queryParams
				.sort((a, b) => String(a.name).localeCompare(String(b.name)))
				.map((p) => {
					const name = String(p.name)
					const required = p.required === true
					const schema = p.schema as Record<string, unknown> | undefined
					const tsType = jsonSchemaToTS(schema)
					const safeQueryName = sdkSafeName(name)
				return `${safeQueryName}${required ? "" : "?"}: ${tsType}`
				})
			const searchEntry = `search: { ${entries.join("; ")} }`
			if (hasRequired) {
				mandatoryParts.push(searchEntry)
			} else {
				optionalParts.push(searchEntry)
			}
		}
	}

	/* request body */
	const requestBody = op.requestBody as Record<string, unknown> | undefined
	if (requestBody) {
		const required = (requestBody.required as boolean | undefined) === true
		const content = requestBody.content as Record<string, Record<string, unknown>> | undefined
		if (content) {
			/* application/octet-stream: raw byte stream — emit `body:` field,
			 * mutually exclusive with json/form for this operation */
			if ("application/octet-stream" in content) {
				const entry = "body: ReadableStream<Uint8Array> | Blob | ArrayBuffer | Uint8Array"
				if (required) {
					mandatoryParts.push(entry)
				} else {
					optionalParts.push(entry)
				}
			}
			const jsonContent = content["application/json"]
			if (jsonContent?.schema) {
				const entry = `json: ${jsonSchemaToTS(jsonContent.schema as Record<string, unknown>)}`
				if (required) {
					mandatoryParts.push(entry)
				} else {
					optionalParts.push(entry)
				}
			}
			const formContent =
				content["multipart/form-data"] ?? content["application/x-www-form-urlencoded"]
			if (formContent?.schema) {
				const entry = `form: ${jsonSchemaToTS(formContent.schema as Record<string, unknown>)}`
				if (required) {
					mandatoryParts.push(entry)
				} else {
					optionalParts.push(entry)
				}
			}
		}
	}

	const allParts = [...mandatoryParts, ...optionalParts]
	const type = allParts.length === 0 ? "{}" : `{ ${allParts.join("; ")} }`
	return { hasMandatory: mandatoryParts.length > 0, type }
}

/* extract response type for an operation */
function emitSDKResponseType(op: Record<string, unknown>): string {
	const responses = op.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return "void"

	/* check for SSE — shape mirrors runtime _SSEEvent (event/id/retry all optional) */
	for (const response of Object.values(responses)) {
		const content = response.content as Record<string, unknown> | undefined
		if (content && "text/event-stream" in content)
			return "AsyncIterable<{ data: string; event?: string; id?: string; retry?: number }>"
	}

	/* collect success response types (2xx) */
	const successTypes: string[] = []
	for (const [status, response] of Object.entries(responses)) {
		const code = Number.parseInt(status, 10)
		if (code < 200 || code >= 300) continue
		if (code === 204) {
			successTypes.push("null")
			continue
		}
		const content = response.content as Record<string, Record<string, unknown>> | undefined
		if (!content) {
			successTypes.push("null")
			continue
		}
		if (content["application/json"]?.schema) {
			successTypes.push(
				jsonSchemaToTS(content["application/json"].schema as Record<string, unknown>),
			)
		} else if ("application/octet-stream" in content) {
			successTypes.push("ArrayBuffer")
		} else {
			const keys = Object.keys(content)
			const isText = keys.some((k) => k.startsWith("text/") || k === "application/xml")
			if (isText) {
				successTypes.push("string")
			} else if (keys.length > 0) {
				successTypes.push("ArrayBuffer")
			}
		}
	}

	if (successTypes.length === 0) return "void"
	if (successTypes.length === 1) return successTypes[0]
	return successTypes.join(" | ")
}

/* detect whether a JSON schema matches the standard error envelope shape */
export function isStandardErrEnvelope(
	schema: Record<string, unknown>,
): { keys: string[]; status: number } | null {
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
function emitSDKErrorsByStatusType(op: Record<string, unknown>): string | null {
	const responses = op.responses as Record<string, Record<string, unknown>> | undefined
	if (!responses) return null

	const entries: string[] = []
	for (const [status, response] of Object.entries(responses)) {
		const code = Number.parseInt(status, 10)
		if (code < 400) continue /* only error responses */

		const content = response.content as Record<string, Record<string, unknown>> | undefined
		const schema = content?.["application/json"]?.schema as Record<string, unknown> | undefined
		if (!schema) continue

		const envelope = isStandardErrEnvelope(schema)
		if (envelope) {
			const keyUnion = envelope.keys.map((k) => JSON.stringify(k)).join(" | ")
			entries.push(`${code}: _ErrEnvelope<${envelope.status}, ${keyUnion}>`)
		} else {
			entries.push(`${code}: ${jsonSchemaToTS(schema)}`)
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
	else
		returnType = `TThrow extends true ? Promise<${resolvedRes}> : Promise<SDKResult<${resolvedRes}>>`
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
	for (const [typeStr, count] of [...counts.entries()].sort(([a], [b]) => a.localeCompare(b))) {
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
	"break", "case", "catch", "class", "const", "continue", "debugger",
	"default", "delete", "do", "else", "enum", "export", "extends", "false",
	"finally", "for", "function", "if", "import", "in", "instanceof", "new",
	"null", "return", "super", "switch", "this", "throw", "true", "try",
	"typeof", "var", "void", "while", "with", "yield", "let", "static",
	"implements", "interface", "package", "private", "protected", "public",
	"abstract", "as", "async", "await", "constructor", "declare", "from",
	"get", "infer", "is", "keyof", "module", "namespace", "never", "of",
	"readonly", "require", "set", "satisfies", "symbol", "type", "unique",
	"unknown", "override",
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
		sdkMethods
			.filter((m) => !m.ws && !m.sse && isHoistableResponseType(m.responseType))
			.map((m) => m.responseType),
		"_Res",
		2,
	)
	const { aliases: inpAliases, lines: inpLines } = buildTypeAliases(
		sdkMethods
			.filter((m) => m.inputType !== "{}" && isHoistableResponseType(m.inputType))
			.map((m) => m.inputType),
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
	l.push(
		'\toff(event: "close" | "error" | "message" | "open", handler: (...args: never[]) => void): void',
	)
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
	l.push(
		"\tinvalidation?: { maxSourcesPerTarget?: number; staleMaxEntries?: number; staleTime: number }",
	)
	l.push("\tmaxErrorMessageChars?: number")
	l.push("\tmode?: RequestMode")
	l.push(
		`\tonRequest?: Array<(ctx: { body?: BodyInit; headers: Headers; invalidatedBy?: string[]; isStale?: boolean; method: string; path: string; selector?: string; state: Record<string, unknown>; url: string }) => void | Promise<void>>`,
	)
	l.push(
		`\tonResponse?: Array<(ctx: { invalidatedBy?: string[]; isRetry: boolean; isStale?: boolean; method: string; path: string; request: Request; response: Response; retry: () => Promise<Response>; selector?: string; state: Record<string, unknown>; url: string }) => Response | undefined | Promise<Response | undefined>>`,
	)
	l.push("\tonAuthExpired?: () => Promise<string | null>")
	l.push("\tauthHeaderName?: string")
	l.push("\tauthHeaderPrefix?: string")
	l.push("\tonLog?: (entry: _LogEntry) => void")
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
		const parts = [
			`method: ${JSON.stringify(entry.method)}`,
			`path: ${JSON.stringify(entry.path)}`,
		]
		if (entry.params) parts.push(`params: ${JSON.stringify(entry.params)}`)
		if (entry.sse) parts.push("sse: true")
		if (entry.ws) parts.push("ws: true")
		if (entry.idempotent) parts.push("idempotent: true")
		if (entry.invalidate) parts.push(`invalidate: ${JSON.stringify(entry.invalidate)}`)
		return [`{ ${parts.join(", ")} }`]
	}
	const lines: string[] = ["{"]
	for (const [key, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
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
	for (const [key, node] of [...nestedMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
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
		sdkClientBuildURL(),
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
\tonAuthExpired?: () => Promise<string | null>
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
`
}

function sdkClientClientError(): string {
	const subclassDecls = STATUS_ERROR_CLASSES
		.map(({ name }) =>
			`class _${name} extends _ClientError { constructor(init: ConstructorParameters<typeof _ClientError>[0]) { super(init); this.name = "${name}" } }`,
		)
		.join("\n")
	const mapEntries = STATUS_ERROR_CLASSES
		.map(({ name, status }) => `\t${status}: _${name},`)
		.join("\n")
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
\t#staleUntil: Map<string, { by: string[]; seq: number; until: number }> | null
\t#patternRegexCache = new Map<string, RegExp>()
\t#invalidationSeq = 0
\t#staleMaxEntries: number
\t#maxSourcesPerTarget: number
\t#maxErrorMessageChars: number
\t#sseMaxBufferChars: number
\t#disposeCtrl = new AbortController()
\t#disposed = false
`
}

function sdkClientConstructor(n: string): string {
	return `
\tconstructor(config: ${n}Config<TThrow>) {
\t\tconst ownState = config.state ?? {}
\t\tthis.state = ownState
\t\tthis.#config = { ...config, state: ownState }
\t\tthis.#fetchFn = config.fetch ?? globalThis.fetch
\t\tthis.#searchSerializer = config.buildSearchParams ?? ((q: Record<string, unknown>) => this.#serializeSearch(q))
\t\tthis.#staleTime = config.invalidation?.staleTime ?? 0
\t\tthis.#staleUntil = this.#staleTime > 0
\t\t\t? new Map<string, { by: string[]; seq: number; until: number }>()
\t\t\t: null
\t\tthis.#staleMaxEntries = config.invalidation?.staleMaxEntries ?? 1000
\t\tthis.#maxSourcesPerTarget = Math.max(config.invalidation?.maxSourcesPerTarget ?? 16, 1)
\t\tthis.#maxErrorMessageChars = config.maxErrorMessageChars ?? 512
\t\tthis.#sseMaxBufferChars = config.sseMaxBufferChars ?? 1024 * 1024
`
}

function sdkClientProxy(n: string): string {
	return `
\t\tconst self = this
\t\tfunction makeNodeProxy(node: _ServiceMapNode, path: string[]): object {
\t\t\tconst actionCache = new Map<string, (input?: Record<string, unknown>) => unknown>()
\t\t\tconst childCache = new Map<string, object>()
\t\t\treturn new Proxy({} as Record<string, unknown>, {
\t\t\t\tget: (_, key: string | symbol) => {
\t\t\t\t\tif (typeof key === "symbol") return undefined
\t\t\t\t\tconst child = (node as Record<string, unknown>)[key]
\t\t\t\t\tif (child === undefined) return undefined

\t\t\t\t\t/* leaf: entry has a "method" string field */
\t\t\t\t\tif (typeof (child as Record<string, unknown>)["method"] === "string") {
\t\t\t\t\t\tconst cached = actionCache.get(key)
\t\t\t\t\t\tif (cached) return cached
\t\t\t\t\t\tconst entry = child as _ServiceEntry
\t\t\t\t\t\tconst entryPath = self.#toColonParams(entry.path)
\t\t\t\t\t\tlet fn: (input?: Record<string, unknown>) => unknown
\t\t\t\t\t\tif (entry.ws) {
\t\t\t\t\t\t\tfn = (input?: Record<string, unknown>) =>
\t\t\t\t\t\t\t\tself.#connectWS(entry, entryPath, (input ?? {}) as _RequestOptions)
\t\t\t\t\t\t} else if (entry.sse) {
\t\t\t\t\t\t\tfn = (input?: Record<string, unknown>) =>
\t\t\t\t\t\t\t\tself.#requestSSE(entry, entryPath, (input ?? {}) as _RequestOptions)
\t\t\t\t\t\t} else {
\t\t\t\t\t\t\tfn = (input?: Record<string, unknown>) =>
\t\t\t\t\t\t\t\tself.#request(entry, input ?? {})
\t\t\t\t\t\t}
\t\t\t\t\t\tObject.defineProperty(fn, "name", { value: [...path, key].join(".") })
\t\t\t\t\t\tactionCache.set(key, fn)
\t\t\t\t\t\treturn fn
\t\t\t\t\t}

\t\t\t\t\t/* namespace: recurse */
\t\t\t\t\tconst cachedChild = childCache.get(key)
\t\t\t\t\tif (cachedChild) return cachedChild
\t\t\t\t\tconst childProxy = makeNodeProxy(child as _ServiceMapNode, [...path, key])
\t\t\t\t\tchildCache.set(key, childProxy)
\t\t\t\t\treturn childProxy
\t\t\t\t},
\t\t\t})
\t\t}

\t\treturn new Proxy(this, {
\t\t\tget: (target, key: string | symbol) => {
\t\t\t\tif (typeof key === "symbol") return Reflect.get(target, key)

\t\t\t\tconst cached = target.#resourceCache.get(key)
\t\t\t\tif (cached) return cached

\t\t\t\tconst node = (serviceMap as _ServiceMap)[key]
\t\t\t\tif (node === undefined) return Reflect.get(target, key)

\t\t\t\t/* root-level leaf (single-segment operationId) */
\t\t\t\tif (typeof (node as Record<string, unknown>)["method"] === "string") {
\t\t\t\t\tconst entry = node as _ServiceEntry
\t\t\t\t\tconst entryPath = target.#toColonParams(entry.path)
\t\t\t\t\tlet fn: (input?: Record<string, unknown>) => unknown
\t\t\t\t\tif (entry.ws) {
\t\t\t\t\t\tfn = (input?: Record<string, unknown>) =>
\t\t\t\t\t\t\ttarget.#connectWS(entry, entryPath, (input ?? {}) as _RequestOptions)
\t\t\t\t\t} else if (entry.sse) {
\t\t\t\t\t\tfn = (input?: Record<string, unknown>) =>
\t\t\t\t\t\t\ttarget.#requestSSE(entry, entryPath, (input ?? {}) as _RequestOptions)
\t\t\t\t\t} else {
\t\t\t\t\t\tfn = (input?: Record<string, unknown>) =>
\t\t\t\t\t\t\ttarget.#request(entry, input ?? {})
\t\t\t\t\t}
\t\t\t\t\tObject.defineProperty(fn, "name", { value: key })
\t\t\t\t\ttarget.#resourceCache.set(key, fn as unknown as Record<string, unknown>)
\t\t\t\t\treturn fn
\t\t\t\t}

\t\t\t\t/* namespace node — check for single _call promotion */
\t\t\t\tconst nodeRecord = node as Record<string, unknown>
\t\t\t\tconst nodeKeys = Object.keys(nodeRecord)
\t\t\t\tif (nodeKeys.length === 1 && nodeKeys[0] === "_call") {
\t\t\t\t\tconst entry = nodeRecord["_call"] as _ServiceEntry
\t\t\t\t\tconst entryPath = target.#toColonParams(entry.path)
\t\t\t\t\tlet fn: (input?: Record<string, unknown>) => unknown
\t\t\t\t\tif (entry.ws) {
\t\t\t\t\t\tfn = (input?: Record<string, unknown>) =>
\t\t\t\t\t\t\ttarget.#connectWS(entry, entryPath, (input ?? {}) as _RequestOptions)
\t\t\t\t\t} else if (entry.sse) {
\t\t\t\t\t\tfn = (input?: Record<string, unknown>) =>
\t\t\t\t\t\t\ttarget.#requestSSE(entry, entryPath, (input ?? {}) as _RequestOptions)
\t\t\t\t\t} else {
\t\t\t\t\t\tfn = (input?: Record<string, unknown>) =>
\t\t\t\t\t\t\ttarget.#request(entry, input ?? {})
\t\t\t\t\t}
\t\t\t\t\tObject.defineProperty(fn, "name", { value: key })
\t\t\t\t\ttarget.#resourceCache.set(key, fn as unknown as Record<string, unknown>)
\t\t\t\t\treturn fn
\t\t\t\t}

\t\t\t\tconst proxy = makeNodeProxy(node as _ServiceMapNode, [key])
\t\t\t\ttarget.#resourceCache.set(key, proxy as Record<string, unknown>)
\t\t\t\treturn proxy
\t\t\t},
\t\t}) as ${n}<TThrow>
\t}
`
}

function sdkClientInterpolatePath(): string {
	return `
\t#interpolatePath(path: string, params: Record<string, string>): string {
\t\treturn path.replace(/:(\\w+)/g, (_, key: string) => {
\t\t\tconst val = params[key]
\t\t\tif (val === undefined) throw new Error(\`Missing path param: \${key}\`)
\t\t\treturn encodeURIComponent(val)
\t\t})
\t}
`
}

function sdkClientToColonParams(): string {
	return `
\t#toColonParams(path: string): string {
\t\treturn path.replace(/\\{(\\w+)\\}/g, ":$1")
\t}
`
}

function sdkClientResolveInvalidationTargets(): string {
	return `
\t#resolveInvalidationTargets(
\t\ttargets: readonly string[],
\t\tparams: Record<string, string> | undefined,
\t): string[] {
\t\tconst resolved: string[] = []
\t\tfor (const target of targets) {
\t\t\tif (!params || !target.includes(":")) { resolved.push(target); continue }
\t\t\tconst spaceIdx = target.indexOf(" ")
\t\t\tconst targetMethod = target.slice(0, spaceIdx)
\t\t\tconst targetPath = target.slice(spaceIdx + 1)
\t\t\tlet hasUnresolved = false
\t\t\tconst replaced = targetPath.replace(/:(\\w+)/g, (match, key: string) => {
\t\t\t\tconst val = params[key]
\t\t\t\tif (val === undefined) { hasUnresolved = true; return match }
\t\t\t\treturn encodeURIComponent(val)
\t\t\t})
\t\t\tif (hasUnresolved) continue
\t\t\tresolved.push(\`\${targetMethod} \${replaced}\`)
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
\t\t\tconst escaped = pattern
\t\t\t\t.replace(/:[^\\/]+/g, "\\x00")
\t\t\t\t.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&")
\t\t\t\t.replace(/\\x00/g, "[^/]+")
\t\t\tre = new RegExp(\`^\${escaped}$\`)
\t\t\tthis.#patternRegexCache.set(pattern, re)
\t\t}
\t\treturn re.test(concretePath)
\t}
`
}

function sdkClientLookupStale(): string {
	return `
\t#lookupStale(
\t\tconcreteSelector: string,
\t\tconcretePath: string,
\t\tmethod: string,
\t\tnow: number,
\t): { by: string[]; isStale: boolean } {
\t\tconst allBy: string[] = []

\t\tconst exact = this.#staleUntil?.get(concreteSelector)
\t\tif (exact && exact.until > now) allBy.push(...exact.by)
\t\telse if (exact) this.#staleUntil?.delete(concreteSelector)

\t\tconst expired: string[] = []
\t\tif (this.#staleUntil) {
\t\t\tfor (const [key, entry] of this.#staleUntil) {
\t\t\t\tif (entry.until <= now) { expired.push(key); continue }
\t\t\t\tif (!key.includes(":")) continue
\t\t\t\tconst spaceIdx = key.indexOf(" ")
\t\t\t\tconst keyMethod = key.slice(0, spaceIdx)
\t\t\t\tconst keyPattern = key.slice(spaceIdx + 1)
\t\t\t\tif (keyMethod !== method) continue
\t\t\t\tif (this.#pathMatchesPattern(concretePath, keyPattern)) {
\t\t\t\t\tallBy.push(...entry.by)
\t\t\t\t}
\t\t\t}
\t\t\tfor (const key of expired) this.#staleUntil.delete(key)
\t\t}

\t\treturn { by: [...new Set(allBy)], isStale: allBy.length > 0 }
\t}
`
}

function sdkClientCreateTypedWebSocket(): string {
	return `
\t#createTypedWebSocket(url: string, protocols?: string | string[]): _TypedWebSocket {
\t\tconst ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
\t\tconst listenerMap = new WeakMap<(...args: never[]) => void, EventListener>()
\t\tconst sendBuffer: Array<ArrayBuffer | ArrayBufferView | string> = []
\t\tlet buffering = true

\t\tws.addEventListener("open", () => {
\t\t\tbuffering = false
\t\t\tfor (const msg of sendBuffer) ws.send(msg as Parameters<WebSocket["send"]>[0])
\t\t\tsendBuffer.length = 0
\t\t})

\t\tfunction close(code?: number, reason?: string) {
\t\t\tbuffering = false
\t\t\tsendBuffer.length = 0
\t\t\tws.close(code, reason)
\t\t}

\t\tfunction on(event: string, handler: (...args: never[]) => void): void {
\t\t\tlet wrapped: EventListener
\t\t\tswitch (event) {
\t\t\t\tcase "message":
\t\t\t\t\twrapped = (e: Event) => (handler as (data: string) => void)((e as MessageEvent).data)
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
\t\t\tlistenerMap.set(handler, wrapped)
\t\t\tws.addEventListener(event, wrapped)
\t\t}

\t\tfunction off(event: string, handler: (...args: never[]) => void): void {
\t\t\tconst wrapped = listenerMap.get(handler)
\t\t\tif (wrapped) {
\t\t\t\tws.removeEventListener(event, wrapped)
\t\t\t\tlistenerMap.delete(handler)
\t\t\t}
\t\t}

\t\tfunction send(data: ArrayBuffer | ArrayBufferView | object | string) {
\t\t\tlet payload: ArrayBuffer | ArrayBufferView | string
\t\t\tif (typeof data === "string") {
\t\t\t\tpayload = data
\t\t\t} else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
\t\t\t\tpayload = data
\t\t\t} else {
\t\t\t\tpayload = JSON.stringify(data)
\t\t\t}
\t\t\tif (buffering) { sendBuffer.push(payload) } else { ws.send(payload as Parameters<WebSocket["send"]>[0]) }
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

function sdkClientBuildURL(): string {
	return `
\t#buildURL(path: string, opts: _RequestOptions): string {
\t\tlet resolvedPath = path
\t\tif (opts.params) resolvedPath = this.#interpolatePath(path, opts.params)
\t\tconst baseUrl = new URL(this.#config.baseURL)
\t\tconst basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : \`\${baseUrl.pathname}/\`
\t\tconst relative = resolvedPath.startsWith("/") ? resolvedPath.slice(1) : resolvedPath
\t\tconst url = new URL(\`\${basePath}\${relative}\`, baseUrl)
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

\t\tif (opts.headers) {
\t\t\tfor (const [k, v] of Object.entries(opts.headers)) {
\t\t\t\theaders.set(k, v)
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

\t\treturn headers
\t}
`
}

function sdkClientDoRequest(): string {
	return `
\tasync #doRequest(
\t\tmethod: string,
\t\tpath: string,
\t\topts: _RequestOptions,
\t\tisRetry: boolean,
\t\trequestMeta?: _RequestMeta,
\t): Promise<{ response: Response }> {
\t\tconst url = this.#buildURL(path, opts)
\t\tconst headers = await this.#buildHeaders(opts, { method, path })
\t\tlet body: BodyInit | undefined

\t\tif (opts.body !== undefined) {
\t\t\theaders.set("content-type", "application/octet-stream")
\t\t\tbody = opts.body as BodyInit
\t\t} else if (opts.json !== undefined) {
\t\t\theaders.set("content-type", "application/json")
\t\t\ttry {
\t\t\t\tbody = JSON.stringify(opts.json)
\t\t\t} catch (e) {
\t\t\t\tthrow new _ClientError({
\t\t\t\t\tbody: opts.json,
\t\t\t\t\tdata: null,
\t\t\t\t\tmessage: \`JSON serialization failed: \${e instanceof Error ? e.message : String(e)}\`,
\t\t\t\t\tresponse: new Response(null, { status: 0 }),
\t\t\t\t\tstatus: 0,
\t\t\t\t})
\t\t\t}
\t\t} else if (opts.form !== undefined) {
\t\t\tconst hasFiles = Object.values(opts.form).some(
\t\t\t\t(v) =>
\t\t\t\t\t(typeof File !== "undefined" && v instanceof File) ||
\t\t\t\t\t(typeof Blob !== "undefined" && v instanceof Blob) ||
\t\t\t\t\t(typeof FileList !== "undefined" && v instanceof FileList) ||
\t\t\t\t\t(Array.isArray(v) &&
\t\t\t\t\t\tv.some(
\t\t\t\t\t\t\t(item) =>
\t\t\t\t\t\t\t\t(typeof File !== "undefined" && item instanceof File) ||
\t\t\t\t\t\t\t\t(typeof Blob !== "undefined" && item instanceof Blob),
\t\t\t\t\t\t)),
\t\t\t)

\t\t\tif (hasFiles) {
\t\t\t\tconst fd = new FormData()
\t\t\t\tfor (const [k, v] of Object.entries(opts.form)) {
\t\t\t\t\tif (v === undefined || v === null) continue
\t\t\t\t\tif (typeof FileList !== "undefined" && v instanceof FileList) {
\t\t\t\t\t\tfor (let i = 0; i < v.length; i++) { const f = v[i]; if (f) fd.append(k, f) }
\t\t\t\t\t} else if (Array.isArray(v)) {
\t\t\t\t\t\tfor (const item of v) {
\t\t\t\t\t\t\tif (item instanceof File || item instanceof Blob) fd.append(k, item)
\t\t\t\t\t\t\telse fd.append(k, String(item))
\t\t\t\t\t\t}
\t\t\t\t\t} else if (v instanceof File || v instanceof Blob) {
\t\t\t\t\t\tfd.append(k, v)
\t\t\t\t\t} else {
\t\t\t\t\t\tfd.append(k, String(v))
\t\t\t\t\t}
\t\t\t\t}
\t\t\t\tbody = fd
\t\t\t} else {
\t\t\t\theaders.set("content-type", "application/x-www-form-urlencoded")
\t\t\t\tconst sp = new URLSearchParams()
\t\t\t\tfor (const [k, v] of Object.entries(opts.form)) {
\t\t\t\t\tif (v === undefined || v === null) continue
\t\t\t\t\tif (v instanceof Date) { sp.set(k, v.toISOString()); continue }
\t\t\t\t\tif (typeof v === "symbol") continue
\t\t\t\t\tsp.set(k, String(v))
\t\t\t\t}
\t\t\t\tbody = sp.toString()
\t\t\t}
\t\t}

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
\t\tconst init: RequestInit = { body, headers, method, signal }
\t\tif (this.#config.credentials) init.credentials = this.#config.credentials
\t\tif (this.#config.mode) init.mode = this.#config.mode

\t\tconst _logOp = \`\${method.toUpperCase()} \${path}\`
\t\tconst _logStart = Date.now()
\t\tthis.#config.onLog?.({ duration_ms: 0, event: "request_start", level: "debug", operation: _logOp })

\t\ttry {
\t\t\tsignal?.throwIfAborted()
\t\t\tlet response = await this.#fetchFn(url, init)

\t\t\tif (response.status === 401 && this.#config.onAuthExpired && !isRetry && !(body instanceof FormData)) {
\t\t\t\tconst newToken = await this.#config.onAuthExpired()
\t\t\t\tif (newToken != null) {
\t\t\t\t\tconst retryHeaders = new Headers(headers)
\t\t\t\t\tconst authName = this.#config.authHeaderName ?? "Authorization"
\t\t\t\t\tconst authPrefix = this.#config.authHeaderPrefix ?? "Bearer "
\t\t\t\t\tretryHeaders.set(authName, \`\${authPrefix}\${newToken}\`)
\t\t\t\t\tresponse = await this.#fetchFn(url, { ...init, headers: retryHeaders })
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
\t\t\t\t\trequest: new Request(url, init),
\t\t\t\t\tresponse,
\t\t\t\t\tretry: () => {
\t\t\t\t\t\tif (isRetry) throw new Error("Max 1 retry per request")
\t\t\t\t\t\treturn this.#doRequest(method, path, opts, true, requestMeta)
\t\t\t\t\t\t\t.then(async (r) => {
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

\t\t\treturn { response }
\t\t} catch (err) {
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
\t\t} finally {
\t\t\tcleanup()
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
\t\tif (ct.startsWith("text/")) return response.text()
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
\t\tconst { response } = await this.#doRequest(method, path, opts, false, requestMeta)
\t\tif (!response.ok) {
\t\t\tthrow await this.#parseAsClientError(response)
\t\t}
\t\treturn this.#parseBody(response)
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
\t\tlet doResponse: { response: Response }
\t\ttry {
\t\t\tdoResponse = await this.#doRequest(method, path, opts, false, requestMeta)
\t\t} catch (e) {
\t\t\tif (e instanceof _ClientError) return { data: null, error: e, response: e.response, status: e.status }
\t\t\tthrow e
\t\t}
\t\tconst { response } = doResponse

\t\tif (!response.ok) {
\t\t\tconst preserved = response.clone()
\t\t\tconst error = await this.#parseErrorBody(response)
\t\t\treturn {
\t\t\t\tdata: null,
\t\t\t\terror,
\t\t\t\tresponse: preserved,
\t\t\t\tstatus: response.status,
\t\t\t}
\t\t}

\t\tlet data: unknown
\t\ttry {
\t\t\tdata = await this.#parseBody(response)
\t\t} catch (e) {
\t\t\treturn { data: null, error: e, response, status: response.status }
\t\t}
\t\treturn { data, error: null, response, status: response.status }
\t}
`
}

function sdkClientRequest(): string {
	return `
\tasync #request(entry: _ServiceEntry, input: Record<string, unknown>): Promise<unknown> {
\t\tconst path = this.#toColonParams(entry.path)
\t\tconst method = entry.method
\t\tconst opts = input as _RequestOptions
\t\tif (entry.idempotent) {
\t\t\tconst existing = opts.headers?.["Idempotency-Key"] ?? opts.headers?.["idempotency-key"]
\t\t\tif (existing === undefined) {
\t\t\t\tconst key = opts.idempotencyKey ?? crypto.randomUUID()
\t\t\t\topts.headers = { ...(opts.headers ?? {}), "Idempotency-Key": key }
\t\t\t}
\t\t}
\t\tconst params = opts.params
\t\tif (entry.params) {
\t\t\tfor (const p of entry.params) {
\t\t\t\tif (!params || params[p] === undefined) {
\t\t\t\t\tconst err = new _ClientError({
\t\t\t\t\t\tbody: null,
\t\t\t\t\t\tdata: null,
\t\t\t\t\t\tmessage: \`Missing required path param \\\`\${p}\\\` for \${method} \${entry.path}\`,
\t\t\t\t\t\tresponse: new Response(null, { status: 0 }),
\t\t\t\t\t\tstatus: 0,
\t\t\t\t\t})
\t\t\t\t\tif (!this.#config.throwOnError) return { data: null, error: err, response: err.response, status: 0 }
\t\t\t\t\tthrow err
\t\t\t\t}
\t\t\t}
\t\t}
\t\tconst cp = params ? this.#interpolatePath(path, params) : path
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
\t\tlet url = this.#buildURL(path, opts).replace(/^https:\\/\\//, "wss://").replace(/^http:\\/\\//, "ws://")
\t\tif (opts.reconnectToken) {
\t\t\tconst sep = url.includes("?") ? "&" : "?"
\t\t\turl = \`\${url}\${sep}reconnect_token=\${encodeURIComponent(opts.reconnectToken)}\`
\t\t}
\t\tconst ws = this.#createTypedWebSocket(url, opts.protocols)
\t\tif (entry.invalidate && entry.invalidate.length > 0) {
\t\t\tconst invalidate = entry.invalidate
\t\t\tconst params = opts.params
\t\t\tconst cs = \`WS \${params ? this.#interpolatePath(path, params) : path}\`
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
\t\tif (!this.#staleUntil || invalidate.length === 0) return
\t\tconst seq = ++this.#invalidationSeq
\t\tconst until = Date.now() + this.#staleTime
\t\tconst resolved = this.#resolveInvalidationTargets(invalidate, params)
\t\tfor (const target of resolved) {
\t\t\tconst existing = this.#staleUntil.get(target)
\t\t\tif (existing) {
\t\t\t\tif (!existing.by.includes(mutationSelector) && existing.by.length < this.#maxSourcesPerTarget) existing.by.push(mutationSelector)
\t\t\t\texisting.until = until
\t\t\t\texisting.seq = seq
\t\t\t} else { this.#staleUntil.set(target, { by: [mutationSelector], seq, until }) }
\t\t}
\t\tif (this.#staleUntil.size > this.#staleMaxEntries)
\t\t\tfor (const [k, entry] of this.#staleUntil)
\t\t\t\tif (entry.until <= Date.now()) this.#staleUntil.delete(k)
\t}
`
}

function sdkClientClearStale(): string {
	return `
\t#clearStale(concreteSelector: string, concretePath: string, method: string, seqSnapshot: number): void {
\t\tif (!this.#staleUntil) return
\t\tconst exact = this.#staleUntil.get(concreteSelector)
\t\tif (exact && exact.seq <= seqSnapshot) this.#staleUntil.delete(concreteSelector)
\t\tconst toDelete: string[] = []
\t\tfor (const [key, entry] of this.#staleUntil) {
\t\t\tif (entry.seq > seqSnapshot) continue
\t\t\tif (!key.includes(":")) continue
\t\t\tconst spaceIdx = key.indexOf(" ")
\t\t\tconst keyMethod = key.slice(0, spaceIdx)
\t\t\tconst keyPattern = key.slice(spaceIdx + 1)
\t\t\tif (keyMethod === method && this.#pathMatchesPattern(concretePath, keyPattern)) {
\t\t\t\ttoDelete.push(key)
\t\t\t}
\t\t}
\t\tfor (const key of toDelete) this.#staleUntil.delete(key)
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
\t\tconst { signal, cleanup } = this.#buildSignal(opts, true)
\t\tlet reader: ReadableStreamDefaultReader<Uint8Array> | undefined
\t\ttry {
\t\t\tif (this.#config.onRequest) {
\t\t\t\tconst reqCtx: { headers: Headers; invalidatedBy?: string[]; isStale?: boolean; method: string; path: string; selector?: string; state: Record<string, unknown>; url: string } = { headers, method, path, state: this.#config.state ?? {}, url }
\t\t\t\tfor (const hook of this.#config.onRequest) {
\t\t\t\t\tawait hook(reqCtx)
\t\t\t\t}
\t\t\t}
\t\t\tconst sseInit: RequestInit = { headers, method, signal }
\t\t\tif (this.#config.credentials) sseInit.credentials = this.#config.credentials
\t\t\tif (this.#config.mode) sseInit.mode = this.#config.mode
\t\t\tsignal?.throwIfAborted()
\t\t\tlet response = await this.#fetchFn(url, sseInit)
\t\t\tif (this.#config.onResponse) {
\t\t\t\tconst resCtx: { invalidatedBy?: string[]; isRetry: boolean; isStale?: boolean; method: string; path: string; request: Request; response: Response; retry: () => Promise<Response>; selector?: string; state: Record<string, unknown>; url: string } = {
\t\t\t\t\tisRetry: false, method, path, request: new Request(url, sseInit), response,
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
\t\t\t\tconst cs = \`\${method} \${opts.params ? this.#interpolatePath(path, opts.params) : path}\`
\t\t\t\tthis.#markStale(entry.invalidate, opts.params, cs)
\t\t\t}
\t\t\tif (!response.body) return
\t\t\tconst decoder = new TextDecoder()
\t\t\treader = response.body.getReader()
\t\t\tlet buffer = ""
\t\t\tconst maxBuffer = this.#sseMaxBufferChars
\t\t\twhile (true) {
\t\t\t\tconst { done, value } = await reader.read()
\t\t\t\tif (done) break
\t\t\t\tbuffer += decoder.decode(value, { stream: true })
\t\t\t\tif (buffer.length > maxBuffer) throw new Error(\`SSE buffer exceeded \${maxBuffer} characters\`)
\t\t\t\tconst blocks = buffer.split(/\\r\\n\\r\\n|\\r\\n\\r|\\r\\n\\n|\\r\\r\\n|\\n\\r\\n|\\n\\r|\\r\\r|\\n\\n/)
\t\t\t\tbuffer = blocks.pop() ?? ""
\t\t\t\tfor (const block of blocks) {
\t\t\t\t\tif (block.trim() === "") continue
\t\t\t\t\tconst event = this.#parseSSEBlock(block)
\t\t\t\t\tif (event) yield event
\t\t\t\t}
\t\t\t}
\t\t\tif (buffer.trim() !== "") {
\t\t\t\tconst event = this.#parseSSEBlock(buffer)
\t\t\t\tif (event) yield event
\t\t\t}
\t\t} finally {
\t\t\tif (reader) {
\t\t\t\ttry { await reader.cancel() } catch {}
\t\t\t\treader.releaseLock()
\t\t\t}
\t\t\tcleanup()
\t\t}
\t}
`
}

function sdkClientParseSSEBlock(): string {
	return `
\t#parseSSEBlock(block: string): _SSEEvent | undefined {
\t\tconst lines = block.split(/\\r\\n|\\r|\\n/)
\t\tlet isComment = true
\t\tlet data: string | undefined
\t\tlet event: string | undefined
\t\tlet id: string | undefined
\t\tlet retry: number | undefined
\t\tfor (const line of lines) {
\t\t\tif (line.startsWith(":")) continue
\t\t\tisComment = false
\t\t\tconst colonIdx = line.indexOf(":")
\t\t\tlet field: string
\t\t\tlet val: string
\t\t\tif (colonIdx === -1) {
\t\t\t\tfield = line
\t\t\t\tval = ""
\t\t\t} else {
\t\t\t\tfield = line.slice(0, colonIdx)
\t\t\t\tval = line.slice(colonIdx + 1)
\t\t\t\tif (val.startsWith(" ")) val = val.slice(1)
\t\t\t}
\t\t\tswitch (field) {
\t\t\t\tcase "data":
\t\t\t\t\tdata = data === undefined ? val : \`\${data}\\n\${val}\`
\t\t\t\t\tbreak
\t\t\t\tcase "event":
\t\t\t\t\tevent = val
\t\t\t\t\tbreak
\t\t\t\tcase "id":
\t\t\t\t\tif (!val.includes("\\0")) id = val
\t\t\t\t\tbreak
\t\t\t\tcase "retry": {
\t\t\t\t\tconst nr = Number(val)
\t\t\t\t\tif (Number.isFinite(nr) && nr >= 0) retry = nr
\t\t\t\t\tbreak
\t\t\t\t}
\t\t\t}
\t\t}
\t\tif (isComment || data === undefined) return undefined
\t\tconst evt: _SSEEvent = { data }
\t\tif (event !== undefined) evt.event = event
\t\tif (id !== undefined) evt.id = id
\t\tif (retry !== undefined) evt.retry = retry
\t\treturn evt
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

export function collectSDKMethods(spec: OpenApiSpecInput): {
	serviceMap: Record<string, Record<string, ServiceEntry>>
	nestedMap: Map<string, NestedServiceNode>
	methods: SDKMethod[]
} {
	/* toIR validates duplicates + collision; throws before any codegen runs */
	const ir = toIR(spec)
	const resolved = resolveRefs(spec)
	const serviceMap: Record<string, Record<string, ServiceEntry>> = {}
	const methods: SDKMethod[] = []

	for (const [path, pathMethods] of Object.entries(resolved.paths)) {
		for (const [method, operation] of Object.entries(pathMethods)) {
			const op = operation as Record<string, unknown>
			const operationId = op.operationId as string | undefined
			if (!operationId) continue

			const segments = operationId.split(".")
			const isTopLevel = segments.length === 1
			const resource = isTopLevel ? operationId : segments[0] ?? operationId
			const action = isTopLevel ? "_call" : segments.slice(1).join(".")

			if (serviceMap[resource] === undefined) {
				serviceMap[resource] = {}
			}

			const params = extractOpenApiPathParams(path)
			const entry: ServiceEntry = {
				method: method.toUpperCase(),
				path,
			}
			if (params.length > 0) entry.params = params
			const sse = isSSEOperation(op)
			if (sse) entry.sse = true
			if (op["x-websocket"] === true) entry.ws = true
			if (op["x-realtime"] === true) entry.realtime = true
			if (op["x-idempotency-key"] === true) entry.idempotent = true
			const xinv = op["x-invalidate"]
			if (Array.isArray(xinv) && xinv.length > 0) entry.invalidate = xinv as string[]

			serviceMap[resource][action] = entry
			const isWs = op["x-websocket"] === true
			const isRealtime = op["x-realtime"] === true
			const inputResult = emitSDKInputType(op, path)
			methods.push({
				action,
				errorsByStatusType: emitSDKErrorsByStatusType(op),
				inputHasMandatory: inputResult.hasMandatory,
				inputType: inputResult.type,
				realtime: isRealtime,
				resource,
				responseType: emitSDKResponseType(op),
				sse,
				ws: isWs,
			})
		}
	}

	const nestedMap = buildNestedServiceMap(ir.tree, resolved, spec)
	return { methods, nestedMap, serviceMap }
}

function buildServiceEntryForOp(
	op: Record<string, unknown>,
	path: string,
	method: string,
): ServiceEntry {
	const params = extractOpenApiPathParams(path)
	const entry: ServiceEntry = { method: method.toUpperCase(), path }
	if (params.length > 0) entry.params = params
	const sse = isSSEOperation(op)
	if (sse) entry.sse = true
	if (op["x-websocket"] === true) entry.ws = true
	if (op["x-realtime"] === true) entry.realtime = true
	if (op["x-idempotency-key"] === true) entry.idempotent = true
	const xinv = op["x-invalidate"]
	if (Array.isArray(xinv) && xinv.length > 0) entry.invalidate = xinv as string[]
	return entry
}

function buildNestedServiceMap(
	ns: IRNamespace,
	resolved: ReturnType<typeof resolveRefs>,
	_spec: OpenApiSpecInput,
): Map<string, NestedServiceNode> {
	/* build a lookup from operationId → (op record, path, method) for leaf nodes */
	const opLookup = new Map<string, { op: Record<string, unknown>; path: string; method: string }>()
	for (const [path, pathMethods] of Object.entries(resolved.paths)) {
		for (const [method, operation] of Object.entries(pathMethods)) {
			const op = operation as Record<string, unknown>
			const operationId = op.operationId as string | undefined
			if (operationId) opLookup.set(operationId, { method, op, path })
		}
	}

	function walkNs(namespace: IRNamespace): Map<string, NestedServiceNode> {
		const map = new Map<string, NestedServiceNode>()
		for (const [key, entry] of [...namespace.entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			if (entry.kind === "method") {
				const found = opLookup.get(entry.op.id)
				if (!found) continue
				const serviceEntry = buildServiceEntryForOp(found.op, found.path, found.method)
				map.set(key, { entry: serviceEntry, kind: "leaf" })
			} else {
				map.set(key, { children: walkNs(entry.ns), kind: "ns" })
			}
		}
		return map
	}

	return walkNs(ns)
}

export function generateSDK(
	spec: OpenApiSpecInput,
	options?: { name?: string; stem?: string },
): GeneratedSDK {
	const sdkName = options?.name ?? "SDK"
	const stem = options?.stem ?? "sdk"
	const { methods: sdkMethods, nestedMap, serviceMap } = collectSDKMethods(spec)
	const hasRealtime = sdkMethods.some((m) => m.realtime)

	const ir = toIR(spec)
	/* lookup by full operationId — action is already the rest after first segment, joined with "." */
	const fullMethodLookup = new Map<string, SDKMethod>()
	for (const m of sdkMethods) {
		const opId = m.action === "_call" ? m.resource : `${m.resource}.${m.action}`
		fullMethodLookup.set(opId, m)
	}

	return {
		files: {
			client: buildSDKClient(sdkName, stem),
			index: buildSDKIndex(sdkName, stem),
			map: buildSDKMap(nestedMap),
			runtime: hasRealtime ? buildSDKRuntime() : null,
			types: buildSDKTypes(sdkName, sdkMethods, ir.tree, fullMethodLookup),
		},
		serviceMap,
	}
}
