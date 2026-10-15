/**
 * Valibot → JSON Schema, by walking the schema object valibot hands over: its `type`, `entries`,
 * `wrapped`, `options` and `pipe`. valibot publishes no JSON Schema of its own, and core never
 * imports a validator (F2), so the walk reads only what the schema carries.
 */
import { dict } from "../routing/tree.ts"

type JsonSchema = Record<string, unknown>

/** A valibot schema node as the walk reads it. */
type Node = { readonly type: string; readonly [key: string]: unknown }

/* past this depth a node is unconstrained: a recursive lazy schema would not end */
const MAX_DEPTH = 32

/** The node types an object key may be left out under. */
const OPTIONAL: readonly string[] = ["exact_optional", "nullish", "optional", "undefinedable"]

/** Pipe actions that name a JSON Schema format. */
const FORMATS: Readonly<Record<string, string>> = {
	email: "email",
	ipv4: "ipv4",
	ipv6: "ipv6",
	iso_date: "date",
	iso_date_time: "date-time",
	iso_timestamp: "date-time",
	url: "uri",
	uuid: "uuid",
}

/** `json` with the constraints of `node`'s pipe that JSON Schema can say. */
function piped(node: Node, json: JsonSchema): JsonSchema {
	const pipe = node.pipe
	if (!Array.isArray(pipe)) return json
	const array = json.type === "array"
	for (const action of pipe.slice(1) as Node[]) {
		const requirement = action.requirement
		const format = FORMATS[action.type]
		if (format !== undefined) json.format = format
		else if (action.type === "integer") json.type = "integer"
		else if (action.type === "regex") json.pattern = (requirement as RegExp).source
		else if (action.type === "description") json.description = action.description
		else if (typeof requirement === "number") bound(json, action.type, requirement, array)
	}
	return json
}

/** A length or value bound onto `json`. */
function bound(json: JsonSchema, action: string, value: number, array: boolean): void {
	const [min, max] = array ? ["minItems", "maxItems"] : ["minLength", "maxLength"]
	if (action === "min_length" || action === "length") json[min] = value
	if (action === "max_length" || action === "length") json[max] = value
	if (action === "min_value") json.minimum = value
	if (action === "max_value") json.maximum = value
}

type Walk = (child: unknown) => JsonSchema

function object(node: Node, walk: Walk): JsonSchema {
	const entries = node.entries as Readonly<Record<string, Node>>
	const keys = Object.keys(entries)
	if (keys.length === 0 && node.type === "object") return { type: "object" }
	const properties = dict<JsonSchema>()
	const required: string[] = []
	for (const key of keys) {
		const entry = entries[key] as Node
		properties[key] = walk(entry)
		if (!OPTIONAL.includes(entry.type)) required.push(key)
	}
	const json: JsonSchema = { properties, type: "object" }
	if (required.length > 0) json.required = required
	if (node.type === "strict_object") json.additionalProperties = false
	if (node.type === "object_with_rest") json.additionalProperties = walk(node.rest)
	return json
}

function tuple(node: Node, walk: Walk): JsonSchema {
	const entries = node.items as readonly Node[]
	const items = entries.map(walk)
	/* an optional tail may be left out; an optional element before a required one may not */
	const required = entries.reduce((count, entry, at) => (OPTIONAL.includes(entry.type) ? count : at + 1), 0)
	const json: JsonSchema = { minItems: required, prefixItems: items, type: "array" }
	if (node.type === "tuple_with_rest") json.items = walk(node.rest)
	else if (node.type !== "loose_tuple") {
		json.items = false
		json.maxItems = items.length
	}
	return json
}

/** Enum values: a TS numeric enum's reverse mappings left out. */
function enumValues(node: Node): JsonSchema {
	const values = node.enum as Readonly<Record<string, string | number>>
	return {
		enum: Object.keys(values)
			.filter((key) => typeof values[values[key] as string] !== "number")
			.map((key) => values[key]),
	}
}

/** The wrapped schema, its default kept when it is a value. */
function unwrapped(node: Node, walk: Walk): JsonSchema {
	const inner = walk(node.wrapped)
	return node.default === undefined || typeof node.default === "function" ? inner : { ...inner, default: node.default }
}

type Handler = (node: Node, walk: Walk) => JsonSchema

const nullable: Handler = (node, walk) => ({ anyOf: [walk(node.wrapped), { type: "null" }] })
const union: Handler = (node, walk) => ({ anyOf: (node.options as readonly unknown[]).map(walk) })
const binary: Handler = () => ({ contentEncoding: "binary", format: "binary", type: "string" })

/** Each node type's JSON Schema; a type not listed (any, unknown, undefined, void…) is unconstrained. */
const BY_TYPE: Readonly<Record<string, Handler>> = {
	array: (node, walk) => piped(node, { items: walk(node.item), type: "array" }),
	bigint: () => ({ format: "int64", type: "integer" }),
	blob: binary,
	boolean: () => ({ type: "boolean" }),
	date: () => ({ format: "date-time", type: "string" }),
	enum: enumValues,
	exact_optional: unwrapped,
	file: binary,
	intersect: (node, walk) => ({ allOf: (node.options as readonly unknown[]).map(walk) }),
	lazy: (node, walk) => walk((node.getter as (input: unknown) => unknown)(undefined)),
	literal: (node) => ({ const: node.literal }),
	loose_object: object,
	loose_tuple: tuple,
	non_nullable: unwrapped,
	non_nullish: unwrapped,
	non_optional: unwrapped,
	null: () => ({ type: "null" }),
	nullable,
	nullish: nullable,
	number: (node) => piped(node, { type: "number" }),
	object,
	object_with_rest: object,
	optional: unwrapped,
	picklist: (node) => ({ enum: node.options }),
	record: (node, walk) => ({ additionalProperties: walk(node.value), type: "object" }),
	strict_object: object,
	strict_tuple: tuple,
	string: (node) => piped(node, { type: "string" }),
	tuple,
	tuple_with_rest: tuple,
	undefinedable: unwrapped,
	union,
	variant: union,
}

/** The JSON Schema of the valibot schema `schema`; past the depth bound, or for an unknown node, unconstrained. */
export function valibotJsonSchema(schema: unknown, depth = 0): JsonSchema {
	if (depth > MAX_DEPTH || schema === null || typeof schema !== "object") return {}
	const node = schema as Node
	if (!Object.hasOwn(BY_TYPE, node.type)) return {}
	return (BY_TYPE[node.type] as Handler)(node, (child) => valibotJsonSchema(child, depth + 1))
}
