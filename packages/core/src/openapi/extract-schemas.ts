/**
 * Each route's schemas as JSON Schema: its input sources on the input side, its answers on the
 * output side by media type and status. What generated code and the manifest read of a route's shapes.
 */
import type { InputEntry } from "../input/input.ts"
import type { ParamSchemas } from "../input/params.ts"
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

/** The JSON Schema of one input source, each schema through `convert`: the params as the object of those declared. */
export function inputSourceSchema(
	source: string,
	entry: unknown,
	convert: (schema: unknown) => JsonSchema,
): JsonSchema {
	if (source !== "params") return convert(schemaOf(entry as InputEntry))
	const params = Object.entries(entry as ParamSchemas)
	/* in the order a vendor's object schema comes out in, so the shape reads the same as one written whole */
	return {
		type: "object",
		properties: Object.fromEntries(params.map(([name, schema]) => [name, convert(schema)])),
		required: params.map(([name]) => name),
	}
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
				sources.map(([source, entry]) => [
					source,
					inputSourceSchema(source, entry, (schema) => jsonSchemaOf(schema, "input", options)),
				]),
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
