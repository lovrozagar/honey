/**
 * The document's paths: each collected route as an operation per method under its OpenAPI path.
 * `all()` documents the standard methods its path does not declare itself; an optional param's
 * variants are two paths; a WebSocket route is a GET upgrade. Every operation carries its route
 * id as `x-honey-route`, the key bit 11 joins extracted ctx types on.
 */
import type { InputEntry, InputSchemas } from "../input/input.ts"
import { parsePattern, UNNAMED_WILDCARD } from "../routing/pattern.ts"
import { deriveSchemaName } from "../schema/naming.ts"
import type { JsonSchema } from "../schema/to-json-schema.ts"
import type { CollectedRoute, CollectedRoutes, CollectedWsRoute } from "./collect.ts"
import type { Convert, ResponseObject } from "./responses.ts"

export type Operation = Record<string, unknown>
export type PathItem = Record<string, Operation>

/** One emitted operation, for the checks that run over the whole document. */
export type EmittedOperation = {
	readonly method: string
	readonly operation: Operation
	readonly path: string
	readonly route: CollectedRoute | CollectedWsRoute
}

export type PathsContext = {
	/** the schema converter for one route; `where` names it in a report */
	readonly convert: (where: string) => Convert
	/** the route's policy fields for one method, written first */
	readonly policy: (route: CollectedRoute | CollectedWsRoute, method: string, kind: "http" | "ws") => Operation
	/** the route's responses, the errors it declares among them */
	readonly responses: (
		route: CollectedRoute,
		convert: Convert,
		hint: (code: number) => string,
	) => Record<string, ResponseObject>
	readonly trailingSlash: "enforce" | "ignore" | "strip"
	readonly warn: (code: "WS_SHADOWED", message: string) => void
}

const ALL_METHODS: readonly string[] = ["get", "post", "put", "patch", "delete"]
const BINARY_FORMATS: readonly string[] = ["binary", "byte", "file"]
const PROPERTY_SOURCES: Readonly<Record<string, string>> = { cookies: "cookie", headers: "header", search: "query" }

/** The path a client sends: `trailingSlash("enforce")` adds the slash. */
function publicPath(path: string, trailingSlash: PathsContext["trailingSlash"]): string {
	return trailingSlash === "enforce" && path.length > 1 && !path.endsWith("/") ? `${path}/` : path
}

/** The path parameters of one concrete path: each required, a wildcard marked as one. */
function pathParameters(route: CollectedRoute | CollectedWsRoute): Operation[] {
	const last = parsePattern(route.pattern).at(-1)
	const wildcard = last?.k === "wildcard" ? (last.n === UNNAMED_WILDCARD ? "wildcard" : last.n) : null
	return route.params.map((name) =>
		name === wildcard
			? {
					description: "The rest of the path; may contain `/`.",
					in: "path",
					name,
					required: true,
					schema: { type: "string" },
					"x-honey-wildcard": true,
				}
			: { in: "path", name, required: true, schema: { type: "string" } },
	)
}

const isRecord = (value: unknown): value is JsonSchema =>
	value !== null && typeof value === "object" && !Array.isArray(value)

/** The schema an input entry documents: a `readableStream()` wrapper by the schema it wraps. */
const schemaOf = (entry: InputEntry): unknown => ("_tag" in entry ? entry.schema : entry)

/** Whether a form part carries bytes: a binary format, a file, or an array of them. */
function isBinaryPart(schema: unknown): boolean {
	if (!isRecord(schema)) return false
	if (BINARY_FORMATS.includes(schema.format as string) || schema.type === "file") return true
	return schema.type === "array" && isBinaryPart(schema.items)
}

/** `schema` without its `x-internal` properties, and without them in `required`. */
function withoutInternal(schema: JsonSchema): JsonSchema {
	if (!isRecord(schema.properties)) return schema
	const kept = Object.entries(schema.properties).filter(([, p]) => !isRecord(p) || p["x-internal"] !== true)
	const out: JsonSchema = { ...schema, properties: Object.fromEntries(kept) }
	if (Array.isArray(schema.required)) out.required = schema.required.filter((k) => kept.some(([name]) => name === k))
	return out
}

/** One parameter per property of a search, headers or cookies object, `x-internal` ones left out. */
function propertyParameters(schema: JsonSchema, location: string): Operation[] {
	const required = Array.isArray(schema.required) ? schema.required : []
	return Object.entries(isRecord(schema.properties) ? schema.properties : {})
		.filter(([, p]) => !isRecord(p) || p["x-internal"] !== true)
		.map(([name, p]) => ({ in: location, name, required: required.includes(name), schema: p }))
}

type Inputs = { body: Record<string, { schema?: JsonSchema }> | null; parameters: Operation[] }

