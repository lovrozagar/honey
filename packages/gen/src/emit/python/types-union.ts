/**
 * Unions and aliases (Fb6 e, f): a union is its members joined `A | B`, flattened and deduplicated, `None`
 * last; consts and enum values collapse into one `Literal[...]` where the first of them sits; an `Any` member
 * makes the whole union `Any`. An inline object variant hoists as `<Parent><Field>Variant<i>`, or under a
 * discriminator as `<Parent><Field><Const>`. A component that is no TypedDict is a `TypeAlias` of one quoted
 * string, so it needs no declaration order.
 */
import type { IRDiscriminator, IRSchema } from "../../ir/model.ts"

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>
import { lineComment, pyString } from "../shared/escape.ts"
import { pascalWords } from "../shared/lang.ts"

/** One union member: a `Literal` value, or a type. */
export type Part = { readonly literal: string } | { readonly type: string }

/**
 * An enum or const value as a member: a `Literal` value, or `float` (PEP 586 has no float literals). Never a null: the
 * IR keeps null out of every enum's values (a nullable says it) and reads a null const as unknown.
 */
export function valuePart(value: boolean | number | string): Part {
	if (typeof value === "string") return { literal: pyString(value) }
	if (typeof value === "boolean") return { literal: value ? "True" : "False" }
	const integral = typeof value === "number" && Number.isInteger(value)
	return integral ? { literal: BigInt(value).toString() } : { type: "float" }
}

/* where the Literal goes among a union's types: a string no type is spelled as */
const LITERAL = "\u0000"

/** `parts` as one annotation, and whether it spells `Literal`. */
export function joined(parts: readonly Part[]): { readonly text: string; readonly literal: boolean } {
	const types = new Set<string>()
	const literals = new Set<string>()
	for (const part of parts) {
		if ("type" in part) {
			types.add(part.type)
			continue
		}
		if (literals.size === 0) types.add(LITERAL)
		literals.add(part.literal)
	}
	if (types.has("Any")) return { literal: false, text: "Any" }
	const shown = [...types]
		.filter((type) => type !== "None")
		.map((type) => (type === LITERAL ? `Literal[${[...literals].join(", ")}]` : type))
	return { literal: literals.size > 0, text: [...shown, ...(types.has("None") ? ["None"] : [])].join(" | ") }
}

/** The name suffix of an inline object variant: its discriminator const, else `Variant<i>`. */
export function variantSuffix(variant: Of<"object">, i: number, discriminator: IRDiscriminator | undefined): string {
	const property = variant.fields.find((field) => field.name === discriminator?.propertyName)
	const value = property?.schema.kind === "const" ? pascalWords(String(property.schema.value)) : ""
	return value === "" ? `Variant${i}` : value
}

/** `name` declared as an alias of `text`, its description as comment lines above it. */
export function aliasDecl(name: string, text: string, doc?: string): string {
	return [...(doc === undefined ? [] : lineComment(doc, "#")), `${name}: TypeAlias = ${pyString(text)}`].join("\n")
}
