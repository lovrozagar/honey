/**
 * What `KnownStatusKeys` refuses in the types, refused at runtime: an `.output()` declaration, or a route tree's, whose
 * outer key is no media type (`type/subtype`), `headers` or `redirect`, or whose inner key names no status. The
 * generators key every answer by its status's code, so such a key would be documented under none.
 */
import { statusKeyToCode } from "../response/status.ts"
import type { OutputSchemas } from "./output-types.ts"

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
