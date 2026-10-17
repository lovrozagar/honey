/**
 * C# records (Fb5, §4.5): a nominal `public sealed record` of `{ get; init; }` properties in code-unit order of the
 * JSON key, each under its `[JsonPropertyName]`, with no initializer (R1). A required field is `required`, written
 * even when null; an optional one is `T?`, skipped when null; an optional nullable one is `Opt<T?>`, so absent, null
 * and a value stay three states; an open value is a bare `JsonElement`, already tri-state. A property spelling a
 * member every record has, or the record's own name (CS0542), moves on to `…2`. An allOf is one record of its
 * parts' fields, a key once, its first part's (Python's merge).
 */
import type { IRField, IRSchema } from "../../ir/model.ts"
import { csString } from "../shared/escape.ts"
import { compareCodeUnits, csTypeName, NameScope } from "../shared/lang.ts"
import type { CsTypeContext, Member } from "./types.ts"

/* every member a record has, synthesized or inherited, and the name its attributes spell in an expression */
export const RECORD_MEMBERS: readonly string[] = [
	"Deconstruct",
	"EqualityContract",
	"Equals",
	"Finalize",
	"GetHashCode",
	"GetType",
	"JsonIgnoreCondition",
	"MemberwiseClone",
	"PrintMembers",
	"ToString",
]

/* a required nullable member is written even when null; an unset tri-state or open value is not written */
const NEVER = "[JsonIgnore(Condition = JsonIgnoreCondition.Never)]"
const UNSET = "[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]"

/** One property's lines, unindented: its attributes, then `public <type> <name> { get; init; }`. */
function propertyLines(field: IRField, name: string, member: Member, at: CsTypeContext): string[] {
	const type = member(field.schema, field.name)
	const key = `[JsonPropertyName(${csString(field.name)})]`
	if (field.required)
		return [key, ...(type.endsWith("?") ? [NEVER] : []), `public required ${type} ${name} { get; init; }`]
	if (type === "JsonElement") return [key, UNSET, `public ${type} ${name} { get; init; }`]
	if (!type.endsWith("?")) return [key, `public ${type}? ${name} { get; init; }`]
	/* OptConverter reads T through the context: it must list T */
	at.serialized.add(type)
	return [key, `[JsonConverter(typeof(OptConverter<${type}>))]`, UNSET, `public Opt<${type}> ${name} { get; init; }`]
}

/** `public sealed record <name>` of `fields` in key order, a blank line between properties. */
export function recordDecl(name: string, fields: readonly IRField[], member: Member, at: CsTypeContext): string {
	const scope = new NameScope([...RECORD_MEMBERS, name])
	const properties = [...fields]
		.sort((a, b) => compareCodeUnits(a.name, b.name))
		.map((field) => propertyLines(field, scope.claim(csTypeName(field.name)), member, at))
	return [
		`public sealed record ${name}`,
		"{",
		...properties.flatMap((lines, i) => [...(i > 0 ? [""] : []), ...lines.map((line) => `    ${line}`)]),
		"}",
	].join("\n")
}

/** A schema's fields: an object's own, an allOf's merged (each ref followed, a key once, its first part's), else none. */
export function fieldsOf(schema: IRSchema, resolve: (schema: IRSchema) => IRSchema): IRField[] {
	if (schema.kind === "object") return schema.fields
	if (schema.kind !== "allOf") return []
	const fields = schema.parts.flatMap((part) => fieldsOf(resolve(part), resolve))
	return fields.filter((field, i) => fields.findIndex((first) => first.name === field.name) === i)
}
