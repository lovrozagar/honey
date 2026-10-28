/**
 * What `KnownStatusKeys` refuses in the types, refused where an app is documented or its tree generated: an output
 * declaration whose outer key is no media type (`type/subtype`), `headers` or `redirect`, or whose inner key names no
 * status. Every document keys an answer by its status's code, so such a key would be documented under none. It sits
 * on the generation paths only (collectRoutes, and the tree `honey generate` writes), never on the request path: an
 * app that serves no document bundles none of it, and the types refuse the key where it is written.
 */
import { statusKeyToCode } from "../response/status.ts"
import type { OutputSchemas } from "../routing/output-types.ts"
import type { RouteTree } from "../routing/tree.ts"

/** Throws, naming route `id` and the key, when `output` holds a key that is no media type or no status. */
export function assertOutputKeys(output: OutputSchemas, id: string): void {
	for (const [outer, statuses] of Object.entries(output)) {
		if (!/\/|^headers$|^redirect$/.test(outer))
			throw new Error(`${id}: .output() key "${outer}" is no type/subtype, headers or redirect`)
		for (const key of Object.keys(statuses ?? {}))
			if (!Object.hasOwn(statusKeyToCode, key))
				throw new Error(
					`${id}: .output() key "${key}" under ${outer} is none of ${Object.keys(statusKeyToCode).join(", ")}`,
				)
	}
}

/** Throws as `assertOutputKeys` does for the first route of `tree` whose output holds such a key. */
export function assertTreeOutputKeys(tree: RouteTree): void {
	for (const [id, { out }] of Object.entries(tree.routes)) if (out) assertOutputKeys(out, id)
}
