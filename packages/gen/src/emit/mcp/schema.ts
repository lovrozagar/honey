/**
 * An IR schema as the JSON Schema a tool's inputSchema holds (bit 18 phase b): self-contained, every ref inlined, as
 * terse as it can be read. A ref back to a schema being inlined becomes `{}`, any value, so a recursive model ends; a
 * pure cycle of refs with no schema between is an error, as is a schema past a node budget (shared refs inlined over and
 * over). Descriptions are spec text: their controls dropped (helpText), as the CLI's help drops them.
 */
import type { IRField, IRSchema } from "../../ir/model.ts"
import { helpText } from "../cli/flags.ts"

/** A JSON Schema, as plain data. */
export type JsonSchema = { readonly [key: string]: unknown }

/** The most nodes one schema may inline to by default: past it, a schema is refused, not emitted. */
export const NODE_BUDGET = 50_000

/** The walk's state: the schemas by name, the refs being inlined, and the nodes counted so far. */
type Walk = {
	readonly schemas: Readonly<Record<string, IRSchema>>
	readonly open: readonly string[]
	readonly budget: number
	nodes: { count: number }
}

/** `text` as a description: its controls dropped, nothing when it is empty. */
export const describe = (text: string | undefined): { description?: string } => {
	const shown = helpText(text ?? "").trim()
	return shown === "" ? {} : { description: shown }
}

/** An object's fields as JSON Schema properties and their required names. */
function objectOf(fields: readonly IRField[], additional: IRSchema | false | undefined, walk: Walk): JsonSchema {
	const required = fields.filter((field) => field.required).map((field) => field.name)
	return {
		type: "object",
		properties: Object.fromEntries(
			fields.map((field) => [field.name, { ...convert(field.schema, walk), ...describe(field.description) }]),
		),
		...(required.length > 0 ? { required } : {}),
		...(additional === undefined
			? {}
			: { additionalProperties: additional === false ? false : convert(additional, walk) }),
	}
}

/** `name`'s schema inlined, or `{}` when it is one being inlined already. */
function inlineRef(name: string, walk: Walk): JsonSchema {
	if (walk.open.includes(name)) return {}
	const target = walk.schemas[name]
	if (target === undefined) return {}
	if (target.kind === "ref" && (target.name === name || walk.open.includes(target.name)))
		throw new Error(`a $ref cycle with no schema between: ${[...walk.open, name, target.name].join(" → ")}`)
	return convert(target, { ...walk, open: [...walk.open, name] })
}

/** A scalar: its type, and its format, enum and constraint keywords when it has them. */
function scalarOf(schema: Extract<IRSchema, { kind: "scalar" }>): JsonSchema {
	const { enum: values, format, kind: _kind, type, ...bounds } = schema
	return {
		type,
		...(format === undefined ? {} : { format }),
		...(values === undefined || values.length === 0 ? {} : { enum: values }),
		...bounds,
	}
}

/** A tuple: its fixed items, what may follow them, and how many must be there. */
function tupleOf(schema: Extract<IRSchema, { kind: "tuple" }>, walk: Walk): JsonSchema {
	return {
		type: "array",
		prefixItems: schema.items.map((item) => convert(item, walk)),
		items: schema.rest === undefined ? false : convert(schema.rest, walk),
		minItems: schema.required ?? schema.items.length,
	}
}

/** `schema` as JSON Schema under `walk`. */
function convert(schema: IRSchema, walk: Walk): JsonSchema {
	if (++walk.nodes.count > walk.budget) throw new Error(`a schema inlines past ${walk.budget} nodes`)
	switch (schema.kind) {
		case "scalar":
			return scalarOf(schema)
		case "const":
			return { const: schema.value }
		case "object":
			return objectOf(schema.fields, schema.additional, walk)
		case "array":
			return {
				type: "array",
				items: convert(schema.items, walk),
				...(schema.minItems === undefined ? {} : { minItems: schema.minItems }),
				...(schema.maxItems === undefined ? {} : { maxItems: schema.maxItems }),
			}
		case "tuple":
			return tupleOf(schema, walk)
		case "union":
			return { anyOf: schema.variants.map((variant) => convert(variant, walk)) }
		case "allOf":
			return { allOf: schema.parts.map((part) => convert(part, walk)) }
		case "ref":
			return inlineRef(schema.name, walk)
		case "nullable":
			return { anyOf: [convert(schema.inner, walk), { type: "null" }] }
		case "binary":
			return { type: "string", contentEncoding: "base64" }
		case "unknown":
			return {}
	}
}

/** `schema` as a self-contained JSON Schema, every ref into `schemas` inlined, refused past `budget` nodes. */
export function jsonSchemaOf(
	schema: IRSchema,
	schemas: Readonly<Record<string, IRSchema>>,
	budget = NODE_BUDGET,
): JsonSchema {
	return convert(schema, { budget, nodes: { count: 0 }, open: [], schemas })
}
