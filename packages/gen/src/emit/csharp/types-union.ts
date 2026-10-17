/**
 * C# unions (Fb7, Go's shape): a union of const strings alone is a string enum; a discriminated one is a sealed
 * record with one nullable property per ref or inline-object variant, in code-unit order of its first value, plus
 * `JsonElement Raw`, the payload as received. Its emitted converter reads the discriminator, decodes the variant it
 * selects through the context (AOT-safe), keeps any other payload whole in `Raw`, and writes the set variant or
 * `Raw` verbatim. Every variant type is noted for the context: one a converter alone reaches is never generated.
 */
import type { IRDiscriminator, IRSchema } from "../../ir/model.ts"
import { csString } from "../shared/escape.ts"
import { compareCodeUnits, csTypeName, NameScope } from "../shared/lang.ts"
import { enumValues, stringEnumDecl } from "./types-enum.ts"
import { fieldsOf, RECORD_MEMBERS } from "./types-record.ts"
import type { CsTypeContext, Member } from "./types.ts"

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>

/** Declares `schema` once under `names.hoist(key, base)`; its name. */
export type Declare = (schema: IRSchema, key: string, base: string) => string

/** What a union's declaration reaches: the context, its members' types, and the hoist. */
export type UnionScope = { at: CsTypeContext; member: Member; declare: Declare }

/** Whether a variant is a const string: a union of these alone is a string enum. */
export const isLiteral = (variant: IRSchema): variant is Of<"const"> & { value: string } =>
	variant.kind === "const" && typeof variant.value === "string"

/** The values that select `variant`: its mapping keys, else its property's const or enum, else its ref's name. */
function selectors(variant: IRSchema, { mapping = {}, propertyName }: IRDiscriminator, at: CsTypeContext): string[] {
	const mapped = Object.keys(mapping).filter((value) => variant.kind === "ref" && mapping[value] === variant.name)
	if (mapped.length > 0) return mapped
	const fields = fieldsOf(at.names.resolve(variant), at.names.resolve)
	const property = fields.find((field) => field.name === propertyName)?.schema
	if (property?.kind === "const") return [String(property.value)]
	if (property?.kind === "scalar") return enumValues(property).map(String)
	return variant.kind === "ref" ? [variant.name] : []
}

/** A variant property: its name, its type, and the values that select it (each value selects one variant). */
type Variant = { property: string; type: string; values: string[] }

/** One variant per ref or inline-object variant, named after its first value, in code-unit order of it. */
function variantsOf(name: string, union: Of<"union"> & { discriminator: IRDiscriminator }, scope: UnionScope) {
	const properties = new NameScope([...RECORD_MEMBERS, "Raw", name])
	const seen = new Set<string>()
	const variants = union.variants.flatMap((schema, i): Variant[] => {
		if (schema.kind !== "ref" && schema.kind !== "object") return []
		const values = selectors(schema, union.discriminator, scope.at).filter((value) => !seen.has(value))
		for (const value of values) seen.add(value)
		const first = values[0] ?? `Variant${i}`
		const type =
			schema.kind === "ref"
				? scope.member(schema, first)
				: scope.declare(schema, `${name}.variant${i}`, `${name}${csTypeName(first)}`)
		scope.at.serialized.add(type)
		return [{ property: csTypeName(first), type, values }]
	})
	return variants
		.sort((a, b) => compareCodeUnits(a.values[0] ?? "", b.values[0] ?? ""))
		.map((variant) => ({ ...variant, property: properties.claim(variant.property) }))
}

/** `JsonTypeInfo<T>` of `type` from the converter's options. */
const info = (type: string) => `(JsonTypeInfo<${type}>)options.GetTypeInfo(typeof(${type}))`

/** The converter's `Read`: the discriminator's string value selects a variant, the payload kept as `Raw`. */
const readLines = (name: string, property: string, variants: readonly Variant[]) => [
	`    public override ${name} Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)`,
	"    {",
	"        var raw = JsonElement.ParseValue(ref reader);",
	`        var kind = raw.ValueKind == JsonValueKind.Object && raw.TryGetProperty(${csString(property)}, out var at) && at.ValueKind == JsonValueKind.String ? at.GetString() : null;`,
	"        return kind switch",
	"        {",
	...variants.flatMap((v) =>
		v.values.map(
			(value) =>
				`            ${csString(value)} => new ${name} { ${v.property} = raw.Deserialize(${info(v.type)}), Raw = raw },`,
		),
	),
	`            _ => new ${name} { Raw = raw },`,
	"        };",
	"    }",
]

/** The converter's `Write`: the set variant through its own type, else `Raw` as received, else null. */
function writeLines(name: string, variants: readonly Variant[]): string[] {
	const arms = [
		...variants.map((v, i) => [
			`value.${v.property} is { } variant${i}`,
			`JsonSerializer.Serialize(writer, variant${i}, ${info(v.type)});`,
		]),
		["value.Raw.ValueKind != JsonValueKind.Undefined", "value.Raw.WriteTo(writer);"],
	]
	return [
		`    public override void Write(Utf8JsonWriter writer, ${name} value, JsonSerializerOptions options)`,
		"    {",
		...arms.flatMap(([test, write], i) => [
			`        ${i > 0 ? "else " : ""}if (${test})`,
			"        {",
			`            ${write}`,
			"        }",
		]),
		"        else",
		"        {",
		"            writer.WriteNullValue();",
		"        }",
		"    }",
	]
}

/** The record of `union`'s variants and `Raw`, then its converter. */
function discriminatedDecl(name: string, union: Of<"union"> & { discriminator: IRDiscriminator }, scope: UnionScope) {
	const variants = variantsOf(name, union, scope)
	const converter = scope.at.names.claim(`${name}Converter`)
	const members = [
		...variants.map((v) => [`    public ${v.type}? ${v.property} { get; init; }`]),
		[
			"    /// <summary>The payload as received; the only member set for a value no variant declares.</summary>",
			"    public JsonElement Raw { get; init; }",
		],
	]
	return [
		`[JsonConverter(typeof(${converter}))]`,
		`public sealed record ${name}`,
		"{",
		...members.flatMap((lines, i) => [...(i > 0 ? [""] : []), ...lines]),
		"}",
		"",
		`public sealed class ${converter} : JsonConverter<${name}>`,
		"{",
		...readLines(name, union.discriminator.propertyName, variants),
		"",
		...writeLines(name, variants),
		"}",
	].join("\n")
}

/** The declaration of a union `declares`: a string enum of its const strings, or a discriminated record. */
export function unionDecl(name: string, union: Of<"union">, scope: UnionScope): string {
	if (union.variants.every(isLiteral)) {
		return stringEnumDecl(
			name,
			[...new Set(union.variants.map((variant) => (variant as Of<"const">).value as string))],
			scope.at,
		)
	}
	return discriminatedDecl(name, union as Of<"union"> & { discriminator: IRDiscriminator }, scope)
}
