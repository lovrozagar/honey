/**
 * What `generateTypes` reads from an app, written by hand: the OpenAPI document core would write
 * (each operation's `x-honey-route`, its parameters, body, responses, and the declared errors as
 * `x-honey-errors` plus `x-honey-error: true` on each error response), the route tree carrying each
 * route's meta, and the `ExtractedTypes` ts-morph would read. Mirrors core's openapi/paths.ts and
 * openapi/responses.ts layout; gen imports nothing from core (H2).
 */
import type { ExtractedProp, ExtractedTypes } from "../../../extract/extract.ts"
import type { RouteTreeV2, TreeNodeV2 } from "../route-tree.ts"

type Json = Record<string, unknown>

/** One registration: `method` upper case (`ALL`, `WS` too), `pattern` a honey pattern (`/users/:id`, `/files/*path`). */
export type HoneyRoute = {
	readonly method: string
	readonly pattern: string
	/** each source's object schema, as `.input()` declares it */
	readonly input?: { cookies?: Json; form?: Json; headers?: Json; json?: Json; search?: Json }
	/** media type → status key → schema, as `.output()` declares it */
	readonly output?: Record<string, Record<string, Json>>
	/** every declared error key: its status code (null: none) and own schema */
	readonly errors?: Record<string, { schema?: Json; status: number | null }>
	/** the route's resolved meta (chain, middleware and route), as the tree carries it */
	readonly meta?: Record<string, unknown>
}

export type HoneyApp = { readonly document: Json; readonly tree: RouteTreeV2 }

const STATUS_CODES: Readonly<Record<string, number>> = { accepted: 202, created: 201, no_content: 204, ok: 200 }
const ALL_METHODS = ["get", "post", "put", "patch", "delete"]
const PARAM_SOURCES: Readonly<Record<string, string>> = { cookies: "cookie", headers: "header", search: "query" }
const STRING = { type: "string" }

export const object = (properties: Json, required = Object.keys(properties)): Json => ({
	properties,
	required,
	type: "object",
})

/** honey's default error envelope, narrowed to the standard `keys` at `code`. */
const envelope = (keys: string[], code: number): Json =>
	object({
		error_key: { enum: keys, type: "string" },
		fields: {
			additionalProperties: { items: object({ error_key: STRING, message: STRING, path: STRING }), type: "array" },
			type: "object",
		},
		message: STRING,
		status: { enum: [code], type: "integer" },
		status_key: STRING,
		success: { const: false },
	})

/** The OpenAPI path of a honey pattern: `:id` → `{id}`, `*path` → `{path}`, a bare `*` → `{wildcard}`. */
const openApiPath = (pattern: string): string =>
	pattern.replace(/:([^/]+)/g, "{$1}").replace(/\*([^/]*)$/, (_, name: string) => `{${name || "wildcard"}}`)

function pathParameters(pattern: string): Json[] {
	return [...pattern.matchAll(/:([^/]+)|\*([^/]*)$/g)].map(([, param, rest]) =>
		param !== undefined
			? { in: "path", name: param, required: true, schema: STRING }
			: { in: "path", name: rest || "wildcard", required: true, schema: STRING, "x-honey-wildcard": true },
	)
}

function parametersOf(route: HoneyRoute): Json[] {
	const out = pathParameters(route.pattern)
	for (const [source, location] of Object.entries(PARAM_SOURCES)) {
		const schema = route.input?.[source as keyof NonNullable<HoneyRoute["input"]>]
		if (schema === undefined) continue
		const required = (schema.required ?? []) as string[]
		for (const [name, property] of Object.entries(schema.properties as Json))
			out.push({ in: location, name, required: required.includes(name), schema: property })
	}
	return out
}

