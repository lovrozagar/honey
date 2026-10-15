/**
 * A discriminated union as Go (v0): a struct of one `*Variant` per variant plus `Raw`, decoded on the
 * discriminator's value and encoded as whichever variant is set. Go has no union type; a payload whose
 * value matches no variant is kept whole in `Raw`.
 */
import type { IRDiscriminator, IRSchema } from "../../ir/model.ts"
import { goString, lineComment } from "../shared/escape.ts"
import { goExported, NameScope } from "../shared/lang.ts"
import type { GoTypeNames } from "./types.ts"

type Union = Extract<IRSchema, { kind: "union" }> & { discriminator: IRDiscriminator }

/** Declares an inline variant once under `names.hoist(key, base)`; its name. */
export type DeclareVariant = (schema: IRSchema, key: string, base: string) => string

type Variant = { field: string; type: string; values: string[] }

/** The discriminator values that select `variant`: its mapping keys, else its property's const or enum, else its name. */
function selectors(variant: IRSchema, { mapping, propertyName }: IRDiscriminator, names: GoTypeNames): string[] {
	if (variant.kind === "ref" && mapping) {
		const mapped = Object.keys(mapping).filter((value) => mapping[value] === variant.name)
		if (mapped.length > 0) return mapped
	}
	const resolved = names.resolve(variant)
	const property =
		resolved.kind === "object" ? resolved.fields.find((field) => field.name === propertyName)?.schema : undefined
	if (property?.kind === "const" && typeof property.value === "string") return [property.value]
	if (property?.kind === "scalar" && property.enum) return property.enum.map(String)
	return variant.kind === "ref" ? [variant.name] : []
}

/** One field per ref or inline-object variant, named after its first value; any other variant has none. */
function variantsOf(name: string, union: Union, names: GoTypeNames, declare: DeclareVariant): Variant[] {
	const scope = new NameScope(["Raw", "UnmarshalJSON", "MarshalJSON"])
	return union.variants.flatMap((schema, i) => {
		if (schema.kind !== "ref" && schema.kind !== "object") return []
		const values = selectors(schema, union.discriminator, names)
		const type =
			schema.kind === "ref"
				? names.ref(schema.name)
				: declare(schema, `${name}.variant${i}`, `${name}${goExported(values[0] ?? `Variant${i}`)}`)
		return [{ field: scope.claim(goExported(values[0] ?? type)), type, values }]
	})
}

function unmarshal(name: string, property: string, variants: readonly Variant[]): string[] {
	return [
		`func (u *${name}) UnmarshalJSON(data []byte) error {`,
		"\tvar probe map[string]json.RawMessage",
		"\tif err := json.Unmarshal(data, &probe); err != nil {",
		"\t\treturn err",
		"\t}",
		"\tvar tag string",
		`\tif v, ok := probe[${goString(property)}]; ok {`,
		"\t\t_ = json.Unmarshal(v, &tag)",
		"\t}",
		`\t*u = ${name}{}`,
		"\tswitch tag {",
		...variants
			.filter((v) => v.values.length > 0)
			.flatMap((v) => [
				`\tcase ${v.values.map(goString).join(", ")}:`,
				`\t\tu.${v.field} = new(${v.type})`,
				`\t\treturn json.Unmarshal(data, u.${v.field})`,
			]),
		"\t}",
		"\tu.Raw = append(json.RawMessage(nil), data...)",
		"\treturn nil",
		"}",
	]
}

function marshal(name: string, variants: readonly Variant[]): string[] {
	return [
		`func (u ${name}) MarshalJSON() ([]byte, error) {`,
		...variants.flatMap((v) => [`\tif u.${v.field} != nil {`, `\t\treturn json.Marshal(u.${v.field})`, "\t}"]),
		"\tif u.Raw != nil {",
		"\t\treturn u.Raw, nil",
		"\t}",
		'\treturn []byte("null"), nil',
		"}",
	]
}

/** The union's struct and its (un)marshal methods; inline object variants are declared through `declare`. */
export function unionDecl(name: string, union: Union, names: GoTypeNames, declare: DeclareVariant): string {
	const property = union.discriminator.propertyName
	const variants = variantsOf(name, union, names, declare)
	return [
		...lineComment(`${name} holds exactly one variant, selected by the "${property}" property.`, "//"),
		`type ${name} struct {`,
		...variants.map((v) => `\t${v.field} *${v.type}`),
		"\t// Raw keeps a payload whose discriminator matches no known variant.",
		"\tRaw json.RawMessage",
		"}",
		"",
		...unmarshal(name, property, variants),
		"",
		...marshal(name, variants),
	].join("\n")
}
