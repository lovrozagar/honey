/**
 * Rust enums for a string or integer `enum`. A string enum derives serde and renames a variant to its
 * value only when the two differ; an integer enum is `#[repr(i64)]` with serde written by hand (G9
 * drops serde_repr). The first variant is the default either way. Spec text reaches the source only
 * through the shared escape layer.
 */
import { rustString } from "../shared/escape.ts"
import { NameScope, rustTypeIdent } from "../shared/lang.ts"

type EnumValue = boolean | number | string

const STRING_DERIVE =
	"#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, serde::Serialize, serde::Deserialize)]"

/** The string values an enum declares, each once: a null has no variant. */
export const stringValues = (values: readonly EnumValue[]): string[] => [
	...new Set(values.filter((value) => (value as unknown) !== null).map(String)),
]

/** The integer values an enum declares, each once: any other value has no variant. */
export const integerValues = (values: readonly EnumValue[]): number[] => [
	...new Set(values.filter((value): value is number => Number.isSafeInteger(value))),
]

/** A variant for `value`, unique in `scope`: `""` is `Empty`, `self` is `SelfValue`, a repeat takes `…2`. */
export function variantOf(value: string, scope: NameScope): string {
	const base = value === "" ? "Empty" : rustTypeIdent(value)
	return scope.claim(base === "Self_" ? "SelfValue" : base)
}

/** `pub enum <name>` with one unit variant per value, renamed to the value where it differs. */
export function stringEnumDecl(name: string, values: readonly string[]): string {
	const scope = new NameScope()
	const variants = values.flatMap((value, i) => {
		const variant = variantOf(value, scope)
		return [
			...(i === 0 ? ["    #[default]"] : []),
			...(variant === value ? [] : [`    #[serde(rename = ${rustString(value)})]`]),
			`    ${variant},`,
		]
	})
	return [STRING_DERIVE, `pub enum ${name} {`, ...variants, "}"].join("\n")
}

/** An integer value's variant: `L<n>`, or `Neg<n>` below zero. */
const label = (value: number) => `${value < 0 ? "Neg" : "L"}${String(Math.abs(value))}`

/** `#[repr(i64)] pub enum <name>` with one `L<n>` variant per value, then its serde impls. */
export function intEnumDecl(name: string, values: readonly number[]): string {
	return [
		"#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]",
		"#[repr(i64)]",
		`pub enum ${name} {`,
		...values.flatMap((value, i) => [...(i === 0 ? ["    #[default]"] : []), `    ${label(value)} = ${value},`]),
		"}",
		"",
		`impl serde::Serialize for ${name} {`,
		"    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {",
		"        serializer.serialize_i64(*self as i64)",
		"    }",
		"}",
		"",
		`impl<'de> serde::Deserialize<'de> for ${name} {`,
		"    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {",
		"        match <i64 as serde::Deserialize>::deserialize(deserializer)? {",
		...values.map((value) => `            ${value} => Ok(Self::${label(value)}),`),
		`            other => Err(serde::de::Error::custom(format!("unknown ${name} {other}"))),`,
		"        }",
		"    }",
		"}",
	].join("\n")
}
