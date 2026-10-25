/**
 * Reading a JSON Schema into an IR schema, and following an IR schema's refs to the component
 * they name. The IR types themselves are in `model.ts`.
 */
import type { IRDiscriminator, IRField, IRScalarType, IRSchema } from "./model.ts"

type Json = Record<string, unknown>

const SCALARS: readonly unknown[] = ["boolean", "integer", "null", "number", "string"]

const lastSegment = (ref: string) => ref.split("/").pop() as string

/** Whether `schema` admits null: `nullable`, a null in its type list, or a null variant. */
function isNullable(schema: Json): boolean {
	if (schema.nullable === true) return true
	if (Array.isArray(schema.type) && schema.type.includes("null")) return true
	const variants = (schema.anyOf ?? schema.oneOf) as Json[] | undefined
	return variants?.some((variant) => variant.type === "null") === true
}

/** The schema `schema` makes nullable; never wrapped twice. */
function nullableOf(schema: Json): IRSchema {
	let inner: IRSchema
	/* only a type list that holds null is stripped; a flag beside any other list drops the flag below */
	if (Array.isArray(schema.type) && schema.type.includes("null")) {
		const rest = (schema.type as unknown[]).filter((type) => type !== "null")
		inner = schemaToIR({ ...schema, type: rest.length === 1 ? rest[0] : rest })
	} else if (schema.anyOf !== undefined || schema.oneOf !== undefined) {
		const rest = ((schema.anyOf ?? schema.oneOf) as Json[]).filter((variant) => variant.type !== "null")
		if (rest.length === 0) inner = { kind: "unknown" }
		else inner = rest.length === 1 ? schemaToIR(rest[0]) : { kind: "union", variants: rest.map(schemaToIR) }
	} else {
		const { nullable: _flag, ...rest } = schema
		inner = schemaToIR(rest)
	}
	return inner.kind === "nullable" ? inner : { inner, kind: "nullable" }
}

function unionOf(schema: Json): IRSchema {
	const variants = ((schema.oneOf ?? schema.anyOf) as Json[]).map(schemaToIR)
	const raw = schema.discriminator as { mapping?: Record<string, string>; propertyName: string } | undefined
	if (raw === undefined) return { kind: "union", variants }
	const discriminator: IRDiscriminator = { propertyName: raw.propertyName }
	const mapping = raw.mapping && Object.entries(raw.mapping).map(([value, ref]) => [value, lastSegment(ref)])
	if (mapping) discriminator.mapping = Object.fromEntries(mapping)
	return { discriminator, kind: "union", variants }
}

/**
 * A string or integer enum as a scalar; a mixed one as a union of consts; `null` when it is neither. A null is never
 * one of its values: it makes an untyped enum the nullable of its other values, a typed one is already nullable by its
 * type or admits no null at all, and a null alone is the null type.
 */
function enumOf(schema: Json): IRSchema | null {
	const given = schema.enum as (boolean | number | string | null)[]
	if (given.includes(null)) {
		const rest = given.filter((value) => value !== null)
		if (rest.length === 0) return { kind: "scalar", type: "null" }
		const inner = enumOf({ ...schema, enum: rest })
		return schema.type !== undefined || inner === null ? inner : { inner, kind: "nullable" }
	}
	const values = given as (boolean | number | string)[]
	if (values.length === 0) return null
	const all = (test: (value: unknown) => boolean) => schema.type === undefined && values.every(test)
	if (schema.type === "string" || all((value) => typeof value === "string"))
		return { enum: values, kind: "scalar", type: "string" }
	if (schema.type === "integer" || all(Number.isInteger)) return { enum: values, kind: "scalar", type: "integer" }
	return values.every(literal) ? { kind: "union", variants: values.map((value) => ({ kind: "const", value })) } : null
}

function objectOf(schema: Json): IRSchema {
	const properties = (schema.properties ?? {}) as Record<string, Json>
	const required = new Set((schema.required as string[] | undefined) ?? [])
	const fields = Object.entries(properties).map(([name, property]) => {
		const field: IRField = { name, required: required.has(name), schema: schemaToIR(property) }
		if (typeof property.description === "string") field.description = property.description
		return field
	})
	const ap = schema.additionalProperties
	if (ap === undefined) return { fields, kind: "object" }
	const additional = ap === false ? false : ap === true ? ({ kind: "unknown" } as const) : schemaToIR(ap as Json)
	return { additional, fields, kind: "object" }
}

type Reader = (schema: Json) => IRSchema | null

const isSchema = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value)

