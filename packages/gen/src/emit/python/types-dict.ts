/**
 * TypedDicts (Fb6): a total `TypedDict` whose required key is a bare `T` and optional one `NotRequired[T]`, in
 * code-unit order of the JSON key. The class form when every key is an ASCII identifier, no hard keyword and
 * not `__`-prefixed (a class body would mangle it); else the functional form, each value one quoted string.
 * An allOf over dict-shaped refs inherits them; its inline objects' keys are merged, the first part's winning.
 */
import type { IRField, IRSchema } from "../../ir/model.ts"
import { lineComment, pyDocLines, pyString } from "../shared/escape.ts"
import { compareCodeUnits } from "../shared/lang.ts"

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>

/** The Python type of `schema` at the key `fieldName` of the declaration being written. */
export type Member = (schema: IRSchema, fieldName: string) => string

/** One key as declared: its JSON spelling and its annotation. */
export type DictKey = { readonly key: string; readonly type: string }

/** How a dict is declared beyond its keys: its bases and its docstring. */
export type DictShape = { readonly bases?: readonly string[]; readonly doc?: string }

/* the hard keywords: no class body can spell one as a key */
const HARD_KEYWORDS =
	" False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield "

/** Whether a class body can spell `key` as it is. */
const spellable = (key: string) =>
	/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !HARD_KEYWORDS.includes(` ${key} `) && !key.startsWith("__")

/** A class docstring's lines, then the blank line ruff keeps after one. */
const docLines = (doc: string | undefined) => {
	if (doc === undefined) return []
	const lines = pyDocLines(doc)
	const body = lines.length === 1 ? [`"""${lines[0]}"""`] : [`"""${lines[0]}`, ...lines.slice(1), '"""']
	return [...body.map((line) => (line === "" ? "" : `    ${line}`)), ""]
}

/** The TypedDict `name` over `keys`: the class form when every key is spellable, else the functional form. */
export function dictDecl(name: string, keys: readonly DictKey[], shape: DictShape = {}): string {
	if (keys.every(({ key }) => spellable(key))) {
		const body = keys.length > 0 ? keys.map(({ key, type }) => `    ${key}: ${type}`) : ["    pass"]
		return [`class ${name}(${(shape.bases ?? ["TypedDict"]).join(", ")}):`, ...docLines(shape.doc), ...body].join("\n")
	}
	const entries = keys.map(({ key, type }) => `${pyString(key)}: ${pyString(type)}`).join(", ")
	const doc = shape.doc === undefined ? [] : lineComment(shape.doc, "#")
	return [...doc, `${name} = TypedDict(`, `    ${pyString(name)},`, `    {${entries}},`, ")"].join("\n")
}

const byKey = (a: IRField, b: IRField) => compareCodeUnits(a.name, b.name)

/** `fields` as keys: a required one bare, an optional one `NotRequired[T]`; `optional` when it reads that. */
export function keysOf(fields: readonly IRField[], member: Member, optional: () => void): DictKey[] {
	return [...fields].sort(byKey).map((field) => {
		const type = member(field.schema, field.name)
		if (field.required) return { key: field.name, type }
		optional()
		return { key: field.name, type: `NotRequired[${type}]` }
	})
}

/** The fields of `parts`' inline objects, a repeated key once (its first part's). */
export function mergedFields(parts: readonly IRSchema[]): IRField[] {
	return parts
		.flatMap((part) => (part.kind === "object" ? part.fields : []))
		.filter((field, i, all) => all.findIndex((first) => first.name === field.name) === i)
}

/** Whether an allOf can be one class: every part a ref to a TypedDict or an inline object. */
export function dictParts(ir: Of<"allOf">, isDict: (schema: IRSchema) => boolean): boolean {
	return (
		ir.parts.length > 0 && ir.parts.every((part) => part.kind === "object" || (part.kind === "ref" && isDict(part)))
	)
}
