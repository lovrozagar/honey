/** The query as `.input({ search })` declares it. */
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { runSchema, type Shape, shapedRecord, shapeOf } from "../validation/validate-input.ts"

/** ctx.searchAll as key/value pairs, in request order per key. */
function* pairs(searchAll: Readonly<Record<string, readonly string[]>>): Generator<[string, string]> {
	for (const key in searchAll) for (const value of searchAll[key] as readonly string[]) yield [key, value]
}

/**
 * The query (ctx.searchAll, parsed once per request) validated by `schema`. Repeated keys follow
 * `shape` (the schema's, computed once per route), and `__proto__`, `constructor` and `prototype`
 * never reach it (H18.13). Without a schema (a `readableStream()` entry) the query passes
 * unvalidated.
 */
export function searchInput(
	schema: StandardSchemaLike | null,
	searchAll: Readonly<Record<string, readonly string[]>>,
	shape: Shape | null = schema === null ? null : shapeOf(schema),
): unknown {
	const record = shapedRecord(pairs(searchAll), shape)
	return schema === null ? record : runSchema(schema, record, "search")
}
