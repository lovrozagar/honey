/**
 * A schema of any validator → JSON Schema. Zod runs its own converter with a wire override;
 * a vendor that publishes Standard JSON Schema is read through it; valibot, yup and older
 * ArkType are walked; Effect converts through the function its caller passes. Core never
 * imports a validator (F2), and never writes to the console: what cannot be converted is
 * answered as `{}` and told to `report`.
 */
import { arktypeJsonSchema } from "./arktype.ts"
import { effectJsonSchema } from "./effect.ts"
import { valibotJsonSchema } from "./valibot.ts"
import { yupJsonSchema } from "./yup.ts"
import { zodJsonSchema } from "./zod.ts"

export type JsonSchema = Record<string, unknown>

/** Which side of a schema to describe: what it accepts, or what it hands back. */
export type SchemaIo = "input" | "output"

/** Effect's `JSONSchema.make`, or any function of that shape. */
export type EffectConverter = (schema: never) => unknown

/** Why a schema came out wholly or partly unconstrained. */
export type ConversionIssue =
	| { readonly io: SchemaIo; readonly kind: "degraded"; readonly nodes: readonly string[]; readonly vendor: string }
	| { readonly io: SchemaIo; readonly kind: "unsupported"; readonly vendor: string }
	| { readonly error: unknown; readonly io: SchemaIo; readonly kind: "failed"; readonly vendor: string }

export type JsonSchemaOptions = {
	/** Converters core cannot import itself. */
	readonly converters?: { readonly effect?: EffectConverter }
	/** Hears each schema that came out unconstrained, once. */
	readonly report?: (issue: ConversionIssue) => void
}

type Standard = {
	readonly jsonSchema?: Partial<Record<SchemaIo, unknown>>
	readonly vendor: string
}

/* keywords whose value is a schema, or a list of schemas */
const SCHEMA_VALUE: readonly string[] = [
	"allOf",
	"anyOf",
	"additionalProperties",
	"contains",
	"else",
	"if",
	"items",
	"not",
	"oneOf",
	"prefixItems",
	"propertyNames",
	"then",
	"unevaluatedItems",
	"unevaluatedProperties",
]
/* keywords whose value maps names to schemas */
const SCHEMA_MAP: readonly string[] = ["$defs", "definitions", "dependentSchemas", "patternProperties", "properties"]

function isRecord(value: unknown): value is JsonSchema {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function cleanValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(cleanValue)
	return isRecord(value) ? withoutDialect(value) : value
}

/** `schema` without `$schema` wherever a schema sits; a payload such as `example` kept as it is. */
function withoutDialect(schema: JsonSchema): JsonSchema {
	const out: JsonSchema = {}
	for (const [key, value] of Object.entries(schema)) {
		if (key === "$schema") continue
		if (SCHEMA_MAP.includes(key) && isRecord(value)) {
			out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, cleanValue(child)]))
		} else out[key] = SCHEMA_VALUE.includes(key) ? cleanValue(value) : value
	}
	return out
}

function converted(
	schema: unknown,
	io: SchemaIo,
	options: JsonSchemaOptions,
	report: (issue: ConversionIssue) => void,
): unknown {
	const standard = (schema as { "~standard": Standard })["~standard"]
	const { vendor } = standard
	if (vendor === "zod") return zodJsonSchema(schema, io, (nodes) => report({ io, kind: "degraded", nodes, vendor }))
	const fromStandard = standard.jsonSchema?.[io]
	if (typeof fromStandard === "function") return fromStandard({ target: "draft-2020-12" })
	if (vendor === "valibot") return valibotJsonSchema(schema)
	if (vendor === "arktype") return arktypeJsonSchema(schema)
	if (vendor === "yup") return yupJsonSchema(schema)
	if (vendor === "effect") return effectJsonSchema(schema, options.converters?.effect)
	return null
}

/**
 * The JSON Schema of `schema` on the `io` side. A JSON Schema is handed back as given; anything
 * that is neither a schema nor an object is `{}`.
 */
export function jsonSchemaOf(schema: unknown, io: SchemaIo, options: JsonSchemaOptions = {}): JsonSchema {
	if (schema === null || (typeof schema !== "object" && typeof schema !== "function")) return {}
	const standard = (schema as { "~standard"?: Standard })["~standard"]
	if (standard === undefined) return isRecord(schema) ? schema : {}
	const report = options.report ?? (() => {})
	const { vendor } = standard
	try {
		const json = converted(schema, io, options, report)
		if (isRecord(json)) return withoutDialect(json)
		report({ io, kind: "unsupported", vendor })
	} catch (error) {
		report({ error, io, kind: "failed", vendor })
	}
	return {}
}
