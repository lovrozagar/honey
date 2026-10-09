import { deriveSchemaName, sanitizeComponentName } from "../codegen-schema-naming.ts"
import type { HoneyError } from "../error.ts"
import { ERROR_META } from "../errors.ts"
import type { ErrorMetaEntry } from "../errors.ts"
import type { InvalidateCheckConfig, InvalidateCheckOperation } from "../invalidate-check.ts"
import { findInvalidSelectors, invalidateLevel, reportMissingInvalidate } from "../invalidate-check.ts"
import {
	applyMetaSpec,
	compileMetaSpec,
	MetaSpecCollector,
	resolveProfile,
	securitySchemeNames,
	type SchemaMetaHit,
	type SchemaMetaLookup,
} from "../meta-spec.ts"
import { parsePattern, UNNAMED_WILDCARD } from "../pattern.ts"
import type { RouteHandler } from "../tree.ts"
import type {
	InputSchemaEntry,
	InputSchemasDef,
	MetaSpecConfig,
	MetaSpecSchemaSource,
	StandardSchemaLike,
} from "../types.ts"
import { statusKeyToCode } from "../types.ts"
import { collectRoutes, collectWsRoutes, toOpenApiPath, unwrapEntry } from "./collect.ts"
import { getJsonSchemaConverter, instanceJsonSchema } from "./json-schema-slot.ts"

export type OpenApiRouteInfo<TMeta = unknown> = {
	meta: TMeta
	method: string
	path: string
}

export type OpenApiInfo = {
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
	servers?: Array<{ description?: string; url: string }>
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

type ErrorInfo = { errorKey: string; status: number; statusKey: string }

const STATUS_KEYS_BY_LENGTH = (Object.keys(statusKeyToCode) as Array<keyof typeof statusKeyToCode>).sort(
	(a, b) => b.length - a.length,
)

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

function getErrorFactory(app: unknown): Record<string, () => HoneyError> | null {
	return (app as { _errorFactory: Record<string, () => HoneyError> | null })._errorFactory
}

function getErrorSchema(app: unknown): StandardSchemaLike | null {
	return (app as { _errorSchema: StandardSchemaLike | null })._errorSchema
}

function getCustomErrorSchema(app: unknown): StandardSchemaLike | null {
	return (app as { _customErrorSchema: StandardSchemaLike | null })._customErrorSchema
}

function getErrorMeta(factory: Record<string, () => HoneyError> | null): Record<string, ErrorMetaEntry> | null {
	if (!factory) return null
	return (factory as Record<symbol, Record<string, ErrorMetaEntry>>)[ERROR_META] ?? null
}

function getMetaSpecConfig(app: unknown): MetaSpecConfig | null {
	return (app as { _metaSpec?: MetaSpecConfig | null })._metaSpec ?? null
}

function cloneJson<T>(value: T): T {
	try {
		return structuredClone(value)
	} catch {
		return JSON.parse(JSON.stringify(value)) as T
	}
}

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

const BINARY_FORM_FORMATS = new Set(["binary", "byte", "file"])

function isBinaryFormPart(schema: Record<string, unknown> | undefined): boolean {
	if (!schema) return false
	const format = schema.format
	if (typeof format === "string" && BINARY_FORM_FORMATS.has(format)) return true
	if (schema.type === "file") return true
	if (schema.type === "array") {
		const items = schema.items
		if (items !== null && typeof items === "object" && !Array.isArray(items)) {
			return isBinaryFormPart(items as Record<string, unknown>)
		}
	}
	return false
}

function formSchemaHasBinaryPart(schema: Record<string, unknown>): boolean {
	const props = schema.properties as Record<string, Record<string, unknown>> | undefined
	if (!props) return false
	for (const prop of Object.values(props)) {
		if (isBinaryFormPart(prop)) return true
	}
	return false
}

function asJsonSchema(
	entry: StandardSchemaLike | Record<string, unknown>,
	io: "input" | "output" = "output",
): Record<string, unknown> {
	if (entry !== null && entry !== undefined && "~standard" in (entry as object)) {
		const convert = getJsonSchemaConverter() ?? instanceJsonSchema
		return convert(entry as StandardSchemaLike, io)
	}
	return entry as Record<string, unknown>
}

function primaryOutputSchema(handler: RouteHandler): StandardSchemaLike | null {
	const json = handler.os?.["application/json"] as Record<string, unknown> | undefined
	if (!json) return null
	let best: { code: number; schema: StandardSchemaLike } | null = null
	for (const [statusKey, schema] of Object.entries(json)) {
		if (schema === undefined) continue
		const code = statusKeyToCode[statusKey as keyof typeof statusKeyToCode]
		if (!code || code < 200 || code > 299) continue
		if (!best || code < best.code) best = { code, schema: schema as StandardSchemaLike }
	}
	return best?.schema ?? null
}

function schemaChildren(node: Record<string, unknown>): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = []
	const push = (value: unknown): void => {
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			out.push(value as Record<string, unknown>)
		}
	}
	const props = node.properties
	if (props !== null && typeof props === "object" && !Array.isArray(props)) {
		for (const child of Object.values(props as Record<string, unknown>)) push(child)
	}
	push(node.items)
	for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
		const members = node[key]
		if (Array.isArray(members)) {
			for (const member of members) push(member)
		}
	}
	return out
}

