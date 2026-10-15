/**
 * Yup → JSON Schema from the schema's own `describe()`: yup publishes no JSON Schema, and core never
 * imports yup (F2).
 */
import { dict } from "../routing/tree.ts"
import type { JsonSchema } from "./to-json-schema.ts"

/** A node of yup's `describe()` output, as the walk reads it. */
type Description = {
	readonly fields?: Readonly<Record<string, Description>>
	readonly innerType?: Description | readonly Description[]
	readonly nullable?: boolean
	readonly oneOf?: readonly unknown[]
	readonly optional?: boolean
	readonly type: string
}

function object(description: Description): JsonSchema {
	const fields = description.fields as Readonly<Record<string, Description>>
	const keys = Object.keys(fields)
	if (keys.length === 0) return { type: "object" }
	const properties = dict<JsonSchema>()
	const required: string[] = []
	for (const key of keys) {
		const field = fields[key] as Description
		properties[key] = described(field)
		if (field.optional !== true) required.push(key)
	}
	const json: JsonSchema = { properties, type: "object" }
	if (required.length > 0) json.required = required
	return json
}

function base(description: Description): JsonSchema {
	const inner = description.innerType
	switch (description.type) {
		case "array":
			return inner === undefined || Array.isArray(inner)
				? { type: "array" }
				: { items: described(inner as Description), type: "array" }
		case "boolean":
		case "number":
		case "string":
			return { type: description.type }
		case "date":
			return { format: "date-time", type: "string" }
		case "mixed":
			return description.oneOf !== undefined && description.oneOf.length > 0 ? { enum: description.oneOf } : {}
		case "object":
			return object(description)
		case "tuple": {
			const items = (inner as readonly Description[]).map(described)
			return { items: false, maxItems: items.length, minItems: items.length, prefixItems: items, type: "array" }
		}
		default:
			return {}
	}
}

function described(description: Description): JsonSchema {
	const json = base(description)
	return description.nullable === true ? { anyOf: [json, { type: "null" }] } : json
}

/** The JSON Schema of the yup schema `schema`; {} for anything without `describe()`. */
export function yupJsonSchema(schema: unknown): JsonSchema {
	const describe = (schema as { describe?: unknown }).describe
	return typeof describe === "function" ? described(describe.call(schema) as Description) : {}
}
