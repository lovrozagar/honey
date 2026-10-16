/**
 * Rust structs for objects and allOf compositions. Fields sort by JSON key and take a snake_case
 * identifier (a keyword raw, `r#type`), renamed to the key only when the two differ. An optional
 * field is `Option<T>`, skipped when `None`; an optional nullable one is `Option<Option<T>>` through
 * the runtime's null-keeping deserializer, so absent, null and a value stay three states. An allOf's
 * refs and an object's extra keys are `#[serde(flatten)]` fields.
 */
import type { IRField, IRSchema } from "../../ir/model.ts"
import { rustString } from "../shared/escape.ts"
import { compareCodeUnits, NameScope, rustValueIdent } from "../shared/lang.ts"

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>

/** The Rust type of `schema` at the member `fieldName` of the struct being declared. */
export type Member = (schema: IRSchema, fieldName: string) => string

export const DERIVE = "#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]"

const SKIP = 'skip_serializing_if = "Option::is_none"'
/* absent, null and a value: `default` for absent, the runtime's deserializer keeping null as Some(None) */
const TRI_STATE = ["default", 'deserialize_with = "crate::nullable::deserialize"', SKIP]

/** One field as declared: its identifier, its type and its `#[serde(…)]` keys. */
type Field = { ident: string; type: string; serde: string[] }

/** A field's lines: its serde keys in one attribute when it has any, then `pub <ident>: <type>,`. */
const fieldLines = ({ ident, type, serde }: Field) => [
	...(serde.length > 0 ? [`    #[serde(${serde.join(", ")})]`] : []),
	`    pub ${ident}: ${type},`,
]

/** `pub struct <name> { … }` with its derives; `{}` without fields, which serde reads and writes as `{}`. */
function structDecl(name: string, fields: readonly Field[]): string {
	if (fields.length === 0) return [DERIVE, `pub struct ${name} {}`].join("\n")
	return [DERIVE, `pub struct ${name} {`, ...fields.flatMap(fieldLines), "}"].join("\n")
}

/** The field for `field`, its identifier claimed in `scope`. */
function fieldOf(field: IRField, scope: NameScope, member: Member): Field {
	const ident = scope.claim(rustValueIdent(field.name))
	const rename = ident.replace(/^r#/, "") === field.name ? [] : [`rename = ${rustString(field.name)}`]
	if (field.required) return { ident, serde: rename, type: member(field.schema, field.name) }
	if (field.schema.kind === "nullable") {
		const inner = member(field.schema.inner, field.name)
		return { ident, serde: [...rename, ...TRI_STATE], type: `Option<Option<${inner}>>` }
	}
	return { ident, serde: [...rename, SKIP], type: `Option<${member(field.schema, field.name)}>` }
}

const byKey = (a: IRField, b: IRField) => compareCodeUnits(a.name, b.name)

/** A map element or value: a ref there is behind the map already, so it needs no `Box`. */
export const unboxed = (item: IRSchema, type: string) =>
	item.kind === "ref" && type.startsWith("Box<") ? type.slice(4, -1) : type

/** A struct of the object's fields in key order, then an `extra` map of the keys it admits beyond them. */
export function objectDecl(name: string, ir: Of<"object">, member: Member): string {
	const scope = new NameScope()
	const fields = [...ir.fields].sort(byKey).map((field) => fieldOf(field, scope, member))
	if (ir.additional) {
		const value = unboxed(ir.additional, member(ir.additional, "Extra"))
		const ident = scope.claim("extra")
		fields.push({ ident, serde: ["flatten"], type: `std::collections::HashMap<String, ${value}>` })
	}
	return structDecl(name, fields)
}

/** A struct flattening each ref part, with every object part's fields inlined (a key once, its first part's). */
export function allOfDecl(name: string, ir: Of<"allOf">, member: Member, ref: (name: string) => string): string {
	const scope = new NameScope()
	const flattened = ir.parts
		.filter((part): part is Of<"ref"> => part.kind === "ref")
		.map((part) => ({
			ident: scope.claim(rustValueIdent(ref(part.name))),
			serde: ["flatten"],
			type: member(part, part.name),
		}))
	const fields = ir.parts
		.flatMap((part) => (part.kind === "object" ? [...part.fields].sort(byKey) : []))
		.filter((field, i, all) => all.findIndex((first) => first.name === field.name) === i)
		.map((field) => fieldOf(field, scope, member))
	return structDecl(name, [...flattened, ...fields])
}