function searchSchemaKey(root: Record<string, unknown>, key: string, maxDepth: number): SchemaMetaHit {
	let level = [root]
	for (let depth = 0; depth <= maxDepth && level.length > 0; depth++) {
		const matches: unknown[] = []
		const seen = new Set<string>()
		for (const node of level) {
			if (!Object.hasOwn(node, key) || node[key] === undefined) continue
			const fingerprint = JSON.stringify(node[key]) ?? "undefined"
			if (seen.has(fingerprint)) continue
			seen.add(fingerprint)
			matches.push(node[key])
		}
		if (matches.length === 1) return { found: true, value: matches[0] }
		if (matches.length > 1) return { found: "ambiguous", values: matches }
		const next: Record<string, unknown>[] = []
		for (const node of level) next.push(...schemaChildren(node))
		level = next
	}
	return { found: false }
}

const DEEP_SEARCH_MAX_DEPTH = 6

function makeSchemaMetaLookup(handler: RouteHandler): SchemaMetaLookup {
	const cache = new Map<string, Record<string, unknown> | undefined>()

	const rootOf = (source: MetaSpecSchemaSource): Record<string, unknown> | undefined => {
		if (cache.has(source)) return cache.get(source)
		let schema: StandardSchemaLike | null = null
		let io: "input" | "output" = "output"
		if (source === "output") {
			schema = primaryOutputSchema(handler)
		} else {
			io = "input"
			const key = source.slice("input.".length) as keyof InputSchemasDef
			const entry = handler.iv?.[key]
			schema = entry ? unwrapEntry(entry as InputSchemaEntry) : null
		}
		let root: Record<string, unknown> | undefined
		if (schema) {
			const converted = asJsonSchema(schema, io)
			root = converted && typeof converted === "object" ? converted : undefined
		}
		cache.set(source, root)
		return root
	}

	return (source, key, search) => {
		const root = rootOf(source)
		if (!root) return { found: false }
		if (search === "deep") return searchSchemaKey(root, key, DEEP_SEARCH_MAX_DEPTH)
		if (Object.hasOwn(root, key) && root[key] !== undefined) return { found: true, value: root[key] }
		if (root.type === "array") {
			const items = root.items
			if (items !== null && typeof items === "object" && !Array.isArray(items)) {
				const itemRoot = items as Record<string, unknown>
				if (Object.hasOwn(itemRoot, key) && itemRoot[key] !== undefined) {
					return { found: true, value: itemRoot[key] }
				}
			}
		}
		return { found: false }
	}
}

