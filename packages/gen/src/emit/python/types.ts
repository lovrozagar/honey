/**
 * Python types from the IR alone (H2): the annotation at a use position, a component's declaration, and the
 * declarations both hoist: a TypedDict for every inline object, one per inline union variant (Fb6). Every
 * emitted module has `from __future__ import annotations`, so annotations are never quoted; an alias is one
 * quoted string. Spec text reaches the source only through the shared escape layer.
 */
import type { IR, IRSchema } from "../../ir/model.ts"
import { pascalWords, pyClassName } from "../shared/lang.ts"
import { dictDecl, type DictKey, dictParts, keysOf, type Member, mergedFields } from "./types-dict.ts"
import { irNames, plainNames } from "./types-names.ts"
import { aliasDecl, joined, type Part, valuePart, variantSuffix } from "./types-union.ts"

/** How component and hoisted names are claimed. */
export type PyTypeNames = {
	/** the class name of the component `name` */
	ref(name: string): string
	/** a unique module-level name for a hoisted declaration; one key always gets the same name */
	hoist(key: string, base: string): string
	/** a unique module-level name for any other declaration (`<Op>Headers`, a resource class) */
	claim(base: string): string
	resolve(schema: IRSchema): IRSchema
}

/**
 * Where a type is being written: its parent and field, the declarations it hoists, the names, and the `typing`
 * names its module imports. `declTyping` takes a hoisted declaration's own names when `typing` is another
 * module's (the client's signatures hoist into the types module).
 */
export type PyTypeContext = {
	parentName: string
	fieldName: string
	decls: Map<string, string>
	names: PyTypeNames
	typing: Set<string>
	declTyping?: Set<string>
}

/** A use position inside the walk: how deep it is, and where what it hoists imports its typing names. */
type At = PyTypeContext & { depth: number; declTyping: Set<string> }

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>

/* deeper than this, a schema is Any (Go and Rust parity; v0 Python stopped at 8) */
const MAX_DEPTH = 12

const SCALARS: Readonly<Record<Of<"scalar">["type"], string>> = {
	boolean: "bool",
	integer: "int",
	null: "None",
	number: "float",
	string: "str",
}

/** A context over `ir`'s components, or plain names without one. */
export function pyTypeContext(ir?: IR): PyTypeContext {
	const names = ir ? irNames(ir) : plainNames()
	return { decls: new Map(), fieldName: "", names, parentName: "", typing: new Set() }
}

/** `ir` declared once as `names.hoist(key, base)` into `at.decls`, its typing names into the declaring module's; its name. */
function declare(ir: IRSchema, at: At, key: string, base: string): string {
	const name = at.names.hoist(key, base)
	if (!at.decls.has(name)) {
		/* claimed before its body: what the body hoists in turn comes after it */
		at.decls.set(name, "")
		at.decls.set(name, pyTopLevel(name, ir, { ...at, typing: at.declTyping }))
	}
	return name
}

/** `ir` hoisted as `<Parent><Field><suffix>`. */
const hoist = (ir: IRSchema, at: At, suffix = "") =>
	declare(
		ir,
		at,
		`${at.parentName}.${at.fieldName}${suffix}`,
		`${pyClassName(at.parentName)}${pascalWords(at.fieldName)}${suffix}`,
	)

const deeper = (at: At, fieldName = at.fieldName): At => ({ ...at, depth: at.depth + 1, fieldName })

/** Whether `schema` is declared as a TypedDict: an object with keys or closed, or an allOf of such. */
function isDict(schema: IRSchema, at: PyTypeContext, seen = new Set<IRSchema>()): boolean {
	const resolved = at.names.resolve(schema)
	if (seen.has(resolved)) return false
	seen.add(resolved)
	if (resolved.kind === "object") return resolved.fields.length > 0 || resolved.additional === false
	return resolved.kind === "allOf" && dictParts(resolved, (part) => isDict(part, at, seen))
}

function objectUse(ir: Of<"object">, at: At): string {
	if (ir.fields.length > 0) return hoist(ir, at)
	const value = ir.additional ? use(ir.additional, deeper(at, `${at.fieldName}Value`)) : use({ kind: "unknown" }, at)
	return `dict[str, ${value}]`
}

function tupleUse(ir: Of<"tuple">, at: At): string {
	if (ir.required !== undefined && ir.required < ir.items.length) return `list[${use({ kind: "unknown" }, at)}]`
	const items = ir.items.map((item, i) => use(item, deeper(at, `${at.fieldName}Item${i}`)))
	if (ir.rest === undefined) return `tuple[${items.length > 0 ? items.join(", ") : "()"}]`
	const rest = use(ir.rest, deeper(at, `${at.fieldName}Rest`))
	return items.length > 0 ? `tuple[${items.join(", ")}, *tuple[${rest}, ...]]` : `tuple[${rest}, ...]`
}

