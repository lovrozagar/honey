/** OpenAPI cleanup of Zod JSON Schema. Not a package export. */

const SCHEMA_VALUE_KEYS = new Set([
	"additionalProperties",
	"contains",
	"else",
	"if",
	"items",
	"not",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
])

const SCHEMA_MAP_KEYS = new Set(["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"])

const SCHEMA_ARRAY_KEYS = new Set(["allOf", "anyOf", "oneOf", "prefixItems"])

function asRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function sanitizeSchemaValue(value: unknown): unknown {
	if (typeof value === "boolean") return value
	if (asRecord(value)) return sanitizeZodJsonSchema(value)
	return value
}

export function sanitizeZodJsonSchema(obj: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, val] of Object.entries(obj)) {
		if (key === "$schema" || key === "~standard") continue
		if (key === "anyOf" && Array.isArray(val)) {
			out.oneOf = val.map((item) => sanitizeSchemaValue(item))
			continue
		}
		if (SCHEMA_MAP_KEYS.has(key) && asRecord(val)) {
			const mapped: Record<string, unknown> = {}
			for (const [childKey, child] of Object.entries(val)) {
				mapped[childKey] = sanitizeSchemaValue(child)
			}
			out[key] = mapped
			continue
		}
		if (SCHEMA_ARRAY_KEYS.has(key) && Array.isArray(val)) {
			out[key] = val.map((item) => sanitizeSchemaValue(item))
			continue
		}
		if (SCHEMA_VALUE_KEYS.has(key)) {
			if (key === "items" && Array.isArray(val)) {
				out[key] = val.map((item) => sanitizeSchemaValue(item))
			} else {
				out[key] = sanitizeSchemaValue(val)
			}
			continue
		}
		out[key] = val
	}
	return out
}
