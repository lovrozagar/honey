/**
 * C# enums for a string or integer `enum` (§1 rules, §4.5). A string enum has one member per value and a converter
 * of its own with one exact `switch` arm per value each way: the stock `JsonStringEnumConverter` refuses a whole
 * type holding `""`, reads `"dark,light"` and trims `" dark"`. An integer enum has an `L<n>`/`Neg<n>` member per
 * value through the runtime's `IntEnumConverter<T>`, which takes only a declared JSON integer. Spec text reaches
 * the source only through the escape layer.
 */
import type { IRSchema } from "../../ir/model.ts"
import { csString } from "../shared/escape.ts"
import { csTypeName, NameScope } from "../shared/lang.ts"
import type { CsTypeContext } from "./types.ts"

type Scalar = Extract<IRSchema, { kind: "scalar" }>

/** The values a string or integer enum declares, each once: a value of another kind has no member. */
export function enumValues(ir: Scalar): (number | string)[] {
	const values = ir.enum ?? []
	const kept =
		ir.type === "string"
			? values.filter((value) => typeof value === "string")
			: values.filter((value) => ir.type === "integer" && Number.isSafeInteger(value))
	return [...new Set(kept as (number | string)[])]
}

/** A string enum member's name, unique in `scope`: `""` is `Empty`, a repeat takes `…2`. */
const memberOf = (value: string, scope: NameScope) => scope.claim(value === "" ? "Empty" : csTypeName(value))

/** `public enum <name>` with one member per value, then its exact converter; `name` is noted as an enum. */
export function stringEnumDecl(name: string, values: readonly string[], at: CsTypeContext): string {
	at.enums.add(name)
	const scope = new NameScope()
	const members = values.map((value) => [csString(value), memberOf(value, scope)] as const)
	const converter = at.names.claim(`${name}Converter`)
	return [
		`[JsonConverter(typeof(${converter}))]`,
		`public enum ${name}`,
		"{",
		...members.map(([, member]) => `    ${member},`),
		"}",
		"",
		`public sealed class ${converter} : JsonConverter<${name}>`,
		"{",
		`    public override ${name} Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>`,
		"        reader.TokenType == JsonTokenType.String",
		"            ? reader.GetString() switch",
		"            {",
		...members.map(([value, member]) => `                ${value} => ${name}.${member},`),
		`                var other => throw new JsonException($"{other} is no ${name}"),`,
		"            }",
		`            : throw new JsonException("a ${name} is a string");`,
		"",
		`    public override void Write(Utf8JsonWriter writer, ${name} value, JsonSerializerOptions options) =>`,
		"        writer.WriteStringValue(value switch",
		"        {",
		...members.map(([value, member]) => `            ${name}.${member} => ${value},`),
		`            _ => throw new JsonException($"{(long)value} is no ${name}"),`,
		"        });",
		"}",
	].join("\n")
}

/** An integer value's member: `L<n>`, or `Neg<n>` below zero. */
const label = (value: number) => `${value < 0 ? "Neg" : "L"}${String(Math.abs(value))}`

/** `public enum <name>` with one `L<n>` member per value, read and written by `IntEnumConverter<T>`. */
function intEnumDecl(name: string, values: readonly number[], at: CsTypeContext): string {
	at.enums.add(name)
	return [
		`[JsonConverter(typeof(IntEnumConverter<${name}>))]`,
		`public enum ${name}`,
		"{",
		...values.map((value) => `    ${label(value)} = ${value},`),
		"}",
	].join("\n")
}

/** The enum `name` of the string or integer enum `ir`. */
export function enumDecl(name: string, ir: Scalar, at: CsTypeContext): string {
	const values = enumValues(ir)
	return ir.type === "string" ? stringEnumDecl(name, values as string[], at) : intEnumDecl(name, values as number[], at)
}