/** Methods an OpenAPI path item can hold. Anything else cannot be described and is skipped. */
const OPENAPI_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"])

/** What `app.all()` documents: every method a client would send to it, unless the path declares that method itself. */
const ALL_METHODS = ["get", "post", "put", "patch", "delete"] as const

type AppSettingsView = { stripPrefix?: string | null; trailingSlash?: "enforce" | "ignore" | "strip" }

function appSettings(app: unknown): AppSettingsView {
	return (app as { _graph?: { settings?: AppSettingsView } })._graph?.settings ?? {}
}

/** The URL path a client sends for a route path: `trailingSlash("enforce")` adds a slash. */
function publicPath(path: string, settings: AppSettingsView): string {
	if (settings.trailingSlash === "enforce" && path.length > 1 && !path.endsWith("/")) return `${path}/`
	return path
}

function isMetaInternal(meta: Record<string, unknown> | null): boolean {
	return meta?.internal === true
}

/** Path parameters of a concrete route path. Every path parameter is required in OpenAPI. */
function pathParameters(path: string): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = []
	for (const seg of parsePattern(path)) {
		if (seg.k === "param") {
			out.push({ in: "path", name: seg.n, required: true, schema: { type: "string" } })
		} else if (seg.k === "wildcard") {
			out.push({
				description: "The rest of the path; may contain `/`.",
				in: "path",
				name: seg.n === UNNAMED_WILDCARD ? "wildcard" : seg.n,
				required: true,
				schema: { type: "string" },
				"x-honey-wildcard": true,
			})
		}
	}
	return out
}

type ContentMap = Record<string, { schema: Record<string, unknown> }>

/** Add a response, merging content types and headers into one already declared for the status. */
function addResponse(
	responses: Record<string, Record<string, unknown>>,
	status: string,
	description: string,
	content: ContentMap | null,
	headers: Record<string, unknown> | null,
): void {
	const existing = responses[status]
	if (existing === undefined) {
		const response: Record<string, unknown> = {}
		if (content) response.content = content
		response.description = description
		if (headers) response.headers = headers
		responses[status] = response
		return
	}
	if (headers) existing.headers = { ...(existing.headers as Record<string, unknown> | undefined), ...headers }
	if (content) existing.content = { ...(existing.content as ContentMap | undefined), ...content }
}

/**
 * Turn a converted schema's local references into component references.
 *
 * Converters write `$ref: "#"` for recursion and `#/$defs/<name>` for shared nodes — relative
 * to the schema's own root. In an OpenAPI document `#` is the document, so each is hoisted into
 * `components.schemas` and the reference rewritten to point at it.
 */
class LocalRefHoister {
	readonly components: Record<string, Record<string, unknown>> = Object.create(null)

	private readonly taken: (name: string) => boolean

	constructor(taken: (name: string) => boolean) {
		this.taken = taken
	}

	private reserve(base: string): string {
		const clean = sanitizeComponentName(base) || "Schema"
		let name = clean
		for (let n = 2; this.taken(name) || Object.hasOwn(this.components, name); n++) name = `${clean}${n}`
		this.components[name] = {}
		return name
	}

