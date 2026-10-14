/** The route's params as `.input({ params })` declares them. */
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { runSchema } from "../validation/validate-input.ts"

/**
 * `params` validated by `schema`: what the schema produced, a promise of it only for an async
 * validator. Without a schema (a `readableStream()` entry) the params pass as they are.
 */
export function paramsInput(schema: StandardSchemaLike | null, params: Record<string, string>): unknown {
	return schema === null ? params : runSchema(schema, params, "params")
}
