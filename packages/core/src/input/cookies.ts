/** The cookies as `.input({ cookies })` declares them. */
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { runSchema } from "../validation/validate-input.ts"

/**
 * The cookies (ctx.cookies: the first of a repeated name, as RFC 6265 sends the most specific one
 * first) validated by `schema`. Without a schema (a `readableStream()` entry) they pass as they are.
 */
export function cookiesInput(schema: StandardSchemaLike | null, cookies: Record<string, string>): unknown {
	return schema === null ? cookies : runSchema(schema, cookies, "cookies")
}
