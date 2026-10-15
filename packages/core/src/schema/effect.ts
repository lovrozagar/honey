/**
 * Effect → JSON Schema through the converter the caller passes (`JSONSchema.make`): core never
 * imports effect (F2), so without one there is nothing to convert with.
 */
import type { EffectConverter, JsonSchema } from "./to-json-schema.ts"

/** The JSON Schema `convert` gives for `schema`, its `$defs` kept for the slots to hoist; null without a converter. */
export function effectJsonSchema(schema: unknown, convert: EffectConverter | undefined): JsonSchema | null {
	return convert === undefined ? null : (convert(schema as never) as JsonSchema)
}