	hoist(schema: Record<string, unknown>, hint: string): Record<string, unknown> {
		const defs = schema.$defs ?? schema.definitions
		const hasDefs = defs !== null && typeof defs === "object" && Object.keys(defs).length > 0
		const selfRef = refersTo(schema, "#")
		if (!hasDefs && !selfRef) return schema

		const rootName = selfRef ? this.reserve(hint) : null
		const defNames = new Map<string, string>()
		if (hasDefs) {
			for (const key of Object.keys(defs as Record<string, unknown>)) {
				defNames.set(key, this.reserve(key.startsWith("__schema") ? `${hint}${key.slice(8)}` : key))
			}
		}
		const rewrite = (ref: string): string | null => {
			if (ref === "#" && rootName !== null) return `#/components/schemas/${rootName}`
			for (const prefix of ["#/$defs/", "#/definitions/"]) {
				if (!ref.startsWith(prefix)) continue
				const name = defNames.get(decodePointer(ref.slice(prefix.length)))
				if (name !== undefined) return `#/components/schemas/${name}`
			}
			return null
		}
		for (const [key, name] of defNames) {
			this.components[name] = rewriteRefs((defs as Record<string, Record<string, unknown>>)[key], rewrite)
		}
		const { $defs: _defs, definitions: _definitions, ...rest } = schema
		const root = rewriteRefs(rest, rewrite)
		if (rootName === null) return root
		this.components[rootName] = root
		return { $ref: `#/components/schemas/${rootName}` }
	}
}

function decodePointer(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~")
}

/** Keys whose values are data, not schemas: a `$ref` inside them is a value, not a reference. */
const DATA_KEYS = new Set(["const", "default", "enum", "example", "examples"])

function refersTo(node: unknown, target: string): boolean {
	if (Array.isArray(node)) return node.some((item) => refersTo(item, target))
	if (node === null || typeof node !== "object") return false
	for (const [key, value] of Object.entries(node)) {
		if (key === "$ref" && value === target) return true
		if (DATA_KEYS.has(key)) continue
		if (refersTo(value, target)) return true
	}
	return false
}

function rewriteRefs(node: unknown, rewrite: (ref: string) => string | null): Record<string, unknown> {
	const walk = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(walk)
		if (value === null || typeof value !== "object") return value
		const out: Record<string, unknown> = {}
		for (const [key, child] of Object.entries(value)) {
			if (key === "$ref" && typeof child === "string") {
				out[key] = rewrite(child) ?? child
			} else if (DATA_KEYS.has(key)) {
				out[key] = child
			} else {
				out[key] = walk(child)
			}
		}
		return out
	}
	return walk(node) as Record<string, unknown>
}

function operationIdOf(operation: Record<string, unknown>): string | null {
	return typeof operation.operationId === "string" ? operation.operationId : null
}

type EmittedOperation = {
	handler: object
	/** What one registration shares across its operations: the handler function */
	source: unknown
	method: string
	operation: Record<string, unknown>
	path: string
	/** Path params beyond the route's shortest variant, for optional-param suffixes */
	params: string[]
}

/**
 * Make `operationId`s unique. One route that the document expands into several operations
 * (`.on(["GET","POST"])`, `all()`, an optional param) keeps one meta `operationId`; each
 * operation gets a method or variant suffix. Two different routes declaring the same id is
 * an authoring error.
 */
function assignOperationIds(emitted: readonly EmittedOperation[], collector: MetaSpecCollector): void {
	const byId = new Map<string, EmittedOperation[]>()
	for (const entry of emitted) {
		const id = operationIdOf(entry.operation)
		if (id === null) continue
		const list = byId.get(id)
		if (list) list.push(entry)
		else byId.set(id, [entry])
	}
	const used = new Set(byId.keys())
	for (const [id, group] of byId) {
		if (group.length < 2) continue
		/* `.on([...])` registers one record per method around one handler function */
		const handlers = new Set(group.map((g) => g.source))
		if (handlers.size > 1) {
			const where = group.map((g) => `${g.method.toUpperCase()} ${g.path}`).join(", ")
			collector.add(
				"DUPLICATE_OPERATION_ID",
				"error",
				`operationId "${id}" is declared by more than one route (${where}); operationIds must be unique`,
			)
			continue
		}
		const methods = new Set(group.map((g) => g.method))
		const minParams = Math.min(...group.map((g) => g.params.length))
		for (const entry of group) {
			let next = id
			if (methods.size > 1) next += `_${entry.method}`
			const extra = entry.params.slice(minParams)
			if (extra.length > 0) next += `_with_${extra.join("_")}`
			if (next === id) continue
			while (used.has(next)) next += "_"
			used.add(next)
			entry.operation.operationId = next
		}
	}
}