function responsesOf(route: HoneyRoute): Record<string, Json> {
	const out: Record<string, Json> = {}
	for (const [media, statuses] of Object.entries(route.output ?? {}))
		for (const [key, schema] of Object.entries(statuses)) {
			const response = (out[String(STATUS_CODES[key])] ??= { content: {}, description: key })
			;(response.content as Json)[media] = { schema }
		}
	const byStatus = new Map<number, [string, Json | undefined][]>()
	for (const [key, { schema, status }] of Object.entries(route.errors ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (status === null || out[String(status)] !== undefined) continue
		byStatus.set(status, [...(byStatus.get(status) ?? []), [key, schema]])
	}
	for (const [code, entries] of byStatus) {
		const standard = entries.filter(([, s]) => s === undefined).map(([k]) => k)
		const schemas = [...(standard.length > 0 ? [envelope(standard, code)] : []), ...entries.flatMap(([, s]) => s ?? [])]
		const schema = schemas.length === 1 ? schemas[0] : { oneOf: schemas }
		out[String(code)] = {
			content: { "application/json": { schema } },
			description: entries.map(([k]) => k).join(", "),
			"x-honey-error": true,
		}
	}
	return Object.keys(out).length === 0 ? { 200: { description: "Success" } } : out
}

function operationOf(route: HoneyRoute, id: string): Json {
	if (route.method === "WS")
		return { responses: { 101: { description: "WebSocket upgrade" } }, "x-honey-route": id, "x-websocket": true }
	const op: Json = { "x-honey-route": id }
	if (typeof route.meta?.operationId === "string") op.operationId = route.meta.operationId
	const parameters = parametersOf(route)
	if (parameters.length > 0) op.parameters = parameters
	const { form, json } = route.input ?? {}
	if (json !== undefined) op.requestBody = { content: { "application/json": { schema: json } }, required: true }
	if (form !== undefined)
		op.requestBody = { content: { "application/x-www-form-urlencoded": { schema: form } }, required: true }
	op.responses = responsesOf(route)
	if (route.errors !== undefined && Object.keys(route.errors).length > 0)
		op["x-honey-errors"] = Object.fromEntries(Object.entries(route.errors).sort(([a], [b]) => (a < b ? -1 : 1)))
	return op
}

const node = (): TreeNodeV2 => ({ d: null, m: null, s: Object.create(null), w: null, ws: null })

/** Place route `id` in the tree under `root`. */
function plant(root: TreeNodeV2, method: string, pattern: string, id: string): void {
	let at = root as { -readonly [K in keyof TreeNodeV2]: TreeNodeV2[K] }
	for (const segment of pattern.split("/").filter(Boolean)) {
		if (segment.startsWith("*")) {
			at.w = { m: { ...at.w?.m, [method]: id }, n: segment.slice(1) || "*" }
			return
		}
		if (segment.startsWith(":")) at = (at.d ??= { c: node(), n: segment.slice(1) }).c as typeof at
		else at = ((at.s as Record<string, TreeNodeV2>)[segment] ??= node()) as typeof at
	}
	if (method === "WS") at.ws = id
	else at.m = { ...at.m, [method]: id }
}

/**
 * The app of `routes`: its document (an internal route left out, as core's document does) and its
 * route tree (every route, each with its meta). `components` become the document's schemas.
 */
export function honeyDoc(routes: readonly HoneyRoute[], components: Record<string, Json> = {}): HoneyApp {
	const paths: Record<string, Json> = {}
	const root = node()
	const entries: Record<string, { ek?: string[]; mt: Record<string, unknown> }> = {}
	for (const route of routes) {
		const id = `${route.method} ${route.pattern}`
		plant(root, route.method, route.pattern, id)
		entries[id] = { mt: route.meta ?? {} }
		if (route.errors !== undefined) (entries[id] as { ek?: string[] }).ek = Object.keys(route.errors)
		if (route.meta?.internal === true) continue
		const item = (paths[openApiPath(route.pattern)] ??= {})
		const methods = route.method === "ALL" ? ALL_METHODS : [route.method === "WS" ? "get" : route.method.toLowerCase()]
		for (const method of methods) item[method] = operationOf(route, id)
	}
	const doc: Json = { info: { title: "App", version: "1" }, openapi: "3.1.0", paths }
	if (Object.keys(components).length > 0) doc.components = { schemas: components }
	return { document: doc, tree: { root, routes: entries, v: 2 } }
}

export type ExtractedSpec = {
	readonly env?: string
	/** route id → its parsed `ctx.input` type text (O3) */
	readonly inputs?: Record<string, string>
	/** name → type text; a `?` suffix on the name marks it optional */
	readonly middleware?: Record<string, string>
	/** route id → what that route's middleware added, as `middleware` */
	readonly routes?: Record<string, Record<string, string>>
	readonly taps?: string | null
}

const props = (spec: Record<string, string> = {}): ExtractedProp[] =>
	Object.entries(spec).map(([name, type]) => ({ name: name.replace(/\?$/, ""), optional: name.endsWith("?"), type }))

/** The `ExtractedTypes` of `spec`: env defaults to `Record<string, unknown>`, everything else to empty. */
export function extracted(spec: ExtractedSpec = {}): ExtractedTypes {
	return {
		env: spec.env ?? "Record<string, unknown>",
		inputs: spec.inputs ?? {},
		middleware: props(spec.middleware),
		routes: Object.fromEntries(Object.entries(spec.routes ?? {}).map(([id, added]) => [id, props(added)])),
		taps: spec.taps ?? null,
	}
}
