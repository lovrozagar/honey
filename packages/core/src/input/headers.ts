/** The request headers as `.input({ headers })` declares them. */
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { runSchema } from "../validation/validate-input.ts"

/**
 * The request headers (ctx.headers: lowercased names, repeated values joined as Fetch joins them)
 * validated by `schema`.
 */
export function headersInput(schema: StandardSchemaLike, headers: Record<string, string>): unknown {
	return runSchema(schema, headers, "headers")
}
