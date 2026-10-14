/** The request headers as `.input({ headers })` declares them. */
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { runSchema } from "../validation/validate-input.ts"

/**
 * The request headers (ctx.headers: lowercased names, repeated values joined as Fetch joins them)
 * validated by `schema`. Without a schema (a `readableStream()` entry) they pass as they are.
 */
export function headersInput(schema: StandardSchemaLike | null, headers: Record<string, string>): unknown {
	return schema === null ? headers : runSchema(schema, headers, "headers")
}
