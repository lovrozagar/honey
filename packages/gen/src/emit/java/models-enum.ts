/**
 * Java enums (bit 16 phase b, B2): a string `enum` is a Java `enum` with `@JsonProperty` on each constant, the constant
 * named by a sanitized wire value (words in UPPER_SNAKE, `""` is EMPTY, a digit first is N, a repeat takes `…2`). An
 * integer `enum` has an `L<n>` or `Neg<n>` constant per value, read by `@JsonCreator` and written by `@JsonValue`
 * (json.ts). A value past the int range takes an `L` suffix, as a Java long literal must.
 */
import type { IRSchema } from "../../ir/model.ts"
import { javaString } from "../shared/escape.ts"
import { NameScope, words } from "../shared/lang.ts"
import { intEnumJsonLines } from "./json.ts"
import { annotationLine, enumConstant, typeHeader } from "./layout.ts"

type Scalar = Extract<IRSchema, { kind: "scalar" }>

const INT_MIN = -2147483648
const INT_MAX = 2147483647

/** The values a string or integer enum declares, each once: a value of another kind has no member. */
export function enumValues(ir: Scalar): (number | string)[] {
	const values = ir.enum ?? []
	const kept =
		ir.type === "string"
			? values.filter((value) => typeof value === "string")
			: values.filter((value) => ir.type === "integer" && Number.isSafeInteger(value))
	return [...new Set(kept as (number | string)[])]
}

/** A string enum constant's base name: `""` is EMPTY, a value with no letter or digit VALUE, a digit first N. */
function constantOf(value: string): string {
	if (value === "") return "EMPTY"
	const word = words(value)
		.map((part) => part.toUpperCase())
		.join("_")
	if (word === "") return "VALUE"
	return /^[0-9]/.test(word) ? `N${word}` : word
}

/** `public enum <name>` of a string enum: one `@JsonProperty` constant per value, in order. */
export function stringEnumDecl(name: string, values: readonly string[]): string {
	const scope = new NameScope()
	const members = values.map((value) => [javaString(value), scope.claim(constantOf(value))] as const)
	const constants = members.flatMap(([wire, constant], i) => [
		...annotationLine(2, { args: [wire], name: "JsonProperty" }),
		`  ${constant}${i < members.length - 1 ? "," : ""}`,
	])
	return [...enumHeader(name), ...constants, "}"].join("\n")
}

/** An integer value's constant: `L<n>`, or `Neg<n>` below zero. */
/** `public enum Name {`. */
const enumHeader = (name: string) => typeHeader(0, { end: "{", kind: "enum", modifiers: ["public"], name })

const label = (value: number) => `${value < 0 ? "Neg" : "L"}${String(Math.abs(value))}`

/** An integer value as a Java `long` literal: a `L` suffix past the int range. */
const literal = (value: number) => (value >= INT_MIN && value <= INT_MAX ? String(value) : `${value}L`)

/** `public enum <name>` of an integer enum: one constant per value, then the `long` value and its JSON creator. */
function intEnumDecl(name: string, values: readonly number[]): string {
	const constants = values.flatMap((value, i) =>
		enumConstant(2, label(value), literal(value), i < values.length - 1 ? "," : ";"),
	)
	return [...enumHeader(name), ...constants, ...intEnumJsonLines(name), "}"].join("\n")
}

/** The enum `name` of the string or integer enum `ir`. */
export function enumDecl(name: string, ir: Scalar): string {
	const values = enumValues(ir)
	return ir.type === "string" ? stringEnumDecl(name, values as string[]) : intEnumDecl(name, values as number[])
}
