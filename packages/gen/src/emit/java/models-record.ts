/**
 * Java records (bit 16 phase b, B2): a `public record` of components in code-unit order of the JSON key, each under
 * `@JsonProperty("<wire>")`. A required field is its type, primitive for an integer, number or boolean that is not
 * nullable; an optional one is `@JsonInclude(NON_NULL) T`; an optional and nullable one is `@JsonInclude(NON_EMPTY)
 * Opt<T>`, three states; an open value is JsonNode, already tri-state beside NON_NULL. A component named like an Object
 * or Record member, a keyword or a literal claims `…2`. An allOf is one record of its parts' fields, a key once, its
 * first part's. An object that declares `additionalProperties` beside its fields keeps every other member in
 * `@JsonAnySetter @JsonAnyGetter Map<String, JsonNode>`, claimed after the fields. The header is laid out as
 * google-java-format lays a record's (layout.ts).
 */
import type { IRField, IRSchema } from "../../ir/model.ts"
import { javaString } from "../shared/escape.ts"
import { camelWords, compareCodeUnits, isJavaReserved, NameScope } from "../shared/lang.ts"
import { type Annotation, type Component, typeHeader } from "./layout.ts"
import { JSON_NODE } from "./models-names.ts"
import type { JavaTypeContext, Member } from "./models.ts"

/* every member name a record component collides with: java.lang.Record's and Object's synthesized and final methods */
export const RECORD_MEMBERS: readonly string[] = [
	"clone",
	"equals",
	"finalize",
	"getClass",
	"hashCode",
	"notify",
	"notifyAll",
	"toString",
	"wait",
]

const NON_NULL: Annotation = { args: ["JsonInclude.Include.NON_NULL"], name: "JsonInclude" }
const NON_EMPTY: Annotation = { args: ["JsonInclude.Include.NON_EMPTY"], name: "JsonInclude" }
/* a required, non-nullable use of these is written primitive */
const PRIMITIVE: Readonly<Record<string, string | undefined>> = { Boolean: "boolean", Double: "double", Long: "long" }

/** A record's members: its fields, and whether it keeps every other member (it declares `additionalProperties`). */
export type RecordShape = { readonly fields: readonly IRField[]; readonly open: boolean }

/** Whether an object, or any object part of an allOf (refs followed), declares `additionalProperties`. */
export function isOpen(schema: IRSchema, resolve: (schema: IRSchema) => IRSchema): boolean {
	if (schema.kind === "object") return schema.additional !== undefined && schema.additional !== false
	return schema.kind === "allOf" && schema.parts.some((part) => isOpen(resolve(part), resolve))
}

/** A schema's fields: an object's own, an allOf's merged (each ref followed, a key once, its first part's), else none. */
export function fieldsOf(schema: IRSchema, resolve: (schema: IRSchema) => IRSchema): IRField[] {
	if (schema.kind === "object") return schema.fields
	if (schema.kind !== "allOf") return []
	const fields = schema.parts.flatMap((part) => fieldsOf(resolve(part), resolve))
	return fields.filter((field, i) => fields.findIndex((first) => first.name === field.name) === i)
}

/** A component's base name: camelCase, a digit first `_`, nothing `value`. */
function fieldBase(key: string): string {
	const word = camelWords(key)
	if (word === "") return "value"
	return /^[0-9]/.test(word) ? `_${word}` : word
}

/** A component name claimed in `scope`: a keyword or literal is taken before the claim, so it gets `…2`. */
function claimField(scope: NameScope, key: string): string {
	const base = fieldBase(key)
	if (isJavaReserved(base)) scope.reserve(base)
	return scope.claim(base)
}

/** One component: `@JsonProperty` with its inclusion rule, then its type as the field's shape decides. */
function component(field: IRField, name: string, member: Member, at: JavaTypeContext): Component {
	const type = member(field.schema, field.name)
	const key: Annotation = { args: [javaString(field.name)], name: "JsonProperty" }
	const nullable = at.names.resolve(field.schema).kind === "nullable"
	if (field.required) {
		const declared = PRIMITIVE[type] !== undefined && !nullable ? PRIMITIVE[type] : type
		return { annotations: [key], name, type: declared }
	}
	if (type === JSON_NODE) return { annotations: [key, NON_NULL], name, type }
	if (nullable) return { annotations: [key, NON_EMPTY], name, type: `Opt<${type}>` }
	return { annotations: [key, NON_NULL], name, type }
}

/** `public record <name>` of its fields in key order, then any map of the other members. */
export function recordDecl(name: string, { fields, open }: RecordShape, member: Member, at: JavaTypeContext): string {
	const scope = new NameScope(RECORD_MEMBERS)
	const components = [...fields]
		.sort((a, b) => compareCodeUnits(a.name, b.name))
		.map((field) => component(field, claimField(scope, field.name), member, at))
	if (open) {
		components.push({
			annotations: [{ name: "JsonAnySetter" }, { name: "JsonAnyGetter" }],
			name: scope.claim("extra"),
			type: `Map<String, ${JSON_NODE}>`,
		})
	}
	return typeHeader(0, { components, end: "{}", kind: "record", modifiers: ["public"], name }).join("\n")
}
