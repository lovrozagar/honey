/** The route's path params as `.input({ params })` declares them: a schema per param that needs one. */
import { EK, HoneyError } from "../errors/error.ts"
import type { StandardSchemaLike, StandardSchemaResult } from "../validation/standard-schema.ts"
import { issuesToFieldErrors, type NormalizedIssue, normalizeIssues } from "../validation/validate-input.ts"

/** Schemas for the path params that need one, by name; every other param is the string the path carried. */
export type ParamSchemas = {
	/** The schema for the path param of this name; its output is what `ctx.params` holds for it. */
	readonly [name: string]: StandardSchemaLike
}

/**
 * The params `schemas` declares, compiled once: each param a schema names validated by it, the rest as they came;
 * a promise only for an async validator. Every param refused is one 400 whose fields name `params.<name>`.
 */
export function paramsStep(schemas: ParamSchemas): (params: Record<string, string>) => unknown {
	const entries = Object.entries(schemas)
	return (params) => {
		const results = entries.map(([name, schema]) => schema["~standard"].validate(params[name]))
		return results.some((result) => result instanceof Promise)
			? Promise.all(results).then((settled) => merged(entries, settled, params))
			: merged(entries, results as StandardSchemaResult[], params)
	}
}

/** `params` with each validated value in place, or the 400 naming every refused param. */
function merged(
	entries: ReadonlyArray<[string, StandardSchemaLike]>,
	results: readonly StandardSchemaResult[],
	params: Record<string, string>,
): Record<string, unknown> {
	const out: Record<string, unknown> = { ...params }
	const issues: NormalizedIssue[] = []
	for (const [i, [name, schema]] of entries.entries()) {
		const result = results[i] as StandardSchemaResult
		if (result.issues === undefined) out[name] = result.value
		else
			for (const issue of normalizeIssues(result.issues, schema["~standard"].vendor))
				issues.push({ ...issue, meta: { field: name }, path: [name, ...issue.path] })
	}
	if (issues.length === 0) return out
	throw new HoneyError({
		errorKey: EK.validation_failed,
		fields: issuesToFieldErrors(issues, "params"),
		status: "bad_request",
	})
}
