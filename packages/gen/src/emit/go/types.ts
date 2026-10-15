/**
 * Go types from the IR (v0 go-type-emitter's IR path): the type at a use position, a component's
 * top-level declaration, and the declarations both hoist into the context — enum types with their
 * constants, and a named struct for every inline object. Spec text reaches the source only through
 * the shared escape layer.
 */
import type { IR, IRField, IRScalarType, IRSchema } from "../../ir/model.ts"
import { goString } from "../shared/escape.ts"
import { compareCodeUnits, goExported, NameScope } from "../shared/lang.ts"
import { irNames, plainNames } from "./types-names.ts"
import { isNilable } from "./types-codec.ts"
import { isTagName, type StructField, structDecl } from "./types-struct.ts"
import { unionDecl } from "./types-union.ts"

/** Package-level naming shared by every type one SDK declares. */
export type GoTypeNames = {
	/** the Go type name of the component `schema` */
	ref(schema: string): string
	/** a unique package-level name for a hoisted declaration; one key always gets the same name */
	hoist(key: string, base: string): string
	/** a unique package-level name for a constant */
	claimConst(base: string): string
	/** the components that reach themselves by value: a reference to one is a pointer */
	cyclic: ReadonlySet<string>
	resolve(schema: IRSchema): IRSchema
}

/** Where a type is used: the field `fieldName` of `parentName`; hoisted declarations land in `decls` by name. */
export type GoTypeContext = { parentName: string; fieldName: string; decls: Map<string, string>; names: GoTypeNames }

/** A use position inside the walk: how deep it is, and the type being declared (a reference back to it is a pointer). */
type At = GoTypeContext & { depth: number; self?: string }

type Of<K extends IRSchema["kind"]> = Extract<IRSchema, { kind: K }>

const RAW = "json.RawMessage"
/* deeper than this, a schema is raw JSON */
const MAX_DEPTH = 12

const SCALARS: Readonly<Record<IRScalarType, string>> = {
	boolean: "bool",
	integer: "int64",
	null: RAW,
	number: "float64",
	string: "string",
}

/** A fresh context; with `ir`, its names are claimed against the runtime and the IR's components. */
export function goTypeContext(ir?: IR): GoTypeContext {
	return { decls: new Map(), fieldName: "", names: ir ? irNames(ir) : plainNames(), parentName: "" }
}

/** `ir` declared once as `names.hoist(key, base)` into `at.decls`; its name. */
function declare(ir: IRSchema, at: GoTypeContext, key: string, base: string): string {
	const name = at.names.hoist(key, base)
	if (!at.decls.has(name)) {
		/* claimed before its body: what the body hoists in turn comes after it */
		at.decls.set(name, "")
		at.decls.set(name, goTopLevel(name, ir, at))
	}
	return name
}

/** `ir` hoisted as `<Parent><Field>`. */
const hoist = (ir: IRSchema, at: At) =>
	declare(ir, at, `${at.parentName}.${at.fieldName}`, `${goExported(at.parentName)}${goExported(at.fieldName)}`)

const deeper = (at: At, fieldName = at.fieldName): At => ({ ...at, depth: at.depth + 1, fieldName })

/** A slice or map element: it already breaks a cycle, so a ref in it needs no pointer. */
const element = (item: IRSchema, type: string) => (item.kind === "ref" && type.startsWith("*") ? type.slice(1) : type)

function objectUse(ir: Of<"object">, at: At): string {
	if (ir.fields.length > 0) return hoist(ir, at)
	if (ir.additional) return `map[string]${element(ir.additional, use(ir.additional, deeper(at)))}`
	return ir.additional === false ? "struct{}" : "map[string]interface{}"
}

function allOfUse(ir: Of<"allOf">, at: At): string {
	if (ir.parts.length > 1) return hoist(ir, at)
	return ir.parts[0] === undefined ? RAW : use(ir.parts[0], at)
}