export function generateOpenApiFromTree<TMeta = unknown>(
	app: unknown,
	options: {
		filterRoutes?: (route: OpenApiRouteInfo<TMeta>) => boolean
		info: OpenApiInfo
		invalidate?: InvalidateCheckConfig
		profile?: string
		securitySchemes?: Record<string, unknown>
	},
): OpenApiSpec {
	const collector = new MetaSpecCollector()
	const metaSpec = compileMetaSpec(getMetaSpecConfig(app), collector)
	const { filter: profileFilter, name: profileName } = resolveProfile(metaSpec, options.profile, collector)
	const factory = getErrorFactory(app)
	const errorMeta = getErrorMeta(factory)
	const settings = appSettings(app)
	const hoister = new LocalRefHoister(() => false)

	const rawErrorSchema = getErrorSchema(app)
	const baseErrorJsonSchema = rawErrorSchema ? asJsonSchema(rawErrorSchema) : DEFAULT_ERROR_JSON_SCHEMA

	const rawCustomErrorSchema = getCustomErrorSchema(app)
	const customErrorAddsSchema = rawCustomErrorSchema ? asJsonSchema(rawCustomErrorSchema) : null

	const collected = collectRoutes(app)

	const routeFilter = options.filterRoutes
	const paths: Record<string, Record<string, Record<string, unknown>>> = Object.create(null)
	const emitted: InvalidateCheckOperation[] = []
	const operations: EmittedOperation[] = []

	/* explicit methods per path — `all()` documents only the methods nobody declared */
	const declared = new Set<string>()
	for (const { method, path } of collected) {
		if (method !== "ALL") declared.add(`${method.toLowerCase()} ${path}`)
	}
	const shortestParams = new Map<object, number>()
	for (const { handler, path } of collected) {
		const n = pathParameters(path).length
		const prev = shortestParams.get(handler)
		if (prev === undefined || n < prev) shortestParams.set(handler, n)
	}

	for (const { handler, method, path } of collected) {
		const meta = (handler.mt ?? null) as Record<string, unknown> | null
		if (isMetaInternal(meta)) continue
		if (routeFilter && !routeFilter({ meta: (meta ?? {}) as TMeta, method, path })) continue

		const methods =
			method === "ALL"
				? ALL_METHODS.filter((m) => !declared.has(`${m} ${path}`))
				: [method.toLowerCase()].filter((m) => {
						if (OPENAPI_METHODS.has(m)) return true
						collector.add(
							"UNSUPPORTED_METHOD",
							"warn",
							`${method} ${path}: OpenAPI cannot describe the ${method} method; the route is left out of the document`,
						)
						return false
					})
		if (methods.length === 0) continue

		const oaPath = publicPath(toOpenApiPath(path), settings)
		const params = pathParameters(path)
		const schemaHint = (role: "request" | "response", status?: number): string =>
			role === "request"
				? deriveSchemaName({ method: methods[0], path: oaPath, role })
				: deriveSchemaName({ method: methods[0], path: oaPath, role, status: status ?? 200 })

		/* the parts that do not depend on the method are built once per route */
		const parameters: Array<Record<string, unknown>> = params.map((p) => ({ ...p }))
		let requestBody: Record<string, unknown> | null = null
		const responses: Record<string, Record<string, unknown>> = {}

		if (handler.iv) {
			const body: ContentMap = {}
			for (const [source, entry] of Object.entries(handler.iv)) {
				if (entry === undefined) continue
				const unwrapped = unwrapEntry(entry as InputSchemaEntry)
				const jsonSchema = asJsonSchema(unwrapped, "input")

				if (source === "json" || source === "form") {
					const schema = hoister.hoist(stripInternalProps(jsonSchema), schemaHint("request"))
					if (source === "form") {
						if (formSchemaHasBinaryPart(jsonSchema)) body["multipart/form-data"] = { schema }
						body["application/x-www-form-urlencoded"] = { schema }
					} else {
						body["application/json"] = { schema }
					}
				} else if (source === "search" || source === "headers" || source === "cookies") {
					let location: "cookie" | "header" | "query" = "cookie"
					if (source === "search") location = "query"
					else if (source === "headers") location = "header"
					parameters.push(...propertyParameters(jsonSchema, location, hoister, schemaHint("request")))
				} else if (source === "params") {
					const props = jsonSchema.properties as Record<string, unknown> | undefined
					if (props) {
						for (const param of parameters) {
							if (param.in !== "path" || !Object.hasOwn(props, param.name as string)) continue
							param.schema = props[param.name as string]
						}
					}
				}
			}
			if (Object.keys(body).length > 0) requestBody = { content: body, required: true }
		}

		if (handler.os) {
			for (const [contentType, schemas] of Object.entries(handler.os)) {
				if (schemas === undefined) continue
				if (contentType === "redirect") {
					for (const statusKey of Object.keys(schemas)) {
						const statusCode = statusKeyToCode[statusKey as keyof typeof statusKeyToCode]
						if (!statusCode) continue
						addResponse(responses, String(statusCode), statusKey.replace(/_/g, " "), null, {
							Location: {
								description: "Redirect target URL",
								schema: { format: "uri", type: "string" },
							},
						})
					}
					continue
				}
				for (const [statusKey, schema] of Object.entries(schemas)) {
					if (schema === undefined) continue
					const statusCode = statusKeyToCode[statusKey as keyof typeof statusKeyToCode]
					if (!statusCode) continue
					const converted = asJsonSchema(schema as StandardSchemaLike | Record<string, unknown>)
					addResponse(
						responses,
						String(statusCode),
						statusKey.replace(/_/g, " "),
						{ [contentType]: { schema: hoister.hoist(converted, schemaHint("response", statusCode)) } },
						null,
					)
				}
			}
		}

		if (handler.ek.size > 0) {
			/* a mounted sub-app's route keeps its own error factory */
			const routeFactory = (handler.fac as Record<string, () => HoneyError> | null | undefined) ?? factory
			addErrorResponses(responses, handler, {
				baseErrorJsonSchema,
				customErrorAddsSchema,
				errorMeta: routeFactory === factory ? errorMeta : getErrorMeta(routeFactory),
				factory: routeFactory,
			})
		}

		if (Object.keys(responses).length === 0) {
			responses["200"] = { description: "Success" }
		}

		for (const methodKey of methods) {
			const operation: Record<string, unknown> = {}

			applyMetaSpec({
				collector,
				filter: profileFilter,
				kind: "http",
				meta,
				method: methodKey.toUpperCase(),
				operation,
				path,
				profile: profileName,
				schemaMeta: metaSpec.needsSchemas ? makeSchemaMetaLookup(handler) : undefined,
				spec: metaSpec,
			})

			if (requestBody) operation.requestBody = methods.length > 1 ? cloneJson(requestBody) : requestBody
			if (parameters.length > 0) operation.parameters = methods.length > 1 ? cloneJson(parameters) : parameters
			operation.responses = methods.length > 1 ? cloneJson(responses) : responses

			const pathItem = paths[oaPath] ?? (paths[oaPath] = {})
			pathItem[methodKey] = operation
			operations.push({
				handler,
				method: methodKey,
				source: handler.fn ?? handler,
				operation,
				params: params.slice(shortestParams.get(handler) ?? 0).map((p) => p.name as string),
				path: oaPath,
			})
			emitted.push({ meta, method: methodKey, operation, path: oaPath })
		}
	}

	const wsRoutes = collectWsRoutes(app)

	for (const { handler, path } of wsRoutes) {
		const meta = handler.mt
		if (isMetaInternal(meta)) continue
		if (routeFilter && !routeFilter({ meta: (meta ?? {}) as TMeta, method: "WS", path })) continue

		const oaPath = publicPath(toOpenApiPath(path), settings)
		if (paths[oaPath]?.get !== undefined) {
			collector.add(
				"WS_SHADOWED",
				"warn",
				`WS ${path}: GET ${oaPath} is an HTTP operation; the websocket route is left out of the document`,
			)
			continue
		}

		const operation: Record<string, unknown> = { "x-websocket": true }
		const parameters: Array<Record<string, unknown>> = pathParameters(path)

		applyMetaSpec({
			collector,
			filter: profileFilter,
			kind: "ws",
			meta,
			method: "WS",
			operation,
			path,
			profile: profileName,
			schemaMeta: metaSpec.needsSchemas ? makeSchemaMetaLookup(handler as unknown as RouteHandler) : undefined,
			spec: metaSpec,
		})

		const searchEntry = handler.iv?.search
		if (searchEntry) {
			const jsonSchema = asJsonSchema(unwrapEntry(searchEntry as InputSchemaEntry), "input")
			const hint = deriveSchemaName({ method: "get", path: oaPath, role: "request" })
			parameters.push(...propertyParameters(jsonSchema, "query", hoister, hint))
		}

		if (parameters.length > 0) operation.parameters = parameters
		operation.responses = { "101": { description: "WebSocket upgrade" } }

		const pathItem = paths[oaPath] ?? (paths[oaPath] = {})
		pathItem.get = operation
		operations.push({ handler, method: "get", operation, params: [], path: oaPath, source: handler.fn ?? handler })
	}

	assignOperationIds(operations, collector)
	checkSecurityReferences(operations, options.securitySchemes, collector)
	if (invalidateLevel(options.invalidate) !== "off") {
		const inventory = new Set(collected.map((r) => `${r.method} ${r.path}`))
		for (const bad of findInvalidSelectors(emitted, inventory)) {
			collector.add(
				"INVALID_SELECTOR",
				"error",
				`${bad.method} ${bad.path}: invalidate selector ${JSON.stringify(bad.selector)} names no route ` +
					'— write "<METHOD> <pattern>" for a registered route, e.g. "GET /users/:id"',
			)
		}
	}
	collector.flush()
	reportMissingInvalidate(emitted, options.invalidate)

	const result: OpenApiSpec = {
		info: cleanInfo(options.info),
		openapi: "3.1.0",
		paths: { ...paths },
	}
	if (settings.stripPrefix) {
		result.servers = [{ url: settings.stripPrefix }]
	}
	const hoisted = Object.keys(hoister.components).length > 0 ? { ...hoister.components } : null
	if (hoisted || options.securitySchemes) {
		result.components = {}
		if (hoisted) result.components.schemas = hoisted
		if (options.securitySchemes) result.components.securitySchemes = options.securitySchemes
	}
	return result
}

