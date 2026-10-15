/**
 * ArkType → JSON Schema through the instance converter older ArkType carries; current ArkType
 * publishes Standard JSON Schema, which the dispatch reads first. Core never imports arktype (F2).
 */
import type { JsonSchema } from "./to-json-schema.ts"

/** The JSON Schema `schema`'s own `toJsonSchema` gives; {} without one, or when it throws. */
export function arktypeJsonSchema(schema: unknown): JsonSchema {
	const convert = (schema as { toJsonSchema?: unknown }).toJsonSchema
	if (typeof convert !== "function") return {}
	try {
		return convert.call(schema) as JsonSchema
	} catch {
		/* ArkType throws for a node JSON Schema cannot say, such as a morph */
		return {}
	}
}
