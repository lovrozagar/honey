/**
 * Java records (bit 16 phase b, B2): a `public record` of components in code-unit order of the JSON key, each under
 * `@JsonProperty("<wire>")`. A required field is its type, primitive for an integer, number or boolean that is not
 * nullable; an optional one is `@JsonInclude(NON_NULL) T`; an optional and nullable one is `@JsonInclude(NON_EMPTY)
 * Opt<T>`, three states; an open value is JsonNode, already tri-state beside NON_NULL. A component named like an Object
 * or Record member, a keyword or a literal claims `…2`. An allOf is one record of its parts' fields, a key once, its
 * first part's. An object that declares `additionalProperties` beside its fields keeps every other member in
 * `@JsonAnySetter @JsonAnyGetter Map<String, JsonNode>`, claimed after the fields. A header that fits 100 columns stays
 * on one line; otherwise it breaks after `(`, then one line of components, then one per line (google-java-format).
 */
import type { IRField, IRSchema } from "../../ir/model.ts"
import { javaString } from "../shared/escape.ts"
import { camelWords, compareCodeUnits, isJavaReserved, NameScope } from "../shared/lang.ts"
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

/* google-java-format's line limit */
const WIDTH = 100
const NON_NULL = "@JsonInclude(JsonInclude.Include.NON_NULL)"
const NON_EMPTY = "@JsonInclude(JsonInclude.Include.NON_EMPTY)"
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

/** One component: its annotations, then its type and name. */
type Component = { readonly annotations: string; readonly declaration: string }

/** One component's text on a single line: its annotations, then its type and name. */
const inline = ({ annotations, declaration }: Component): string => `${annotations} ${declaration}`

/** One component: `@JsonProperty` with its inclusion rule, then its type as the field's shape decides. */
function component(field: IRField, name: string, member: Member, at: JavaTypeContext): Component {
	const type = member(field.schema, field.name)
	const key = `@JsonProperty(${javaString(field.name)})`
	const nullable = at.names.resolve(field.schema).kind === "nullable"
	if (field.required) {
		return {
			annotations: key,
			declaration: `${PRIMITIVE[type] !== undefined && !nullable ? PRIMITIVE[type] : type} ${name}`,
		}
	}
	if (type === JSON_NODE) return { annotations: `${key} ${NON_NULL}`, declaration: `${type} ${name}` }
	if (nullable) return { annotations: `${key} ${NON_EMPTY}`, declaration: `Opt<${type}> ${name}` }
	return { annotations: `${key} ${NON_NULL}`, declaration: `${type} ${name}` }
}

/**
 * One component on its own line, its last line closing the header. A line over 100 columns breaks after its annotations,
 * the type and name at +8, as google-java-format does.
 */
function perLine(part: Component, last: boolean): string[] {
	const tail = last ? ") {}" : ","
	const line = `    ${inline(part)}${tail}`
	if (line.length <= WIDTH) return [line]
	return [`    ${part.annotations}`, `        ${part.declaration}${tail}`]
}

/** `public record <name>` of its components: one line when it fits, else broken after `(` as google-java-format does. */
function recordText(name: string, components: readonly Component[]): string {
	const head = `public record ${name}(`
	const joined = components.map(inline).join(", ")
	const one = `${head}${joined}) {}`
	if (components.length === 0 || one.length <= WIDTH) return one
	const block = `    ${joined}) {}`
	if (block.length <= WIDTH) return `${head}\n${block}`
	return [head, ...components.flatMap((c, i) => perLine(c, i === components.length - 1))].join("\n")
}

/** `public record <name>` of its fields in key order, then any map of the other members. */
export function recordDecl(name: string, { fields, open }: RecordShape, member: Member, at: JavaTypeContext): string {
	const scope = new NameScope(RECORD_MEMBERS)
	const components = [...fields]
		.sort((a, b) => compareCodeUnits(a.name, b.name))
		.map((field) => component(field, claimField(scope, field.name), member, at))
	if (open) {
		components.push({
			annotations: "@JsonAnySetter @JsonAnyGetter",
			declaration: `Map<String, ${JSON_NODE}> ${scope.claim("extra")}`,
		})
	}
	return recordText(name, components)
}