function nullableUse(ir: Of<"nullable">, at: At): string {
	const inner = use(ir.inner, deeper(at))
	return isNilable(inner) ? inner : `*${inner}`
}

function refUse(ir: Of<"ref">, at: At): string {
	const name = at.names.ref(ir.name)
	return name === at.self || at.names.cyclic.has(ir.name) ? `*${name}` : name
}

/** Whether a scalar is a string or integer enum: a named type with one constant per value. */
const isEnum = (ir: Of<"scalar">) => ir.enum !== undefined && (ir.type === "string" || ir.type === "integer")

/** A const's Go type: its value's, a declared `number` making an integral value float64. */
const constType = ({ type, value }: Of<"const">) => {
	if (typeof value === "number") return type === "number" || !Number.isInteger(value) ? "float64" : "int64"
	return typeof value === "boolean" ? "bool" : "string"
}

type Use = (ir: never, at: At) => string

const USES: Readonly<{ [K in IRSchema["kind"]]: (ir: Of<K>, at: At) => string }> = {
	allOf: allOfUse,
	array: (ir, at) => `[]${element(ir.items, use(ir.items, deeper(at, `${at.fieldName}Item`)))}`,
	binary: () => "string",
	const: constType,
	nullable: nullableUse,
	object: objectUse,
	ref: refUse,
	scalar: (ir, at) => (isEnum(ir) ? hoist(ir, at) : SCALARS[ir.type]),
	tuple: (ir) => `[${ir.items.length}]interface{}`,
	/* Go has no union type */
	union: () => RAW,
	unknown: () => RAW,
}

function use(ir: IRSchema, at: At): string {
	return at.depth > MAX_DEPTH ? RAW : (USES[ir.kind] as Use)(ir as never, at)
}

/** The Go type of `ir` at a use position (v0 irRenderUse); what it hoists lands in `at.decls`. */
export function goTypeOf(ir: IRSchema, at: GoTypeContext): string {
	return use(ir, { ...at, depth: 0 })
}

/** A label for an enum value inside a constant name: `""` is `Empty`, a negative number `Neg<n>`. */
function enumLabel(value: boolean | number | string): string {
	if (typeof value === "number") return `${value < 0 ? "Neg" : ""}${String(Math.abs(value)).replace(/\W/g, "_")}`
	return value === "" ? "Empty" : goExported(String(value))
}

/** `type <name> string|int` and one `<name><Label>` constant per value of its kind. */
function enumDecl(name: string, ir: Of<"scalar">, names: GoTypeNames): string {
	const integer = ir.type === "integer"
	/* a value of the other kind (or a null) has no constant */
	const values = (ir.enum as (boolean | number | string)[]).filter((value) =>
		integer ? Number.isInteger(value) : (value as unknown) !== null,
	)
	const labels = new NameScope()
	const consts = values.map((value) => {
		const constName = names.claimConst(labels.claim(`${name}${enumLabel(value)}`))
		return `\t${constName} ${name} = ${integer ? String(value) : goString(String(value))}`
	})
	return [`type ${name} ${integer ? "int" : "string"}`, "const (", ...consts, ")"].join("\n")
}

function constDecl(name: string, ir: Of<"const">, names: GoTypeNames): string {
	const literal = typeof ir.value === "string" ? goString(ir.value) : String(ir.value)
	return [`type ${name} ${constType(ir)}`, `const ${names.claimConst(`${name}Value`)} ${name} = ${literal}`].join("\n")
}

const byKey = (a: IRField, b: IRField) => compareCodeUnits(a.name, b.name)

/** A struct field for `field`: optional is `*T` omitempty, optional and nullable `Nullable[T]` omitzero. */
function structField(field: IRField, goName: string, at: At): StructField {
	const triState = !field.required && field.schema.kind === "nullable"
	const rendered = use(triState ? (field.schema as Of<"nullable">).inner : field.schema, at)
	const type = triState ? `Nullable[${rendered}]` : field.required || isNilable(rendered) ? rendered : `*${rendered}`
	return { goName, key: field.name, required: field.required, tagged: isTagName(field.name), triState, type }
}

