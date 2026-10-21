/**
 * Java types from the IR alone (bit 16 phase b, B2, B3, B4): the type at a use position, a component's top-level
 * declaration, and what both hoist into the context: an enum, a record for every inline object, a union's wrappers. A
 * use position is a reference type, since generics take one; a component that declares nothing is its use type. A
 * type name is reserved where it collides (models-names.ts).
 */
import type { IR, IRSchema } from "../../ir/model.ts"
import { pascalWords, javaTypeName } from "../shared/lang.ts"
import { enumDecl, enumValues } from "./models-enum.ts"
import { fieldsOf, isOpen, recordDecl } from "./models-record.ts"
import { javaNames, JSON_NODE, type JavaTypeNames } from "./models-names.ts"
import { isLiteral, unionDecl } from "./models-union.ts"

export type { JavaTypeNames } from "./models-names.ts"

/** Where a type is being written, the declarations it hoists, and the names. */
export type JavaTypeContext = {
	parentName: string
	fieldName: string
	/** the path from the parent's field to here, `[]` per array item, so no two inline objects share a key */
	path: string
	decls: Map<string, string>
	names: JavaTypeNames
}

/** The Java type of `schema` at the member `fieldName` of the declaration being written. */
export type Member = (schema: IRSchema, fieldName: string) => string

type At = JavaTypeContext & { depth: number }

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>

/* deeper than this, a schema is any JSON value */
const MAX_DEPTH = 12

const SCALARS: Readonly<Record<Of<"scalar">["type"], string>> = {
	boolean: "Boolean",
	integer: "Long",
	null: JSON_NODE,
	number: "Double",
	string: "String",
}

/** A context over `ir`'s components, with `taken` reserved besides (the client's and the runtime's own names). */
export function javaTypeContext(ir: IR, taken: readonly string[] = []): JavaTypeContext {
	return { decls: new Map(), fieldName: "", names: javaNames(ir.schemas, taken, declares), parentName: "", path: "" }
}

/** Whether Java declares a type for a component of `ir`: an enum, a record, a discriminated or const-string union. */
export function declares(ir: IRSchema): boolean {
	if (ir.kind === "scalar") return enumValues(ir).length > 0
	if (ir.kind === "object") return ir.fields.length > 0 || ir.additional === false
	if (ir.kind === "allOf") return ir.parts.length > 0 && ir.parts.every((p) => p.kind === "object" || p.kind === "ref")
	if (ir.kind !== "union" || ir.variants.length === 0) return false
	return ir.discriminator !== undefined || ir.variants.every(isLiteral)
}

/** `ir` declared once as `names.hoist(key, base)` into `at.decls`; its name. */
function declare(ir: IRSchema, at: JavaTypeContext, key: string, base: string): string {
	const name = at.names.hoist(key, base)
	if (!at.decls.has(name)) {
		/* claimed before its body: what the body hoists in turn comes after it */
		at.decls.set(name, "")
		at.decls.set(name, javaTopLevel(name, ir, at))
	}
	return name
}

/** `ir` hoisted as `<Parent><Field>`. */
const hoist = (ir: IRSchema, at: At) =>
	declare(
		ir,
		at,
		`${at.parentName}.${at.path}${at.fieldName}`,
		`${javaTypeName(at.parentName)}${pascalWords(at.fieldName)}`,
	)

const deeper = (at: At, fieldName = at.fieldName, path = ""): At => ({
	...at,
	depth: at.depth + 1,
	fieldName,
	path: at.path + path,
})

/** A const's Java type: its value's, a declared `number` making an integral value double. */
function constType({ type, value }: Of<"const">): string {
	if (typeof value === "number") return type === "number" || !Number.isInteger(value) ? "Double" : "Long"
	return typeof value === "boolean" ? "Boolean" : "String"
}

/** An object's use: a hoisted record when it has fields, a map of its additional values, else a map of any value. */
function objectUse(ir: Of<"object">, at: At): string {
	if (ir.fields.length > 0) return hoist(ir, at)
	if (ir.additional) return `Map<String, ${use(ir.additional, deeper(at))}>`
	return ir.additional === false ? JSON_NODE : `Map<String, ${JSON_NODE}>`
}

/** An allOf of one part is that part; of more, its first ref (the rest is not typed here), else any JSON value. */
function allOfUse(ir: Of<"allOf">, at: At): string {
	const part = ir.parts.length === 1 ? ir.parts[0] : ir.parts.find((p) => p.kind === "ref")
	return part === undefined ? JSON_NODE : use(part, at)
}

/** A declared component's name, or the use type of one that declares nothing. */
function refUse(ir: Of<"ref">, at: At): string {
	const aliased = at.names.alias(ir.name)
	return aliased === undefined ? at.names.ref(ir.name) : use(aliased, deeper(at))
}

/** The Java type of `ir` in use position; what it hoists lands in `at.decls`. */
function use(ir: IRSchema, at: At): string {
	if (at.depth > MAX_DEPTH) return JSON_NODE
	switch (ir.kind) {
		case "allOf":
			return allOfUse(ir, at)
		case "array":
			return `List<${use(ir.items, deeper(at, `${at.fieldName}Item`, "[]"))}>`
		case "binary":
			return "String"
		case "const":
			return constType(ir)
		case "nullable":
			return use(ir.inner, deeper(at))
		case "object":
			return objectUse(ir, at)
		case "ref":
			return refUse(ir, at)
		case "scalar":
			return enumValues(ir).length > 0 ? hoist(ir, at) : SCALARS[ir.type]
		case "tuple":
			return `List<${JSON_NODE}>`
		/* a union in use position is any JSON value; a component union is declared */
		case "union":
		case "unknown":
			return JSON_NODE
	}
}

/** The Java type of `ir` at a use position of `at`. */
export function javaTypeOf(ir: IRSchema, at: JavaTypeContext): string {
	return use(ir, { ...at, depth: 0, path: "" })
}

/** The top-level declaration of the type `name` (a Java name already) for `ir`, which `declares`. */
export function javaTopLevel(name: string, ir: IRSchema, ctx: JavaTypeContext): string {
	const member: Member = (schema, fieldName) => javaTypeOf(schema, { ...ctx, fieldName, parentName: name })
	if (ir.kind === "scalar") return enumDecl(name, ir)
	const open = isOpen(ir, ctx.names.resolve)
	if (ir.kind === "object") return recordDecl(name, { fields: ir.fields, open }, member, ctx)
	if (ir.kind === "allOf") return recordDecl(name, { fields: fieldsOf(ir, ctx.names.resolve), open }, member, ctx)
	const declareVariant = (schema: IRSchema, key: string, base: string) => declare(schema, ctx, key, base)
	return unionDecl(name, ir as Of<"union">, { at: ctx, declare: declareVariant, member })
}
