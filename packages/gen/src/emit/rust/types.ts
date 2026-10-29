/**
 * Rust types from the IR alone (H2): the type at a use position, a component's top-level
 * declaration, and the declarations both hoist into the context — a string or integer enum, a struct
 * for every inline object, a string enum for a union's const strings. Spec text reaches the source
 * only through the shared escape layer.
 */
import type { IR, IRSchema } from "../../ir/model.ts"
import { pascalWords, rustTypeIdent } from "../shared/lang.ts"
import { integerValues, intEnumDecl, stringEnumDecl, stringValues } from "./types-enum.ts"
import { irNames, plainNames } from "./types-names.ts"
import { allOfDecl, DERIVE, type Member, objectDecl, unboxed } from "./types-struct.ts"
import { unionDecl } from "./types-union.ts"

/** How component and hoisted names are claimed, and which components sit on a value cycle. */
export type RustTypeNames = {
	/** the Rust type name of the component `name` */
	ref(name: string): string
	/** a unique crate-level name for a hoisted declaration; one key always gets the same name */
	hoist(key: string, base: string): string
	/** a unique crate-level name for any other declaration (a resource, an op's options) */
	claim(base: string): string
	/** the components that reach themselves by value: a reference to one is a `Box` */
	cyclic: ReadonlySet<string>
	/** each component emitted under another name than its own (`<Name>Model`), to its emitted name */
	renamed: ReadonlyMap<string, string>
	resolve(schema: IRSchema): IRSchema
}

/** Where a type is being written: its parent and field, the declarations it hoists, and the names. */
export type RustTypeContext = {
	parentName: string
	fieldName: string
	decls: Map<string, string>
	names: RustTypeNames
}

/** A use position inside the walk: how deep it is, and the type being declared (a reference back to it is boxed). */
type At = RustTypeContext & { depth: number; self?: string }

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>

const VALUE = "serde_json::Value"
const MAP = "std::collections::HashMap"
/* deeper than this, a schema is any JSON value */
const MAX_DEPTH = 12

const SCALARS: Readonly<Record<Of<"scalar">["type"], string>> = {
	boolean: "bool",
	integer: "i64",
	null: VALUE,
	number: "f64",
	string: "String",
}

/** A context over `ir`'s components, or plain names without one. */
export function rustTypeContext(ir?: IR): RustTypeContext {
	return { decls: new Map(), fieldName: "", names: ir ? irNames(ir) : plainNames(), parentName: "" }
}

/** `ir` declared once as `names.hoist(key, base)` into `at.decls`; its name. */
function declare(ir: IRSchema, at: RustTypeContext, key: string, base: string): string {
	const name = at.names.hoist(key, base)
	if (!at.decls.has(name)) {
		/* claimed before its body: what the body hoists in turn comes after it */
		at.decls.set(name, "")
		at.decls.set(name, rustTopLevel(name, ir, at))
	}
	return name
}

/** `ir` hoisted as `<Parent><Field>`. */
const hoist = (ir: IRSchema, at: At) =>
	declare(ir, at, `${at.parentName}.${at.fieldName}`, `${rustTypeIdent(at.parentName)}${pascalWords(at.fieldName)}`)

const deeper = (at: At, fieldName = at.fieldName): At => ({ ...at, depth: at.depth + 1, fieldName })

/** Whether a scalar is a string or integer enum with a value of its kind: a declared enum. */
const isEnum = (ir: Of<"scalar">) =>
	ir.enum !== undefined &&
	(ir.type === "string" ? stringValues(ir.enum).length > 0 : ir.type === "integer" && integerValues(ir.enum).length > 0)

/** A const's Rust type: its value's, a declared `number` making an integral value f64. */
function constType({ type, value }: Of<"const">): string {
	if (typeof value === "number") return type === "number" || !Number.isInteger(value) ? "f64" : "i64"
	return typeof value === "boolean" ? "bool" : "String"
}

function objectUse(ir: Of<"object">, at: At): string {
	if (ir.fields.length > 0) return hoist(ir, at)
	if (ir.additional) return `${MAP}<String, ${unboxed(ir.additional, use(ir.additional, deeper(at)))}>`
	return ir.additional === false ? VALUE : `${MAP}<String, ${VALUE}>`
}

/** An allOf of one part is that part; of more, its first ref (the rest is not typed here), else any JSON value. */
function allOfUse(ir: Of<"allOf">, at: At): string {
	const part = ir.parts.length === 1 ? ir.parts[0] : ir.parts.find((p) => p.kind === "ref")
	return part === undefined ? VALUE : use(part, at)
}

function nullableUse(ir: Of<"nullable">, at: At): string {
	const inner = use(ir.inner, deeper(at))
	return inner === VALUE ? VALUE : `Option<${inner}>`
}

function refUse(ir: Of<"ref">, at: At): string {
	const name = at.names.ref(ir.name)
	return name === at.self || at.names.cyclic.has(ir.name) ? `Box<${name}>` : name
}

type Use = (ir: never, at: At) => string

const USES: Readonly<{ [K in IRSchema["kind"]]: (ir: Of<K>, at: At) => string }> = {
	allOf: allOfUse,
	array: (ir, at) => `Vec<${unboxed(ir.items, use(ir.items, deeper(at, `${at.fieldName}Item`)))}>`,
	binary: () => "String",
	const: constType,
	nullable: nullableUse,
	object: objectUse,
	ref: refUse,
	scalar: (ir, at) => (isEnum(ir) ? hoist(ir, at) : SCALARS[ir.type]),
	tuple: () => `Vec<${VALUE}>`,
	/* a union in use position is any JSON value; a component union is declared as an enum */
	union: () => VALUE,
	unknown: () => VALUE,
}

function use(ir: IRSchema, at: At): string {
	return at.depth > MAX_DEPTH ? VALUE : (USES[ir.kind] as Use)(ir as never, at)
}

/** The Rust type of `ir` in use position; what it hoists lands in `at.decls`. */
export function rustTypeOf(ir: IRSchema, at: RustTypeContext): string {
	return use(ir, { ...at, depth: 0 })
}

/** The use positions inside the declaration of `name`. */
const memberOf =
	(name: string, at: RustTypeContext): Member =>
	(schema, fieldName) =>
		use(schema, { ...at, depth: 0, fieldName, parentName: name, self: name })

/** The top-level declaration of the type `name` (a Rust identifier already) for `ir`. */
export function rustTopLevel(name: string, ir: IRSchema, at: RustTypeContext): string {
	const member = memberOf(name, at)
	if (ir.kind === "scalar" && isEnum(ir)) {
		const values = ir.enum as NonNullable<typeof ir.enum>
		return ir.type === "string" ? stringEnumDecl(name, stringValues(values)) : intEnumDecl(name, integerValues(values))
	}
	if (ir.kind === "const") return [DERIVE, `pub struct ${name}(pub ${constType(ir)});`].join("\n")
	if (ir.kind === "allOf") return allOfDecl(name, ir, member, at.names.ref)
	/* a closed object without fields is a struct too: `{}` on the wire, where a map alias would admit any key */
	if (ir.kind === "object" && (ir.fields.length > 0 || ir.additional === false)) return objectDecl(name, ir, member)
	if (ir.kind === "union" && ir.variants.length > 0) {
		const variant = (schema: IRSchema, key: string, base: string) => declare(schema, at, key, base)
		return unionDecl(name, ir, { declare: variant, member, names: at.names })
	}
	return `pub type ${name} = ${member(ir, "Value")};`
}
