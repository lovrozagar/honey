/**
 * C# types from the IR alone (H2): the type at a use position, a component's top-level declaration, and what both
 * hoist into the context (§4.5): a string or integer enum, and a record for every inline object. C# has no
 * namespace-level alias, so a scalar, array, map, const or plain-union component declares nothing and a ref to one
 * is its use type. The context also gathers what the JSON context needs beyond the declarations: each collection's
 * item types (Fb6) and the types only a converter reads. Spec text reaches the source only through the escape layer.
 */
import type { IR, IRSchema } from "../../ir/model.ts"
import { csTypeName, pascalWords } from "../shared/lang.ts"
import { enumDecl, enumValues } from "./types-enum.ts"
import { type CsTypeNames, irNames } from "./types-names.ts"
import { fieldsOf, recordDecl } from "./types-record.ts"
import { isLiteral, unionDecl } from "./types-union.ts"

export type { CsTypeNames } from "./types-names.ts"

/** Where a type is being written, the declarations it hoists, the names, and what the JSON context gathers. */
export type CsTypeContext = {
	parentName: string
	fieldName: string
	decls: Map<string, string>
	names: CsTypeNames
	/** the declared enums: value types, so `T?` of one is `Nullable<T>` */
	enums: Set<string>
	/** each collection type used, its item as written: `IReadOnlyList<string?>` (Fb6) */
	collections: Set<string>
	/** the types a converter reads by `GetTypeInfo` alone: union variants and `Opt<T>`'s `T` (Fb7) */
	serialized: Set<string>
}

/** The C# type of `schema` at the member `fieldName` of the declaration being written. */
export type Member = (schema: IRSchema, fieldName: string) => string

type At = CsTypeContext & { depth: number }

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>

export const JSON_ELEMENT = "JsonElement"
const MAP = "IReadOnlyDictionary<string, "
/* deeper than this, a schema is any JSON value */
const MAX_DEPTH = 12

const SCALARS: Readonly<Record<Of<"scalar">["type"], string>> = {
	boolean: "bool",
	integer: "long",
	null: JSON_ELEMENT,
	number: "double",
	string: "string",
}

/** A context over `ir`'s components (none without it), with `taken` reserved besides. */
export function csTypeContext(ir?: IR, taken: readonly string[] = []): CsTypeContext {
	return {
		collections: new Set(),
		decls: new Map(),
		enums: new Set(),
		fieldName: "",
		names: irNames(ir?.schemas ?? {}, taken, declares),
		parentName: "",
		serialized: new Set(),
	}
}

/** Whether a scalar is a string or integer enum with a value of its kind: a declared enum. */
const isEnum = (ir: Of<"scalar">) => enumValues(ir).length > 0

/** Whether C# declares a type for a component of `ir`: an enum, a record, a discriminated or const-string union. */
export function declares(ir: IRSchema): boolean {
	if (ir.kind === "scalar") return isEnum(ir)
	if (ir.kind === "object") return ir.fields.length > 0 || ir.additional === false
	if (ir.kind === "allOf") return ir.parts.length > 0 && ir.parts.every((p) => p.kind === "object" || p.kind === "ref")
	if (ir.kind !== "union" || ir.variants.length === 0) return false
	return ir.discriminator !== undefined || ir.variants.every(isLiteral)
}

/** `ir` declared once as `names.hoist(key, base)` into `at.decls`; its name. */
function declare(ir: IRSchema, at: CsTypeContext, key: string, base: string): string {
	const name = at.names.hoist(key, base)
	if (!at.decls.has(name)) {
		/* claimed before its body: what the body hoists in turn comes after it */
		at.decls.set(name, "")
		at.decls.set(name, csTopLevel(name, ir, at))
	}
	return name
}

/** `ir` hoisted as `<Parent><Field>`. */
const hoist = (ir: IRSchema, at: At) =>
	declare(ir, at, `${at.parentName}.${at.fieldName}`, `${csTypeName(at.parentName)}${pascalWords(at.fieldName)}`)

