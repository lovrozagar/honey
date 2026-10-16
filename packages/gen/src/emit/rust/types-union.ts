/**
 * Rust enums for unions. Without a discriminator: `#[serde(untagged)]`, one `Variant<i>(T)` per
 * variant, and the const-string variants gathered into one `Literal` over a hoisted string enum (a
 * union of const strings alone is that string enum). With one: a payload variant per ref or inline
 * object, plus `Unknown` keeping any other payload whole, serialized as the payload and deserialized
 * on the discriminator's value with the payload kept, the discriminator included.
 */
import type { IRDiscriminator, IRSchema } from "../../ir/model.ts"
import { lineComment, rustString } from "../shared/escape.ts"
import { NameScope, rustTypeIdent } from "../shared/lang.ts"
import { stringEnumDecl, stringValues, variantOf } from "./types-enum.ts"
import { DERIVE, type Member } from "./types-struct.ts"
import type { RustTypeNames } from "./types.ts"

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>

/** Declares `schema` once under `names.hoist(key, base)`; its name. */
export type Declare = (schema: IRSchema, key: string, base: string) => string

/** What a union's declaration reaches: the names, its members' types, and the hoist. */
export type UnionScope = { names: RustTypeNames; member: Member; declare: Declare }

const isLiteral = (variant: IRSchema): variant is Of<"const"> & { value: string } =>
	variant.kind === "const" && typeof variant.value === "string"

/** An untagged enum: the const strings as one `Literal` variant tried first, then each other variant. */
function untaggedDecl(name: string, union: Of<"union">, { member, declare }: UnionScope): string {
	const values = stringValues(union.variants.filter(isLiteral).map((variant) => variant.value))
	if (union.variants.every(isLiteral)) return stringEnumDecl(name, values)
	const literal = { enum: values, kind: "scalar", type: "string" } as const
	const variants = [
		...(values.length > 0 ? [`Literal(${declare(literal, `${name}.literal`, `${name}Literal`)})`] : []),
		...union.variants.flatMap((variant, i) =>
			isLiteral(variant) ? [] : [`Variant${i}(${member(variant, `variant${i}`)})`],
		),
	]
	return [DERIVE, "#[serde(untagged)]", `pub enum ${name} {`, ...variants.map((v) => `    ${v},`), "}"].join("\n")
}

/** The discriminator values that select `variant`: its mapping keys, else its property's const or enum, else its name. */
function selectors(variant: IRSchema, { mapping, propertyName }: IRDiscriminator, names: RustTypeNames): string[] {
	const mapped =
		variant.kind === "ref" && mapping ? Object.keys(mapping).filter((v) => mapping[v] === variant.name) : []
	if (mapped.length > 0) return mapped
	const resolved = names.resolve(variant)
	const property =
		resolved.kind === "object" ? resolved.fields.find((field) => field.name === propertyName)?.schema : undefined
	if (property?.kind === "const") return [String(property.value)]
	if (property?.kind === "scalar" && property.enum) return stringValues(property.enum)
	return variant.kind === "ref" ? [variant.name] : []
}

/** A payload variant: its name, its type and the values it is selected by (each value selects one variant). */
type Variant = { variant: string; type: string; values: string[] }

/** One variant per ref or inline-object variant, named after its first value; any other variant has none. */
function variantsOf(name: string, union: Of<"union"> & { discriminator: IRDiscriminator }, scope: UnionScope) {
	const variantNames = new NameScope(["Unknown"])
	const seen = new Set<string>()
	const fresh = (value: string) => {
		const unseen = !seen.has(value)
		seen.add(value)
		return unseen
	}
	return union.variants.flatMap((schema, i): Variant[] => {
		if (schema.kind !== "ref" && schema.kind !== "object") return []
		const values = selectors(schema, union.discriminator, scope.names)
		const type =
			schema.kind === "ref"
				? scope.member(schema, `variant${i}`)
				: scope.declare(schema, `${name}.variant${i}`, `${name}${rustTypeIdent(values[0] ?? `Variant${i}`)}`)
		return [{ type, values: values.filter(fresh), variant: variantOf(values[0] ?? type, variantNames) }]
	})
}

/** `Serialize` as the payload of whichever variant holds it. */
const serializeImpl = (name: string, variants: readonly Variant[]) => [
	`impl serde::Serialize for ${name} {`,
	"    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {",
	"        match self {",
	...[...variants.map((v) => v.variant), "Unknown"].map(
		(variant) => `            Self::${variant}(value) => serde::Serialize::serialize(value, serializer),`,
	),
	"        }",
	"    }",
	"}",
]

/** `Deserialize` by the discriminator's value, the payload kept whole; any other value is `Unknown`. */
const deserializeImpl = (name: string, property: string, variants: readonly Variant[]) => [
	`impl<'de> serde::Deserialize<'de> for ${name} {`,
	"    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
	"        let value = <serde_json::Value as serde::Deserialize>::deserialize(deserializer)?;",
	`        let decoded = match value.get(${rustString(property)}).and_then(serde_json::Value::as_str) {`,
	...variants
		.filter((v) => v.values.length > 0)
		.map(
			(v) =>
				`            Some(${v.values.map(rustString).join(" | ")}) => serde_json::from_value(value).map(Self::${v.variant}),`,
		),
	"            _ => Ok(Self::Unknown(value)),",
	"        };",
	"        decoded.map_err(serde::de::Error::custom)",
	"    }",
	"}",
]

/** A discriminated enum and its hand-written serde impls; inline object variants are declared through `declare`. */
function discriminatedDecl(name: string, union: Of<"union"> & { discriminator: IRDiscriminator }, scope: UnionScope) {
	const property = union.discriminator.propertyName
	const variants = variantsOf(name, union, scope)
	return [
		...lineComment(`${name} holds exactly one variant, selected by the "${property}" property.`, "///"),
		"/// A value no variant declares deserializes to `Unknown`, the payload kept whole.",
		"#[derive(Debug, Clone, PartialEq)]",
		`pub enum ${name} {`,
		...variants.map((v) => `    ${v.variant}(${v.type}),`),
		"    Unknown(serde_json::Value),",
		"}",
		"",
		...serializeImpl(name, variants),
		"",
		...deserializeImpl(name, property, variants),
	].join("\n")
}

/** The declaration of a union with at least one variant. */
export function unionDecl(name: string, union: Of<"union">, scope: UnionScope): string {
	const { discriminator } = union
	return discriminator ? discriminatedDecl(name, { ...union, discriminator }, scope) : untaggedDecl(name, union, scope)
}
