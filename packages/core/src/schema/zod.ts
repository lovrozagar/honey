/**
 * Zod → JSON Schema. Zod 4 publishes Standard JSON Schema, so that runs first, with an override
 * that gives Date and BigInt their wire shape and records each node JSON Schema has no word for.
 * zod/mini, and a bundle that dropped the converter, publish none: the walk reads the definition
 * the schema carries (`_zod.def`). Core never imports zod (F2).
 */
import { dict } from "../routing/tree.ts"
import { compareCodeUnits } from "./canonicalize.ts"
import type { JsonSchema, SchemaIo } from "./to-json-schema.ts"

/** A zod definition as the walk reads it. */
type Def = { readonly type: string; readonly [key: string]: unknown }

/** What zod caches about a schema's checks: its format, bounds and patterns. */
type Bag = {
	readonly exclusiveMaximum?: unknown
	readonly exclusiveMinimum?: unknown
	readonly format?: unknown
	readonly maximum?: unknown
	readonly minimum?: unknown
	readonly patterns?: unknown
}

type Walk = (child: unknown) => JsonSchema
type Handler = (def: Def, walk: Walk, io: SchemaIo, schema: unknown) => JsonSchema
type Converter = ((params: unknown) => unknown) | undefined

/* past this depth a node is unconstrained: a recursive lazy schema would not end */
const MAX_DEPTH = 32

/** Node kinds JSON Schema has no word for: zod writes `{}` for each, and the rest survives. */
const UNREPRESENTABLE: readonly string[] = ["custom", "function", "map", "nan", "promise", "set", "symbol", "transform"]

/** Node kinds that leave no value constraint: unconstrained by design, not degraded. */
const OPEN: readonly string[] = ["any", "undefined", "unknown", "void"]

/** What zod 4 keeps on a schema: its definition, and what it caches about its checks. */
type Internals = { readonly bag: Bag; readonly def: Def }

/** `schema`'s zod 4 internals; anything else, a zod 3 schema among them, has none. */
function internals(schema: unknown): Internals | undefined {
	// oxlint-disable-next-line no-underscore-dangle -- zod 4 names its internals `_zod`
	return (schema as { _zod?: Internals })._zod
}

/** The definition of a schema the walk already holds as zod 4: a child of one. */
function childDef(schema: unknown): Def {
	return (internals(schema) as Internals).def
}

/** `json` with the format, bounds and pattern zod recorded for `schema`'s checks. */
function bagged(schema: unknown, json: JsonSchema): JsonSchema {
	const { bag } = internals(schema) as Internals
	if (bag.format === "safeint") json.type = "integer"
	else if (typeof bag.format === "string" && bag.format !== "regex") json.format = bag.format
	if (bag.patterns instanceof Set && bag.patterns.size === 1) {
		const [pattern] = bag.patterns as Set<RegExp>
		json.pattern = (pattern as RegExp).source
	}
	const [min, max] =
		json.type === "string"
			? ["minLength", "maxLength"]
			: json.type === "array"
				? ["minItems", "maxItems"]
				: ["minimum", "maximum"]
	if (typeof bag.minimum === "number") json[min] = bag.minimum
	if (typeof bag.maximum === "number") json[max] = bag.maximum
	if (typeof bag.exclusiveMinimum === "number") json.exclusiveMinimum = bag.exclusiveMinimum
	if (typeof bag.exclusiveMaximum === "number") json.exclusiveMaximum = bag.exclusiveMaximum
	return json
}

/** Whether an object key may be left out on the `io` side. */
function optional(def: Def, io: SchemaIo): boolean {
	if (def.type === "optional") return true
	/* a default fills the value in: optional going in, always there coming out */
	if (def.type === "default" || def.type === "prefault") return io === "input" || optional(childDef(def.innerType), io)
	if (def.type === "nullable" || def.type === "catch" || def.type === "readonly") {
		return optional(childDef(def.innerType), io)
	}
	return false
}

function object(def: Def, walk: Walk, io: SchemaIo): JsonSchema {
	const shape = def.shape as Readonly<Record<string, unknown>>
	const properties = dict<JsonSchema>()
	const required: string[] = []
	for (const key of Object.keys(shape)) {
		properties[key] = walk(shape[key])
		if (!optional(childDef(shape[key]), io)) required.push(key)
	}
	const json: JsonSchema = { properties, type: "object" }
	if (required.length > 0) json.required = required
	const rest = def.catchall
	/* a plain object strips unknown keys: none come out, any may go in */
	if (rest === undefined) {
		if (io === "output") json.additionalProperties = false
	} else json.additionalProperties = childDef(rest).type === "never" ? false : walk(rest)
	return json
}

function tuple(def: Def, walk: Walk): JsonSchema {
	const items = (def.items as readonly unknown[]).map(walk)
	const json: JsonSchema = { minItems: items.length, prefixItems: items, type: "array" }
	if (def.rest === null || def.rest === undefined) {
		json.items = false
		json.maxItems = items.length
	} else json.items = walk(def.rest)
	return json
}

