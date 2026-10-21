/**
 * C# records (Fb5, §4.5): a nominal `public sealed record` of `{ get; init; }` properties in code-unit order of the
 * JSON key, each under its `[JsonPropertyName]`, with no initializer (R1). A required field is `required`, written
 * even when null; an optional one is `T?`, skipped when null; an optional nullable one is `Opt<T?>`, so absent, null
 * and a value stay three states; an open value is a bare `JsonElement`, already tri-state. A property spelling a
 * member every record has, or the record's own name (CS0542), moves on to `…2`. An allOf is one record of its
 * parts' fields, a key once, its first part's (Python's merge). An object that declares `additionalProperties`
 * beside its fields keeps every other member in `[JsonExtensionData] Extra`, JsonElement-valued (honey-a8's ruling,
 * Rust's flattened map), claimed after the fields: `{ get; set; }`, since an init-only one goes through the
 * deserialization constructor, which extension data cannot bind to.
 */
import type { IRField, IRSchema } from "../../ir/model.ts"
import { csString } from "../shared/escape.ts"
import { compareCodeUnits, csTypeName, NameScope } from "../shared/lang.ts"
import type { CsTypeContext, Member } from "./types.ts"

/* every member name a record property collides with (CS0102, CS0108, CS8859, CS8874), and the name its attributes spell in an expression */
export const RECORD_MEMBERS: readonly string[] = [
	"Clone",
	"EqualityContract",
	"Equals",
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

/** A record's members: its fields, and whether it keeps every other member (it declares `additionalProperties`). */
export type RecordShape = { readonly fields: readonly IRField[]; readonly open: boolean }

/** `public sealed record <name>` of its fields in key order, a blank line between properties, then any extension data. */
export function recordDecl(name: string, { fields, open }: RecordShape, member: Member, at: CsTypeContext): string {
	const scope = new NameScope([...RECORD_MEMBERS, name])
	const properties = [...fields]
		.sort((a, b) => compareCodeUnits(a.name, b.name))
		.map((field) => propertyLines(field, scope.claim(csTypeName(field.name)), member, at))
	if (open) {
		properties.push([
			"[JsonExtensionData]",
			`public IDictionary<string, JsonElement>? ${scope.claim("Extra")} { get; set; }`,
		])
	}
	return [
		`public sealed record ${name}`,
		"{",
		...properties.flatMap((lines, i) => [...(i > 0 ? [""] : []), ...lines.map((line) => `    ${line}`)]),
		"}",
	].join("\n")
}

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