/** An allOf of one part is that part; of TypedDict-shaped parts, one hoisted class; anything else is Any. */
function allOfUse(ir: Of<"allOf">, at: At): string {
	if (ir.parts.length === 1) return use(ir.parts[0] as IRSchema, at)
	return isDict(ir, at) ? hoist(ir, at) : use({ kind: "unknown" }, at)
}

/** The members a schema contributes to a union: its own type, or its variants', consts and enum values. */
function partsOf(ir: IRSchema, at: At): Part[] {
	if (at.depth > MAX_DEPTH) return [{ type: "Any" }]
	if (ir.kind === "const") return [valuePart(ir.value)]
	if (ir.kind === "scalar" && ir.enum !== undefined) return ir.enum.map(valuePart)
	if (ir.kind === "nullable") return [...partsOf(ir.inner, deeper(at)), { type: "None" }]
	if (ir.kind !== "union") return [{ type: single(ir, at) }]
	return ir.variants.flatMap((variant, i) =>
		variant.kind === "object" && variant.fields.length > 0
			? [{ type: hoist(variant, deeper(at), variantSuffix(variant, i, ir.discriminator)) }]
			: partsOf(variant, deeper(at)),
	)
}

/** A type that is never a union by itself. */
function single(ir: Exclude<IRSchema, { kind: "const" | "nullable" | "union" }>, at: At): string {
	if (ir.kind === "array") return `list[${use(ir.items, deeper(at, `${at.fieldName}Item`))}]`
	if (ir.kind === "tuple") return tupleUse(ir, at)
	if (ir.kind === "object") return objectUse(ir, at)
	if (ir.kind === "allOf") return allOfUse(ir, deeper(at))
	/* a ref to no component reads as any JSON value: the IR resolves it to unknown */
	if (ir.kind === "ref") return at.names.resolve(ir).kind === "unknown" ? "Any" : at.names.ref(ir.name)
	if (ir.kind === "scalar") return SCALARS[ir.type]
	return ir.kind === "binary" ? "str" : "Any"
}

/** `ir`'s annotation; the `typing` names it spells land in `at.typing`, those of what it hoists in the declaring module's. */
function use(ir: IRSchema, at: At): string {
	const spelled = new Set<string>()
	const { literal, text } = joined(partsOf(ir, { ...at, typing: spelled }))
	for (const name of text === "Any" ? ["Any"] : [...spelled, ...(literal ? ["Literal"] : [])]) at.typing.add(name)
	return text
}

/** The Python type of `ir` in use position; what it hoists lands in `at.decls`. */
export function pyTypeOf(ir: IRSchema, at: PyTypeContext): string {
	return use(ir, { ...at, declTyping: at.declTyping ?? at.typing, depth: 0 })
}

/** The keys of the TypedDict `name` declares for `fields`, `NotRequired` noted when one is optional. */
function dictKeys(name: string, fields: Parameters<typeof keysOf>[0], at: PyTypeContext): DictKey[] {
	const member: Member = (schema, fieldName) =>
		use(schema, { ...at, declTyping: at.declTyping ?? at.typing, depth: 0, fieldName, parentName: name })
	return keysOf(fields, member, () => at.typing.add("NotRequired"))
}

/** The declaration of `name` (a class name already) for `ir`, `doc` its description. */
export function pyTopLevel(name: string, ir: IRSchema, at: PyTypeContext, doc?: string): string {
	if (ir.kind === "object" && (ir.fields.length > 0 || ir.additional === false)) {
		at.typing.add("TypedDict")
		return dictDecl(name, dictKeys(name, ir.fields, at), { doc })
	}
	if (ir.kind === "allOf" && ir.parts.length > 1 && isDict(ir, at)) {
		const bases = ir.parts.flatMap((part) => (part.kind === "ref" ? [at.names.ref(part.name)] : []))
		const keys = dictKeys(name, mergedFields(ir.parts), at)
		if (bases.length === 0) at.typing.add("TypedDict")
		return dictDecl(name, keys, { bases: bases.length > 0 ? bases : undefined, doc })
	}
	at.typing.add("TypeAlias")
	return aliasDecl(name, pyTypeOf(ir, { ...at, fieldName: "", parentName: name }), doc)
}