/** The request body and parameters a route's `.input()` declares, on their input side. */
function inputsOf(input: InputSchemas | null, convert: Convert, hint: string, parameters: Operation[]): Inputs {
	let body: Inputs["body"] = null
	for (const [source, entry] of Object.entries(input ?? {}) as [string, InputEntry | string | readonly string[]][]) {
		if (source === "binary") {
			const types = typeof entry === "string" ? [entry] : (entry as readonly string[])
			/* OpenAPI 3.1 says "any bytes" by leaving the schema out */
			body = Object.fromEntries(types.map((t) => [t, {}]))
			continue
		}
		const schema = convert(schemaOf(entry as InputEntry), "input", hint)
		if (source === "json") body = { "application/json": { schema: withoutInternal(schema) } }
		else if (source === "form") {
			const stripped = withoutInternal(schema)
			const binary = Object.values(isRecord(schema.properties) ? schema.properties : {}).some(isBinaryPart)
			body = binary ? { "multipart/form-data": { schema: stripped } } : {}
			body["application/x-www-form-urlencoded"] = { schema: stripped }
		} else if (source === "params") {
			for (const param of parameters) {
				const declared = isRecord(schema.properties) ? schema.properties[param.name as string] : undefined
				if (declared !== undefined) param.schema = declared
			}
		} else parameters.push(...propertyParameters(schema, PROPERTY_SOURCES[source] as string))
	}
	return { body, parameters }
}

/** The methods a route documents: its own, or for `all()` the standard ones its path leaves free. */
function methodsOf(route: CollectedRoute, declared: ReadonlySet<string>): string[] {
	if (route.method !== "ALL") return [route.method.toLowerCase()]
	return ALL_METHODS.filter((m) => !declared.has(`${m} ${route.path}`))
}

/** Every operation of `collected`, by public path and method, and the list the document checks run over. */
export function buildPaths(
	collected: CollectedRoutes,
	ctx: PathsContext,
): { operations: EmittedOperation[]; paths: Record<string, PathItem> } {
	const paths: Record<string, PathItem> = Object.create(null)
	const operations: EmittedOperation[] = []
	const declared = new Set(
		collected.http.filter((r) => r.method !== "ALL").map((r) => `${r.method.toLowerCase()} ${r.path}`),
	)
	for (const route of collected.http) {
		const methods = methodsOf(route, declared)
		const path = publicPath(route.path, ctx.trailingSlash)
		const convert = ctx.convert(`${route.method} ${route.pattern}`)
		const name = (role: "request" | "response", status = 200) =>
			deriveSchemaName(
				role === "request"
					? { method: methods[0] as string, path, role }
					: { method: methods[0] as string, path, role, status },
			)
		const { body, parameters } = inputsOf(route.input, convert, name("request"), pathParameters(route))
		const responses = ctx.responses(route, convert, (code) => name("response", code))
		for (const method of methods) {
			const operation: Operation = { ...ctx.policy(route, method.toUpperCase(), "http"), "x-honey-route": route.id }
			if (body !== null) operation.requestBody = { content: structuredClone(body), required: true }
			if (parameters.length > 0) operation.parameters = structuredClone(parameters)
			operation.responses = structuredClone(responses)
			paths[path] ??= {}
			;(paths[path] as PathItem)[method] = operation
			operations.push({ method, operation, path, route })
		}
	}
	for (const route of collected.ws) {
		const path = publicPath(route.path, ctx.trailingSlash)
		if (paths[path]?.get !== undefined) {
			ctx.warn(
				"WS_SHADOWED",
				`WS ${route.pattern}: GET ${path} is an HTTP operation; the websocket route is left out of the document`,
			)
			continue
		}
		const hint = deriveSchemaName({ method: "get", path, role: "request" })
		const search = route.input?.search
		const input = search === undefined ? null : ({ search } as InputSchemas)
		const { parameters } = inputsOf(input, ctx.convert(`WS ${route.pattern}`), hint, pathParameters(route))
		const operation: Operation = { "x-websocket": true, ...ctx.policy(route, "WS", "ws"), "x-honey-route": route.id }
		if (parameters.length > 0) operation.parameters = parameters
		operation.responses = { "101": { description: "WebSocket upgrade" } }
		paths[path] ??= {}
		;(paths[path] as PathItem).get = operation
		operations.push({ method: "get", operation, path, route })
	}
	return { operations, paths }
}

/**
 * Make operationIds unique. One registration the document expands into several operations
 * (`.on([...])`, `all()`, an optional param) keeps its id with a method or variant suffix; two
 * registrations declaring one id is an authoring error.
 */
export function assignOperationIds(operations: readonly EmittedOperation[], error: (message: string) => void): void {
	const byId = new Map<string, EmittedOperation[]>()
	for (const entry of operations) {
		const id = entry.operation.operationId
		if (typeof id === "string") byId.set(id, [...(byId.get(id) ?? []), entry])
	}
	const used = new Set(byId.keys())
	for (const [id, group] of byId) {
		if (group.length < 2) continue
		/* a WS route is its own registration: its id, shared by its variants */
		if (new Set(group.map(({ route }) => ("registration" in route ? route.registration : route.id))).size > 1) {
			const where = group.map((g) => `${g.method.toUpperCase()} ${g.path}`).join(", ")
			error(`operationId "${id}" is declared by more than one route (${where}); operationIds must be unique`)
			continue
		}
		const methods = new Set(group.map((g) => g.method))
		const fewest = Math.min(...group.map((g) => g.route.params.length))
		for (const entry of group) {
			let next = methods.size > 1 ? `${id}_${entry.method}` : id
			const extra = entry.route.params.slice(fewest)
			if (extra.length > 0) next += `_with_${extra.join("_")}`
			if (next === id) continue
			while (used.has(next)) next += "_"
			used.add(next)
			entry.operation.operationId = next
		}
	}
}