/** The use position of field `fieldName` in the declaration of `name`. */
const member = (name: string, at: GoTypeContext, fieldName: string): At => ({
	...at,
	depth: 0,
	fieldName,
	parentName: name,
	self: name,
})

/** A struct of the object's fields in key order, and an `Extra` map when it admits more keys. */
function objectDecl(name: string, ir: Of<"object">, at: GoTypeContext): string {
	const scope = new NameScope(["UnmarshalJSON", "MarshalJSON"])
	const extraName = ir.additional ? scope.claim("Extra") : ""
	const fields = [...ir.fields]
		.sort(byKey)
		.map((field) => structField(field, scope.claim(goExported(field.name)), member(name, at, field.name)))
	const extra = ir.additional
		? { goName: extraName, valueType: use(ir.additional, member(name, at, "Extra")) }
		: undefined
	return structDecl(name, { embeds: [], extra, fields })
}

/* the kinds a required field may render as a slice or a map, whose nil a MarshalJSON fills */
const SLICE_OR_MAP: readonly IRSchema["kind"][] = ["allOf", "array", "nullable", "object"]

/** A field encoding/json handles alone: a key a tag can name, never a required slice or map. */
const plainField = (field: IRField) =>
	isTagName(field.name) && !(field.required && SLICE_OR_MAP.includes(field.schema.kind))

/**
 * Whether the type of an allOf's ref part may have its own (un)marshal methods, which embedding
 * would promote over the outer struct's fields. Only a plain object is known not to; a ref the
 * names cannot resolve declares no type here.
 */
function encodesItself(part: Of<"ref">, names: GoTypeNames): boolean {
	const ir = names.resolve(part)
	return ir.kind !== "ref" && !(ir.kind === "object" && !ir.additional && ir.fields.every(plainField))
}

/** A struct embedding each ref part, with every object part's fields inlined (a key once, its first part's). */
function allOfDecl(name: string, ir: Of<"allOf">, at: GoTypeContext): string {
	const scope = new NameScope(["UnmarshalJSON", "MarshalJSON"])
	const refs = ir.parts.filter((part): part is Of<"ref"> => part.kind === "ref")
	for (const part of refs) scope.reserve(at.names.ref(part.name))
	const embeds = refs.map((part) => use(part, member(name, at, part.name)))
	const fields = ir.parts
		.flatMap((part) => (part.kind === "object" ? [...part.fields].sort(byKey) : []))
		.filter((field, i, all) => all.findIndex((first) => first.name === field.name) === i)
		.map((field) => structField(field, scope.claim(goExported(field.name)), member(name, at, field.name)))
	return structDecl(name, { embeds, embedsEncode: refs.some((part) => encodesItself(part, at.names)), fields })
}

/** The top-level declaration of the type `name` (a Go identifier already) for `ir` (v0 irRenderTopLevel). */
export function goTopLevel(name: string, ir: IRSchema, at: GoTypeContext): string {
	if (ir.kind === "scalar" && isEnum(ir)) return enumDecl(name, ir, at.names)
	if (ir.kind === "const") return constDecl(name, ir, at.names)
	if (ir.kind === "allOf") return allOfDecl(name, ir, at)
	if (ir.kind === "object" && ir.fields.length > 0) return objectDecl(name, ir, at)
	if (ir.kind === "union" && ir.discriminator) {
		const variant = (schema: IRSchema, key: string, base: string) => declare(schema, at, key, base)
		return unionDecl(name, { ...ir, discriminator: ir.discriminator }, at.names, variant)
	}
	/* a map or an empty struct is a named type; anything else an alias */
	return `type ${name} ${ir.kind === "object" ? "" : "= "}${use(ir, member(name, at, "Value"))}`
}
