/**
 * Java unions (bit 16 phase b, B2, B4): a union of const strings alone is a string enum. A discriminated oneOf or
 * anyOf is a `sealed interface` with record permits: one wrapper per variant, `<Union><Value>`, holding the variant's
 * type as `@JsonValue`, and `<Union>Unknown` for a payload no variant selects. An inline object variant's payload is
 * `<Union><Value>Body`. The nested `Deserializer` (json.ts) dispatches on the discriminator's value. Every permit and
 * wrapper is `@JsonDeserialize` with no argument; no `@JsonTypeInfo` is ever written.
 */
import type { IRDiscriminator, IRSchema } from "../../ir/model.ts"
import { compareCodeUnits, javaTypeName } from "../shared/lang.ts"
import { type Dispatch, deserializerLines } from "./json.ts"
import { classOf, typeHeader } from "./layout.ts"
import { enumValues, stringEnumDecl } from "./models-enum.ts"
import { fieldsOf } from "./models-record.ts"
import { JSON_NODE } from "./models-names.ts"
import type { JavaTypeContext, Member } from "./models.ts"

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>
type Discriminated = Of<"union"> & { discriminator: IRDiscriminator }

/** Declares `schema` once under `key` and `base`; its name. */
export type Declare = (schema: IRSchema, key: string, base: string) => string

/** What a union's declaration reaches: the context, its members' types, and the hoist. */
export type UnionScope = { at: JavaTypeContext; member: Member; declare: Declare }

/** Whether a variant is a const string: a union of these alone is a string enum. */
export const isLiteral = (variant: IRSchema): variant is Of<"const"> & { value: string } =>
	variant.kind === "const" && typeof variant.value === "string"

/** The values that select `variant`: its mapping keys, else its property's const or enum, else its ref's name. */
function selectors(variant: IRSchema, { mapping = {}, propertyName }: IRDiscriminator, at: JavaTypeContext): string[] {
	const mapped = Object.keys(mapping).filter((value) => variant.kind === "ref" && mapping[value] === variant.name)
	if (mapped.length > 0) return mapped
	const fields = fieldsOf(at.names.resolve(variant), at.names.resolve)
	const property = fields.find((field) => field.name === propertyName)?.schema
	if (property?.kind === "const") return [String(property.value)]
	if (property?.kind === "scalar") return enumValues(property).map(String)
	return variant.kind === "ref" ? [variant.name] : []
}

/** A ref or inline-object variant, its index, and the values that select it (each value selects one variant). */
type Selected = { index: number; schema: IRSchema; values: string[] }

/** A variant's sort key: its first selecting value, else none (which sorts first). */
const firstValue = ({ values }: Selected) => values[0] ?? ""

/** The selectable variants in code-unit order of their first value; a value that an earlier variant holds is dropped. */
function selectedBy(union: Discriminated, at: JavaTypeContext): Selected[] {
	const seen = new Set<string>()
	return union.variants
		.flatMap((schema, index): Selected[] => {
			if (schema.kind !== "ref" && schema.kind !== "object") return []
			const values = selectors(schema, union.discriminator, at).filter((value) => !seen.has(value))
			for (const value of values) seen.add(value)
			return [{ index, schema, values }]
		})
		.sort((a, b) => compareCodeUnits(firstValue(a), firstValue(b)))
}

/** A wrapper record holding its payload as `@JsonValue`, implementing its union. */
const wrapperText = (wrapper: string, union: string, payload: string): string =>
	typeHeader(0, {
		annotations: [{ name: "JsonDeserialize" }],
		components: [{ annotations: [{ name: "JsonValue" }], name: "value", type: payload }],
		end: "{}",
		implements: [union],
		kind: "record",
		modifiers: ["public"],
		name: wrapper,
	}).join("\n")

/** Each selectable variant's payload, wrapper and selecting values; the wrappers are declared here. */
function dispatchOf(name: string, union: Discriminated, scope: UnionScope): Dispatch[] {
	return selectedBy(union, scope.at).map(({ index, schema, values }) => {
		const first = values[0] ?? `Variant${index}`
		const payload =
			schema.kind === "ref"
				? scope.member(schema, first)
				: scope.declare(schema, `${name}.variant${index}`, `${name}${javaTypeName(first)}Body`)
		const wrapper = scope.at.names.hoist(`${name}.wrap${index}`, `${name}${javaTypeName(first)}`)
		scope.at.decls.set(wrapper, wrapperText(wrapper, name, payload))
		return { payload, values, wrapper }
	})
}

/** The sealed interface of `union`'s wrappers, its nested Deserializer, then the `<Union>Unknown` wrapper. */
function discriminatedDecl(name: string, union: Discriminated, scope: UnionScope): string {
	const dispatch = dispatchOf(name, union, scope)
	const unknown = scope.at.names.hoist(`${name}.unknown`, `${name}Unknown`)
	scope.at.decls.set(unknown, wrapperText(unknown, name, JSON_NODE))
	const permits = [...dispatch.map((arm) => arm.wrapper), unknown]
	return [
		...typeHeader(0, {
			annotations: [{ args: [["using", classOf(`${name}.Deserializer`)]], name: "JsonDeserialize" }],
			end: "{",
			kind: "interface",
			modifiers: ["public", "sealed"],
			name,
			permits,
		}),
		...deserializerLines(name, union.discriminator.propertyName, dispatch, unknown),
		"}",
	].join("\n")
}

/** The declaration of a union `declares`: a string enum of its const strings, or a discriminated interface. */
export function unionDecl(name: string, union: Of<"union">, scope: UnionScope): string {
	if (union.variants.every(isLiteral)) {
		const values = union.variants.map((variant) => (variant as Of<"const">).value as string)
		return stringEnumDecl(name, [...new Set(values)])
	}
	return discriminatedDecl(name, union as Discriminated, scope)
}
