/**
 * Each route's schemas as JSON Schema: its input sources on the input side, its answers on the
 * output side by media type and status. What generated code and the manifest read of a route's shapes.
 */
import type { InputEntry } from "../input/input.ts"
import type { GRAPH } from "../routing/app.ts"
import type { StatusSchemas } from "../routing/output-types.ts"
import type { HoneyGraph } from "../routing/register.ts"
import { type JsonSchema, type JsonSchemaOptions, jsonSchemaOf } from "../schema/to-json-schema.ts"
import { collectRoutes } from "./collect.ts"

export type RouteSchemas = {
	readonly input?: Readonly<Record<string, JsonSchema>>
	readonly output?: Readonly<Record<string, Readonly<Record<string, JsonSchema>>>>
}

/** The keys of `.output()` that are no media type. */
const NOT_MEDIA: readonly string[] = ["headers", "redirect"]

/** The schema an input entry documents: a `readableStream()` wrapper by the schema it wraps. */
function schemaOf(entry: InputEntry): unknown {
	return "_tag" in entry ? entry.schema : entry
}

/** Every route's schemas, keyed `METHOD /pattern`; a route that declares none has `{}`. */
export function extractSchemas(
	app: { readonly [GRAPH]: HoneyGraph },
	options: JsonSchemaOptions = {},
): Record<string, RouteSchemas> {
	const out: Record<string, RouteSchemas> = {}
	for (const route of collectRoutes(app).http) {
		const schemas: { input?: Record<string, JsonSchema>; output?: Record<string, Record<string, JsonSchema>> } = {}
		if (route.input !== null) {
			const sources = Object.entries(route.input).filter(([source]) => source !== "binary")
			schemas.input = Object.fromEntries(
				sources.map(([source, entry]) => [source, jsonSchemaOf(schemaOf(entry as InputEntry), "input", options)]),
			)
		}
		if (route.output !== null) {
			const media = Object.entries(route.output).filter(([key]) => !NOT_MEDIA.includes(key))
			schemas.output = Object.fromEntries(
				media.map(([type, statuses]) => [
					type,
					Object.fromEntries(
						Object.entries(statuses as StatusSchemas).map(([status, schema]) => [
							status,
							jsonSchemaOf(schema, "output", options),
						]),
					),
				]),
			)
		}
		out[`${route.method} ${route.pattern}`] = schemas
	}
	return out
}
