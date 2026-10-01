import { HoneyError } from "../error.ts"
import { ERROR_META } from "../errors.ts"
import type { ErrorMetaEntry } from "../errors.ts"
import type { InvalidateCheckConfig, InvalidateCheckOperation } from "../invalidate-check.ts"
import { reportMissingInvalidate } from "../invalidate-check.ts"
import {
	applyMetaSpec,
	compileMetaSpec,
	MetaSpecCollector,
	resolveProfile,
	type SchemaMetaHit,
	type SchemaMetaLookup,
} from "../meta-spec.ts"
import type { RouteHandler, TreeNode } from "../tree.ts"
import type {
	InputSchemaEntry,
	InputSchemasDef,
	MetaSpecConfig,
	MetaSpecSchemaSource,
	StandardSchemaLike,
} from "../types.ts"
import { statusKeyToCode } from "../types.ts"
import { type CollectedWSRoute, extractParams, toOpenApiPath, unwrapEntry, walkTree, walkWSRoutes } from "./collect.ts"
import { getJsonSchemaConverter } from "./json-schema-slot.ts"

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
		const convert = getJsonSchemaConverter()
		if (convert) return convert(entry as StandardSchemaLike, io)
		return {}
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

	const rawErrorSchema = getErrorSchema(app)
	const baseErrorJsonSchema = rawErrorSchema ? asJsonSchema(rawErrorSchema) : DEFAULT_ERROR_JSON_SCHEMA

	const rawCustomErrorSchema = getCustomErrorSchema(app)
	const customErrorAddsSchema = rawCustomErrorSchema ? asJsonSchema(rawCustomErrorSchema) : null

	const tree = (app as { _tree: TreeNode })._tree
	const collected: Array<{ handler: RouteHandler; method: string; path: string }> = []
	walkTree(tree, "", collected)

	const routeFilter = options.filterRoutes
	const paths: Record<string, Record<string, Record<string, unknown>>> = {}
	const emitted: InvalidateCheckOperation[] = []

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

		applyMetaSpec({
			collector,
			filter: profileFilter,
			kind: "http",
			meta: handler.mt as Record<string, unknown> | null,
			method,
			operation,
			path,
			profile: profileName,
			schemaMeta: metaSpec.needsSchemas ? makeSchemaMetaLookup(handler) : undefined,
			spec: metaSpec,
		})

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

		if (handler.iv) {
			for (const [source, entry] of Object.entries(handler.iv)) {
				if (entry === undefined) continue
				const unwrapped = unwrapEntry(entry as InputSchemaEntry)
				const jsonSchema = asJsonSchema(unwrapped, "input")

				if (source === "json" || source === "form") {
					const schema = stripInternalProps(jsonSchema)
					const content: Record<string, { schema: Record<string, unknown> }> = {}
					if (source === "form") {
						if (formSchemaHasBinaryPart(schema)) {
							content["multipart/form-data"] = { schema }
						}
						content["application/x-www-form-urlencoded"] = { schema }
					} else {
						content["application/json"] = { schema }
					}
					operation.requestBody = {
						content,
						required: true,
					}
				} else if (source === "search" || source === "headers" || source === "cookies") {
					let location: "cookie" | "header" | "query" = "cookie"
					if (source === "search") location = "query"
					else if (source === "headers") location = "header"
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
					const meta = errorMeta?.[ek]
					let customSchema: Record<string, unknown> | null = null
					if (meta?.schema) {
						const converted = asJsonSchema(meta.schema as StandardSchemaLike)
						if (converted && Object.keys(converted).length > 0) {
							customSchema = customErrorAddsSchema ? { allOf: [converted, customErrorAddsSchema] } : converted
						}
					}
					entries.push({ key: ek, schema: customSchema })
				}
			}
			for (const [status, entries] of byStatus) {
				if (responses[String(status)] === undefined) {
					const standardKeys = entries.filter((e) => !e.schema).map((e) => e.key)
					const customSchemas = entries.filter((e) => e.schema).map((e) => e.schema as Record<string, unknown>)

					let schema: Record<string, unknown>

					if (customSchemas.length === 0) {
						schema = cloneJson(baseErrorJsonSchema)
						const props = schema.properties as Record<string, unknown> | undefined
						if (props?.error_key) {
							props.error_key = { enum: standardKeys.sort(), type: "string" }
						}
						if (props?.status) {
							props.status = { enum: [status], type: "integer" }
						}
					} else if (standardKeys.length === 0 && customSchemas.length === 1) {
						schema = customSchemas[0]
					} else {
						const schemas: Record<string, unknown>[] = []
						if (standardKeys.length > 0) {
							const stdSchema = cloneJson(baseErrorJsonSchema)
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
		emitted.push({
			meta: handler.mt as Record<string, unknown> | null,
			method: methodKey,
			operation,
			path: oaPath,
		})
	}

	const wsRoutes: CollectedWSRoute[] = []
	walkWSRoutes(tree, "", wsRoutes)

	for (const { handler, path } of wsRoutes) {
		const oaPath = toOpenApiPath(path)
		if (paths[oaPath] === undefined) {
			paths[oaPath] = {}
		}

		const operation: Record<string, unknown> = { "x-websocket": true }
		const parameters: Array<Record<string, unknown>> = []

		applyMetaSpec({
			collector,
			filter: profileFilter,
			kind: "ws",
			meta: handler.mt,
			method: "WS",
			operation,
			path,
			profile: profileName,
			schemaMeta: metaSpec.needsSchemas ? makeSchemaMetaLookup(handler as unknown as RouteHandler) : undefined,
			spec: metaSpec,
		})

		const wsParams = extractParams(path)
		for (const name of wsParams) {
			parameters.push({
				in: "path",
				name,
				required: true,
				schema: { type: "string" },
			})
		}

		if (handler.iv?.search) {
			const searchEntry = handler.iv.search
			const searchSchema =
				"_tag" in searchEntry
					? (searchEntry as { schema: StandardSchemaLike }).schema
					: (searchEntry as StandardSchemaLike)
			const jsonSchema = asJsonSchema(searchSchema as StandardSchemaLike | Record<string, unknown>, "input")
			if (jsonSchema && typeof jsonSchema === "object") {
				const props = jsonSchema.properties as Record<string, unknown> | undefined
				const required = new Set((jsonSchema.required ?? []) as string[])
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

	collector.flush()
	reportMissingInvalidate(emitted, options.invalidate)

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
	return result
}
