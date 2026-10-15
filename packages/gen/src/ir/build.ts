/**
 * The IR from an OpenAPI 3.x document: its component schemas, its operations (each with an id,
 * explicit or derived), the resource tree over them, how a client authenticates, and the
 * document's info. Reads the document alone; gen never reaches into core (H2).
 */
import { compareCodeUnits, pascalWords } from "../emit/shared/lang.ts"
import { type IR, type IRAuth, type IRInfo, type IROperation, type IRSchema, schemaToIR } from "./model.ts"
import { buildResourceTree } from "./resource-tree.ts"
import { type Components, extensionsOf, paramsOf, parseOpenApiPath, requestBodies, responsesOf } from "./slots.ts"

type Json = Record<string, unknown>

/** An OpenAPI document as gen reads it: plain JSON. */
export type OpenApiDocument = {
	readonly components?: Readonly<Record<string, Readonly<Record<string, unknown>>>> & {
		readonly schemas?: Readonly<Record<string, Json>>
	}
	readonly info?: Readonly<Record<string, unknown>>
	readonly openapi: string
	readonly paths?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

export type ToIROptions = {
	/** give an operation without an `operationId` a derived one instead of leaving it out (the non-TS emitters) */
	readonly deriveOperationIds?: boolean
	/** a shared id: `"suffix"` adds the method (the default when deriving), `"throw"` refuses the document */
	readonly duplicateOperationIds?: "suffix" | "throw"
}

const METHODS: readonly string[] = ["get", "post", "put", "patch", "delete", "head", "options"]

/** A stable id for an operation without one: `GET /users/{id}` → `getUsersById`, `GET /` → `getRoot`. */
export function deriveOperationId(method: string, path: string): string {
	const segments = parseOpenApiPath(path)
	const literal = segments.flatMap((seg) => (seg.kind === "literal" ? [pascalWords(seg.text)] : []))
	const params = segments.flatMap((seg) => (seg.kind === "param" ? [pascalWords(seg.name)] : []))
	const base = `${method.toLowerCase()}${literal.join("")}${params.length > 0 ? `By${params.join("And")}` : ""}`
	return base === method.toLowerCase() ? `${base}Root` : base
}

/** The first `name`, `name2`, `name3`… nothing in `taken` holds. */
function free(name: string, taken: (candidate: string) => boolean): string {
	let candidate = name
	for (let n = 2; taken(candidate); n++) candidate = `${name}${n}`
	return candidate
}

/** Where an operation sits: its method and path, its path item, and the document's components. */
type Site = { readonly components: Components; readonly item: Json; readonly method: string; readonly path: string }

function operationOf(id: string, op: Json, { components, item, method, path }: Site): IROperation {
	const bodies = requestBodies(op, components)
	const { responses, sse } = responsesOf(op, components)
	const operation: IROperation = {
		extensions: extensionsOf(op, sse),
		id,
		method: method.toUpperCase(),
		params: paramsOf(path, op, item, components),
		path,
		responses,
	}
	if (bodies[0] !== undefined) operation.body = bodies[0]
	if (bodies.length > 1) operation.bodies = bodies
	if (typeof op.description === "string") operation.description = op.description
	if (typeof op.summary === "string") operation.summary = op.summary
	return operation
}

/**
 * How a client authenticates, from the first security scheme in code-unit order: http basic is
 * `Basic `, other http `Bearer `, a header apiKey its header with the prefix its description gives
 * (`Format: <prefix> {token}`). Anything else, or no scheme, is `Authorization: Bearer`.
 */
export function specAuth(doc: OpenApiDocument): IRAuth {
	const schemes = (doc.components?.securitySchemes ?? {}) as Record<string, Json>
	const first = Object.keys(schemes).sort(compareCodeUnits)[0]
	const scheme = first === undefined ? undefined : schemes[first]
	if (scheme?.type === "http") {
		return {
			headerName: "Authorization",
			prefix: String(scheme.scheme).toLowerCase() === "basic" ? "Basic " : "Bearer ",
		}
	}
	if (scheme?.type === "apiKey" && scheme.in === "header") {
		const prefix = /Format:\s*(\S+)\s+\{/i.exec(String(scheme.description ?? ""))
		return { headerName: String(scheme.name ?? "Authorization"), prefix: prefix === null ? "" : `${prefix[1]} ` }
	}
	return { headerName: "Authorization", prefix: "Bearer " }
}

function infoOf(doc: OpenApiDocument): IRInfo {
	const info = doc.info ?? {}
	return Object.fromEntries(
		(["title", "description", "version"] as const).flatMap((key) =>
			typeof info[key] === "string" ? [[key, info[key]]] : [],
		),
	)
}

/** The operations with an explicit id, a shared one suffixed by method or refused; and those without one. */
function explicitOperations(doc: OpenApiDocument, options: ToIROptions, seen: Set<string>) {
	const components = (doc.components ?? {}) as Components
	const onDuplicate = options.duplicateOperationIds ?? (options.deriveOperationIds === true ? "suffix" : "throw")
	const operations: IROperation[] = []
	const unnamed: [Json, Site][] = []
	for (const [path, item] of Object.entries(doc.paths ?? {})) {
		for (const method of METHODS.filter((m) => item[m] !== undefined)) {
			const op = item[method] as Json
			const id = op.operationId as string | undefined
			const site = { components, item, method, path }
			if (id === undefined) unnamed.push([op, site])
			else if (seen.has(id) && onDuplicate === "throw") throw new Error(`Duplicate operationId: "${id}"`)
			else {
				const final = seen.has(id) ? free(`${id}${pascalWords(method)}`, (c) => seen.has(c)) : id
				seen.add(final)
				operations.push(operationOf(final, op, site))
			}
		}
	}
	return { operations, unnamed }
}

/** The IR of `doc`; an explicit id always keeps its name, a derived one takes what is left. */
export function toIR(doc: OpenApiDocument, options: ToIROptions = {}): IR {
	const schemas: Record<string, IRSchema> = {}
	const schemaDescriptions: Record<string, string> = {}
	for (const [name, schema] of Object.entries(doc.components?.schemas ?? {})) {
		schemas[name] = schemaToIR(schema)
		if (typeof schema.description === "string") schemaDescriptions[name] = schema.description
	}
	const seen = new Set<string>()
	const { operations, unnamed } = explicitOperations(doc, options, seen)
	/* derived ids after explicit ones, clear of explicit ids and of their namespaces */
	const roots = new Set(operations.map(({ id }) => id.split(".")[0] as string))
	for (const [op, site] of options.deriveOperationIds === true ? unnamed : []) {
		const id = free(deriveOperationId(site.method, site.path), (c) => seen.has(c) || roots.has(c))
		seen.add(id)
		operations.push(operationOf(id, op, site))
	}
	return {
		auth: specAuth(doc),
		info: infoOf(doc),
		operations,
		schemaDescriptions,
		schemas,
		tree: buildResourceTree(operations),
	}
}