const deeper = (at: At, fieldName = at.fieldName): At => ({ ...at, depth: at.depth + 1, fieldName })

/** A const's C# type: its value's, a declared `number` making an integral value double. */
function constType({ type, value }: Of<"const">): string {
	if (typeof value === "number") return type === "number" || !Number.isInteger(value) ? "double" : "long"
	return typeof value === "boolean" ? "bool" : "string"
}

/** A collection of `item`, noted for the JSON context's strict converters. */
function collection(open: string, item: string, at: At): string {
	const type = `${open}${item}>`
	at.collections.add(type)
	return type
}

function objectUse(ir: Of<"object">, at: At): string {
	if (ir.fields.length > 0) return hoist(ir, at)
	if (ir.additional) return collection(MAP, use(ir.additional, deeper(at)), at)
	return ir.additional === false ? JSON_ELEMENT : `${MAP}${JSON_ELEMENT}>`
}

/** An allOf of one part is that part; of more, its first ref (the rest is not typed here), else any JSON value. */
function allOfUse(ir: Of<"allOf">, at: At): string {
	const part = ir.parts.length === 1 ? ir.parts[0] : ir.parts.find((p) => p.kind === "ref")
	return part === undefined ? JSON_ELEMENT : use(part, at)
}

/** `T?`, but JsonElement stays JsonElement: it holds null itself. */
function nullableUse(ir: Of<"nullable">, at: At): string {
	const inner = use(ir.inner, deeper(at))
	return inner === JSON_ELEMENT ? JSON_ELEMENT : `${inner.replace(/\?$/, "")}?`
}

/** A declared component's name, or the use type of one that declares nothing. */
function refUse(ir: Of<"ref">, at: At): string {
	const aliased = at.names.alias(ir.name)
	return aliased === undefined ? at.names.ref(ir.name) : use(aliased, deeper(at))
}

type Use = (ir: never, at: At) => string

const USES: Readonly<{ [K in IRSchema["kind"]]: (ir: Of<K>, at: At) => string }> = {
	allOf: allOfUse,
	array: (ir, at) => collection("IReadOnlyList<", use(ir.items, deeper(at, `${at.fieldName}Item`)), at),
	binary: () => "string",
	const: constType,
	nullable: nullableUse,
	object: objectUse,
	ref: refUse,
	scalar: (ir, at) => (isEnum(ir) ? hoist(ir, at) : SCALARS[ir.type]),
	tuple: () => `IReadOnlyList<${JSON_ELEMENT}>`,
	/* a union in use position is any JSON value; a component union is declared (Fb7) */
	union: () => JSON_ELEMENT,
	unknown: () => JSON_ELEMENT,
}

function use(ir: IRSchema, at: At): string {
	return at.depth > MAX_DEPTH ? JSON_ELEMENT : (USES[ir.kind] as Use)(ir as never, at)
}

/** The C# type of `ir` in use position; what it hoists lands in `at.decls`. */
export function csTypeOf(ir: IRSchema, at: CsTypeContext): string {
	return use(ir, { ...at, depth: 0 })
}

/** The use positions inside the declaration of `name`. */
const memberOf =
	(name: string, at: CsTypeContext): Member =>
	(schema, fieldName) =>
		use(schema, { ...at, depth: 0, fieldName, parentName: name })

/** The top-level declaration of the type `name` (a C# name already) for `ir`, which `declares`. */
export function csTopLevel(name: string, ir: IRSchema, at: CsTypeContext): string {
	const member = memberOf(name, at)
	if (ir.kind === "scalar") return enumDecl(name, ir, at)
	if (ir.kind === "object") return recordDecl(name, ir.fields, member, at)
	if (ir.kind === "allOf") return recordDecl(name, fieldsOf(ir, at.names.resolve), member, at)
	const variant = (schema: IRSchema, key: string, base: string) => declare(schema, at, key, base)
	return unionDecl(name, ir as Of<"union">, { at, declare: variant, member })
}
