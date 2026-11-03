/** The cookies as `.input({ cookies })` declares them. */
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { runSchema } from "../validation/validate-input.ts"

/**
 * The cookies (ctx.cookies: the first of a repeated name, as RFC 6265 sends the most specific one
 * first) validated by `schema`.
 */
export function cookiesInput(schema: StandardSchemaLike, cookies: Record<string, string>): unknown {
	return runSchema(schema, cookies, "cookies")
}