/** Only the Info Object's own fields: callers pass their whole options bag. */
function cleanInfo(info: OpenApiInfo): OpenApiInfo {
	const out: OpenApiInfo = { title: info.title, version: info.version }
	if (typeof info.description === "string") out.description = info.description
	return out
}

/** One parameter per property of an object schema (`search`, `headers`, `cookies`). */
function propertyParameters(
	jsonSchema: Record<string, unknown>,
	location: "cookie" | "header" | "query",
	hoister: LocalRefHoister,
	hint: string,
): Array<Record<string, unknown>> {
	const out: Array<Record<string, unknown>> = []
	const hoisted = hoister.hoist(jsonSchema, hint)
	/* a recursive search schema hoists its root; its properties are still the parameters */
	const root = hoisted.$ref === undefined ? hoisted : jsonSchema
	const props = root.properties as Record<string, unknown> | undefined
	if (!props) return out
	const required = new Set((root.required as string[] | undefined) ?? [])
	for (const name of Object.keys(props)) {
		const propSchema = props[name] as Record<string, unknown> | undefined
		if (propSchema?.["x-internal"] === true) continue
		out.push({ in: location, name, required: required.has(name), schema: propSchema ?? {} })
	}
	return out
}

type ErrorResponseContext = {
	baseErrorJsonSchema: Record<string, unknown>
	customErrorAddsSchema: Record<string, unknown> | null
	errorMeta: Record<string, ErrorMetaEntry> | null
	factory: Record<string, () => HoneyError> | null
}