/** Enum values: a TS numeric enum's reverse mappings left out, typed when they share one. */
function enumValues(def: Def): JsonSchema {
	const entries = def.entries as Readonly<Record<string, string | number>>
	const values = Object.keys(entries)
		.filter((key) => typeof entries[entries[key] as string] !== "number")
		.map((key) => entries[key])
	const types = new Set(values.map((value) => typeof value))
	return types.size === 1 ? { enum: values, type: [...types][0] } : { enum: values }
}

function literal(def: Def): JsonSchema {
	const values = (def.values as readonly unknown[]).map((value) => (typeof value === "bigint" ? Number(value) : value))
	return values.length === 1 ? { const: values[0] } : { enum: values }
}

/** The inner schema and its default; zod's `defaultValue` getter calls a default function. */
function defaulted(def: Def, walk: Walk): JsonSchema {
	return { ...walk(def.innerType), default: def.defaultValue }
}

const inner: Handler = (def, walk) => walk(def.innerType)
const binary: Handler = () => ({ contentEncoding: "binary", format: "binary", type: "string" })

/** Each definition type's JSON Schema; one not listed is unconstrained and reported. */
const BY_TYPE: Readonly<Record<string, Handler>> = {
	array: (def, walk, _io, schema) => bagged(schema, { items: walk(def.element), type: "array" }),
	bigint: () => ({ format: "int64", type: "integer" }),
	boolean: () => ({ type: "boolean" }),
	catch: inner,
	date: () => ({ format: "date-time", type: "string" }),
	default: defaulted,
	enum: enumValues,
	file: binary,
	intersection: (def, walk) => ({ allOf: [walk(def.left), walk(def.right)] }),
	lazy: (def, walk) => walk((def.getter as () => unknown)()),
	literal,
	nonoptional: inner,
	null: () => ({ type: "null" }),
	nullable: (def, walk) => ({ anyOf: [walk(def.innerType), { type: "null" }] }),
	number: (_def, _walk, _io, schema) => bagged(schema, { type: "number" }),
	object,
	optional: inner,
	/* a pipe validates `in` and hands back `out` */
	pipe: (def, walk, io) => walk(io === "input" ? def.in : def.out),
	prefault: defaulted,
	readonly: (def, walk) => ({ ...walk(def.innerType), readOnly: true }),
	record: (def, walk) => ({ additionalProperties: walk(def.valueType), type: "object" }),
	string: (_def, _walk, _io, schema) => bagged(schema, { type: "string" }),
	tuple,
	union: (def, walk) => ({ anyOf: (def.options as readonly unknown[]).map(walk) }),
}

function walkDef(schema: unknown, io: SchemaIo, degraded: Set<string>, depth: number): JsonSchema {
	if (depth > MAX_DEPTH) return {}
	const def = internals(schema)?.def
	if (def === undefined) {
		degraded.add("unrecognized")
		return {}
	}
	if (Object.hasOwn(BY_TYPE, def.type)) {
		return (BY_TYPE[def.type] as Handler)(def, (child) => walkDef(child, io, degraded, depth + 1), io, schema)
	}
	if (!OPEN.includes(def.type)) degraded.add(def.type)
	return {}
}

type OverrideContext = { jsonSchema: JsonSchema; zodSchema: unknown }

/** Zod's `override`: Date and BigInt as they cross the wire, and each node it could not express recorded. */
function override(degraded: Set<string>): (context: OverrideContext) => void {
	return ({ jsonSchema, zodSchema }) => {
		const kind = childDef(zodSchema).type
		if (kind === "date") Object.assign(jsonSchema, { format: "date-time", type: "string" })
		else if (kind === "bigint") Object.assign(jsonSchema, { format: "int64", type: "integer" })
		else if (UNREPRESENTABLE.includes(kind) && Object.keys(jsonSchema).length === 0) degraded.add(kind)
	}
}

/** Zod's own converter for `io`: Standard JSON Schema, else the instance method zod 4.0 and 4.1 carry. */
function converted(schema: unknown, io: SchemaIo, degraded: Set<string>): JsonSchema | undefined {
	const libraryOptions = { override: override(degraded), unrepresentable: "any" }
	const standard = (schema as { "~standard": { jsonSchema?: Record<SchemaIo, Converter> } })["~standard"]
	const fromStandard = standard.jsonSchema?.[io]
	if (typeof fromStandard === "function") {
		return fromStandard({ libraryOptions, target: "draft-2020-12" }) as JsonSchema
	}
	const method = (schema as { toJSONSchema?: (params: unknown) => unknown }).toJSONSchema
	if (typeof method === "function") return method.call(schema, { ...libraryOptions, io }) as JsonSchema
	return undefined
}

/**
 * The JSON Schema of the zod schema `schema` on the `io` side. `degraded` hears, once, the node
 * kinds that came out unconstrained.
 */
export function zodJsonSchema(schema: unknown, io: SchemaIo, degraded: (nodes: readonly string[]) => void): JsonSchema {
	const nodes = new Set<string>()
	const json = converted(schema, io, nodes) ?? walkDef(schema, io, nodes, 0)
	if (nodes.size > 0) degraded([...nodes].sort(compareCodeUnits))
	return json
}
