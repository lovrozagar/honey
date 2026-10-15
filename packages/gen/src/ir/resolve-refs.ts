/**
 * Inlining component schemas: every `$ref` under a request body or a response replaced by the
 * schema it names, for the SDK emitters that type each call in place. A cycle is cut with `{}`
 * (unknown), and the expansion is capped: shared refs can grow a document exponentially.
 */
import type { OpenApiDocument } from "./build.ts"

type Json = Record<string, unknown>

const PREFIX = "#/components/schemas/"

/* past this many schema nodes, inlining fails loudly instead of eating the machine */
const MAX_NODES = 200_000

type Inlining = { readonly schemas: Readonly<Record<string, Json>>; nodes: number }

const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value)

/** `schema` with its component ref, if it is one, replaced by a copy of the component, inlined. */
function inline(schema: Json, run: Inlining, visited: ReadonlySet<string>): Json {
	if (typeof schema.$ref !== "string" || !schema.$ref.startsWith(PREFIX)) return inlineChildren(schema, run, visited)
	const name = schema.$ref.slice(PREFIX.length)
	if (visited.has(name)) return {}
	if (!Object.hasOwn(run.schemas, name)) throw new Error(`$ref points to nonexistent component: ${schema.$ref}`)
	return inlineChildren(structuredClone(run.schemas[name] as Json), run, new Set([...visited, name]))
}

/** `schema` with the schemas under its composition keywords, items, properties and additional properties inlined. */
function inlineChildren(schema: Json, run: Inlining, visited: ReadonlySet<string>): Json {
	if (++run.nodes > MAX_NODES) {
		throw new Error(
			`SDK codegen: inlined schemas exceed ${MAX_NODES} nodes (deeply shared $refs); flatten the shared component chain`,
		)
	}
	const child = (value: unknown) => (isRecord(value) ? inline(value, run, visited) : value)
	for (const key of ["oneOf", "anyOf", "allOf"]) {
		const list = schema[key]
		if (Array.isArray(list)) schema[key] = list.map(child)
	}
	if (isRecord(schema.items)) schema.items = child(schema.items)
	if (isRecord(schema.properties)) {
		schema.properties = Object.fromEntries(Object.entries(schema.properties).map(([key, value]) => [key, child(value)]))
	}
	if (isRecord(schema.additionalProperties)) schema.additionalProperties = child(schema.additionalProperties)
	return schema
}

/** Each media type's schema in `holder.content` inlined, in place. */
function inlineContent(holder: unknown, run: Inlining): void {
	if (!isRecord(holder) || !isRecord(holder.content)) return
	holder.content = Object.fromEntries(
		Object.entries(holder.content).map(([type, media]) => {
			const inlined = isRecord(media) && isRecord(media.schema) ? inline(media.schema, run, new Set()) : undefined
			return [type, inlined === undefined ? media : { ...(media as Json), schema: inlined }]
		}),
	)
}

/**
 * `doc` with every body and response schema inlined and its schema components dropped; a
 * document without schema components comes back as it is. `doc` itself is never changed.
 */
export function resolveRefs(doc: OpenApiDocument): OpenApiDocument {
	const { components } = doc
	const schemas = components?.schemas
	if (schemas === undefined || Object.keys(schemas).length === 0) return doc
	const run: Inlining = { nodes: 0, schemas }
	const paths = structuredClone(doc.paths ?? {}) as Record<string, Record<string, Json>>
	for (const item of Object.values(paths)) {
		for (const op of Object.values(item)) {
			inlineContent(op.requestBody, run)
			for (const response of Object.values(isRecord(op.responses) ? op.responses : {})) inlineContent(response, run)
		}
	}
	/* schemas were there, so components are */
	const { schemas: _inlined, ...rest } = components as NonNullable<OpenApiDocument["components"]>
	return { ...doc, components: Object.keys(rest).length > 0 ? rest : undefined, paths }
}
