/**
 * A converter's local references, lifted into the document's components. Converters write
 * `$ref: "#"` for recursion and `#/$defs/<name>` (or `#/definitions/<name>`) for shared nodes,
 * relative to the schema's own root; in a document `#` is the document, so each is lifted into
 * `components.schemas` and every reference rewritten to point there.
 */
import { sanitizeComponentName } from "../schema/naming.ts"
import type { JsonSchema } from "../schema/to-json-schema.ts"

/** Keys whose values are data, not schemas: a `$ref` inside them is a value, not a reference. */
const DATA_KEYS: readonly string[] = ["const", "default", "enum", "example", "examples"]

/* where a converter keeps shared nodes, and how a reference into each is spelled */
const DEF_KEYS: readonly (readonly [key: "$defs" | "definitions", prefix: string])[] = [
	["$defs", "#/$defs/"],
	["definitions", "#/definitions/"],
]

const COMPONENTS = "#/components/schemas/"

export type Components = {
	/** `schema` with its local references lifted; the same object when it has none. */
	hoist(schema: JsonSchema, hint: string): JsonSchema
	/** Every lifted component, in the order it was lifted. */
	schemas(): Record<string, JsonSchema>
}

function isRecord(value: unknown): value is JsonSchema {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Whether `node` holds `$ref: target` anywhere a schema can sit. */
function refersTo(node: unknown, target: string): boolean {
	if (Array.isArray(node)) return node.some((item) => refersTo(item, target))
	if (!isRecord(node)) return false
	return Object.entries(node).some(([key, value]) =>
		key === "$ref" && typeof value === "string"
			? value === target
			: !DATA_KEYS.includes(key) && refersTo(value, target),
	)
}

/** `node` with each `$ref` that `rewrite` maps replaced; data keywords copied as they are. */
function rewriteRefs(node: unknown, rewrite: (ref: string) => string | null): unknown {
	if (Array.isArray(node)) return node.map((item) => rewriteRefs(item, rewrite))
	if (!isRecord(node)) return node
	const out: JsonSchema = {}
	for (const [key, value] of Object.entries(node)) {
		if (key === "$ref" && typeof value === "string") out[key] = rewrite(value) ?? value
		else out[key] = DATA_KEYS.includes(key) ? value : rewriteRefs(value, rewrite)
	}
	return out
}

/** A JSON Pointer token, unescaped: `~1` is `/`, `~0` is `~`. */
const decodePointer = (token: string): string => token.replaceAll("~1", "/").replaceAll("~0", "~")

/** One document's components; `taken` names component names the caller already holds. */
export function createComponents(taken: (name: string) => boolean = () => false): Components {
	const lifted: Record<string, JsonSchema> = Object.create(null)

	const reserve = (base: string): string => {
		const clean = sanitizeComponentName(base) || "Schema"
		let name = clean
		for (let n = 2; taken(name) || Object.hasOwn(lifted, name); n++) name = `${clean}${n}`
		lifted[name] = {}
		return name
	}

	const hoist = (schema: JsonSchema, hint: string): JsonSchema => {
		const defs = DEF_KEYS.flatMap(([key, prefix]) =>
			Object.entries(isRecord(schema[key]) ? (schema[key] as JsonSchema) : {}).map(([name, def]) => ({
				def,
				name,
				prefix,
			})),
		)
		const selfRef = refersTo(schema, "#")
		if (defs.length === 0 && !selfRef) return schema
		const rootName = selfRef ? reserve(hint) : null
		/* each def's component name, by the reference that reaches it */
		const names = new Map<string, string>()
		for (const { name, prefix } of defs) {
			names.set(`${prefix}${name}`, reserve(name.startsWith("__schema") ? `${hint}${name.slice(8)}` : name))
		}
		const rewrite = (ref: string): string | null => {
			/* a `#` reference is what reserved the root's name */
			if (ref === "#") return `${COMPONENTS}${rootName as string}`
			const prefix = DEF_KEYS.find(([, p]) => ref.startsWith(p))?.[1]
			const name = prefix === undefined ? undefined : names.get(`${prefix}${decodePointer(ref.slice(prefix.length))}`)
			return name === undefined ? null : `${COMPONENTS}${name}`
		}
		for (const { def, name, prefix } of defs)
			lifted[names.get(`${prefix}${name}`) as string] = rewriteRefs(def, rewrite) as JsonSchema
		const { $defs: _defs, definitions: _definitions, ...rest } = schema
		const root = rewriteRefs(rest, rewrite) as JsonSchema
		if (rootName === null) return root
		lifted[rootName] = root
		return { $ref: `${COMPONENTS}${rootName}` }
	}

	return { hoist, schemas: () => ({ ...lifted }) }
}