function addErrorResponses(
	responses: Record<string, Record<string, unknown>>,
	handler: { ek: Set<string> },
	ctx: ErrorResponseContext,
): void {
	type ErrorEntry = { key: string; schema: Record<string, unknown> | null }
	const byStatus = new Map<number, ErrorEntry[]>()
	for (const ek of handler.ek) {
		const info = resolveErrorInfo(ek, ctx.factory)
		if (info.status <= 0) continue
		let entries = byStatus.get(info.status)
		if (!entries) {
			entries = []
			byStatus.set(info.status, entries)
		}
		const meta = ctx.errorMeta?.[ek]
		let customSchema: Record<string, unknown> | null = null
		if (meta?.schema) {
			const converted = asJsonSchema(meta.schema as StandardSchemaLike)
			if (converted && Object.keys(converted).length > 0) {
				customSchema = ctx.customErrorAddsSchema ? { allOf: [converted, ctx.customErrorAddsSchema] } : converted
			}
		}
		entries.push({ key: ek, schema: customSchema })
	}
	const standardSchema = (status: number, keys: string[]): Record<string, unknown> => {
		const schema = cloneJson(ctx.baseErrorJsonSchema)
		const props = schema.properties as Record<string, unknown> | undefined
		if (props?.error_key) props.error_key = { enum: [...keys].sort(), type: "string" }
		if (props?.status) props.status = { enum: [status], type: "integer" }
		return schema
	}
	for (const [status, entries] of byStatus) {
		if (responses[String(status)] !== undefined) continue
		const standardKeys = entries.filter((e) => !e.schema).map((e) => e.key)
		const customSchemas = entries.filter((e) => e.schema).map((e) => e.schema as Record<string, unknown>)

		let schema: Record<string, unknown>
		if (customSchemas.length === 0) {
			schema = standardSchema(status, standardKeys)
		} else if (standardKeys.length === 0 && customSchemas.length === 1) {
			schema = customSchemas[0]
		} else {
			const schemas: Record<string, unknown>[] = []
			if (standardKeys.length > 0) schemas.push(standardSchema(status, standardKeys))
			schemas.push(...customSchemas)
			schema = { oneOf: schemas }
		}

		responses[String(status)] = {
			content: { "application/json": { schema } },
			description: entries
				.map((e) => e.key)
				.sort()
				.join(", "),
		}
	}
}

/** Every scheme an operation's `security` names must exist in `components.securitySchemes`. */
function checkSecurityReferences(
	operations: readonly EmittedOperation[],
	schemes: Record<string, unknown> | undefined,
	collector: MetaSpecCollector,
): void {
	for (const { method, operation, path } of operations) {
		for (const name of securitySchemeNames(operation.security)) {
			if (schemes && Object.hasOwn(schemes, name)) continue
			collector.add(
				"UNKNOWN_SECURITY_SCHEME",
				schemes ? "error" : "warn",
				schemes
					? `${method.toUpperCase()} ${path}: security names "${name}", which is not in securitySchemes`
					: `security scheme "${name}" (first used by ${method.toUpperCase()} ${path}) is not declared — pass securitySchemes`,
			)
		}
	}
}