/**
 * A tuple, as 2020-12 (`prefixItems`, then `items` for the rest) or draft-07 (`items` as a list,
 * then `additionalItems`) writes it. Without a rest schema it is closed: zod leaves `items: false`
 * out of a closed tuple. `minItems` below the length makes an optional tail.
 */
function tupleOf(schema: Json): IRSchema | null {
	const modern = Array.isArray(schema.prefixItems)
	const fixed = (modern ? schema.prefixItems : schema.items) as Json[]
	if (!Array.isArray(fixed)) return null
	const tuple: Extract<IRSchema, { kind: "tuple" }> = { items: fixed.map(schemaToIR), kind: "tuple" }
	const rest = modern ? schema.items : schema.additionalItems
	if (isSchema(rest)) tuple.rest = schemaToIR(rest)
	if (typeof schema.minItems === "number" && schema.minItems < fixed.length) tuple.required = schema.minItems
	return tuple
}

const literal = (value: unknown): value is boolean | number | string =>
	typeof value === "string" || typeof value === "number" || typeof value === "boolean"

function constOf(schema: Json): IRSchema | null {
	const value = schema.const
	if (!literal(value)) return null
	const typed = SCALARS.includes(schema.type) && schema.type !== "null"
	return typed ? { kind: "const", type: schema.type as IRScalarType, value } : { kind: "const", value }
}

/* the constraint keywords a value carries (bit 19 c), each read when the spec states it with its JSON type */
const BOUNDS = ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const

function scalarOf(schema: Json): IRSchema | null {
	if (!SCALARS.includes(schema.type)) return null
	const scalar: Extract<IRSchema, { kind: "scalar" }> = { kind: "scalar", type: schema.type as IRScalarType }
	if (typeof schema.format === "string") scalar.format = schema.format
	if (Array.isArray(schema.enum)) scalar.enum = schema.enum as (boolean | number | string)[]
	for (const bound of BOUNDS) if (typeof schema[bound] === "number") scalar[bound] = schema[bound] as number
	if (typeof schema.pattern === "string") scalar.pattern = schema.pattern
	return scalar
}

function arrayOf(schema: Json): IRSchema {
	const array: Extract<IRSchema, { kind: "array" }> = {
		items: schemaToIR(schema.items as Json | undefined),
		kind: "array",
	}
	if (typeof schema.minItems === "number") array.minItems = schema.minItems
	if (typeof schema.maxItems === "number") array.maxItems = schema.maxItems
	return array
}

/* the order matters: a ref before anything it might also say, const before type, nullability before unions */
const READERS: readonly Reader[] = [
	(schema) => (typeof schema.$ref === "string" ? { kind: "ref", name: lastSegment(schema.$ref) } : null),
	(schema) => (Array.isArray(schema.allOf) ? { kind: "allOf", parts: (schema.allOf as Json[]).map(schemaToIR) } : null),
	constOf,
	(schema) => (isNullable(schema) ? nullableOf(schema) : null),
	(schema) =>
		Array.isArray(schema.type) && schema.type.length > 1
			? { kind: "union", variants: (schema.type as unknown[]).map((type) => schemaToIR({ ...schema, type })) }
			: null,
	(schema) => (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) ? unionOf(schema) : null),
	(schema) => (Array.isArray(schema.enum) ? enumOf(schema) : null),
	(schema) =>
		schema.format === "binary" && (schema.type === "string" || schema.type === undefined) ? { kind: "binary" } : null,
	tupleOf,
	(schema) => (schema.type === "array" ? arrayOf(schema) : null),
	(schema) =>
		schema.type === "object" || schema.properties !== undefined || schema.additionalProperties !== undefined
			? objectOf(schema)
			: null,
	scalarOf,
]

/** What a typed value of `schema` is in the IR, read in a fixed order; anything unreadable is `unknown`. */
export function schemaToIR(schema: Json | undefined): IRSchema {
	if (schema === undefined) return { kind: "unknown" }
	for (const read of READERS) {
		const ir = read(schema)
		if (ir !== null) return ir
	}
	return { kind: "unknown" }
}

/** Follows `ref` nodes to their component; an unknown or endless one is `unknown`. */
export function irResolver(schemas: Record<string, IRSchema>): (schema: IRSchema) => IRSchema {
	return (schema) => {
		let at = schema
		for (let hops = 0; at.kind === "ref"; hops++) {
			const next = Object.hasOwn(schemas, at.name) ? schemas[at.name] : undefined
			if (next === undefined || hops === 32) return { kind: "unknown" }
			at = next
		}
		return at
	}
}
