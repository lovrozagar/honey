/**
 * google-java-format's declarations, ported (bit 21 i7a; JavaInputAstVisitor): an annotation (visitAnnotation,
 * visitSingleMemberAnnotation), the modifiers (visitModifiers), one declaration (declareOne: an independent break
 * before the name, the initializer after `=` at +4 or +8 by whether the type broke) and a method's header (visitMethod,
 * visitFormals: the type and name scope, then the formals indented by whether the name or the type broke).
 */
import { type Annotation, type Declaration, type Expr, expr, type MethodHeader, type } from "./layout-ast.ts"
import { ifTaken, type Tag } from "./layout-doc.ts"
import type { Visitor } from "./layout-visitor.ts"

/** One annotation argument: `key = value`, its value an array initializer kept on the key's line. */
function keyed(v: Visitor, key: string, raw: Expr | string): void {
	const value = expr(raw)
	const isArray = value.k === "array"
	v.b.open(isArray ? 0 : 4)
	v.b.token(key)
	v.b.space()
	v.b.token("=")
	if (isArray) v.b.space()
	else v.b.breakOp(" ")
	v.expr(value)
	v.b.close()
}

/** visitAnnotation and visitSingleMemberAnnotation. */
export function annotation(v: Visitor, a: Annotation): void {
	const args = a.args ?? []
	const only = args[0]
	if (args.length === 1 && !Array.isArray(only)) {
		const value = expr(only as Expr | string)
		const isArray = value.k === "array"
		v.b.open(isArray ? 0 : 4)
		v.b.token("@")
		v.typeName(a.name)
		v.b.token("(")
		if (!isArray) v.b.breakOp()
		v.expr(value)
		v.b.close()
		v.b.token(")")
		return
	}
	v.b.open(0)
	v.b.token("@")
	v.typeName(a.name)
	if (args.length > 0) {
		v.b.open(4)
		v.b.token("(")
		v.b.breakOp()
		args.forEach((arg, i) => {
			if (i > 0) {
				v.b.token(",")
				v.b.breakOp(" ")
			}
			if (Array.isArray(arg)) keyed(v, ...(arg as readonly [string, Expr | string]))
			else v.expr(expr(arg as Expr | string))
		})
		v.b.token(")")
		v.b.close()
	}
	v.b.close()
}

/**
 * visitModifiers: the declaration annotations (forced apart when vertical, else unified breaks), then the modifiers,
 * each pair and the last one followed by an independent break of its own.
 */
export function modifiers(
	v: Visitor,
	annotations: readonly Annotation[],
	words: readonly string[],
	vertical: boolean,
): void {
	if (annotations.length === 0 && words.length === 0) return
	const apart = () => (vertical ? v.b.forced() : v.b.breakOp(" "))
	v.b.open(0)
	annotations.forEach((a, i) => {
		if (i > 0) apart()
		annotation(v, a)
	})
	v.b.close()
	if (words.length === 0) return apart()
	if (annotations.length > 0) apart()
	v.b.open(0)
	words.forEach((word, i) => {
		if (i > 0) v.b.breakFill()
		v.b.token(word)
	})
	v.b.close()
	v.b.breakFill()
}

/** declareOne: modifiers, the type, an independent break before the name, `equals` and the initializer. */
/** A declaration's place: a field, a parameter or a local; the token closing it; the token before its initializer. */
export type Place = {
	readonly kind: "field" | "parameter" | "none"
	readonly trailing?: string
	readonly equals?: string
}

export function declareOne(v: Visitor, d: Declaration, { equals = "=", kind, trailing = "" }: Place): void {
	const annotations = d.annotations ?? []
	const vertical = kind !== "parameter" && annotations.some((a) => (a.args ?? []).length > 0)
	const typeBreak: Tag = { taken: false }
	const hasType = d.type !== ""
	v.b.open(kind === "parameter" && annotations.length > 0 ? 4 : 0)
	modifiers(v, annotations, d.modifiers ?? [], vertical)
	v.b.open(hasType ? 4 : 0)
	v.b.open(0)
	v.b.open(0)
	if (hasType) v.type(type(d.type))
	v.b.close()
	if (hasType) v.b.brk("independent", " ", 0, typeBreak)
	v.b.open(ifTaken(typeBreak, 4))
	v.b.token(d.name)
	v.b.close()
	v.b.close()
	if (d.init !== undefined) initializer(v, expr(d.init), equals, typeBreak)
	if (trailing !== "") v.b.token(trailing)
	v.b.close()
	v.b.close()
}

/** ` = init`: a bare array initializer on the `=`'s line, anything else after an independent break. */
function initializer(v: Visitor, init: Expr, equals: string, typeBreak: Tag): void {
	v.b.space()
	v.b.token(equals)
	if (init.k === "array" && init.type === null) {
		v.b.open(-4)
		v.b.space()
		v.expr(init)
	} else {
		v.b.open(ifTaken(typeBreak, 4))
		v.b.breakToFill(" ")
		v.expr(init)
	}
	v.b.close()
}

/** visitMethod: vertical annotations, modifiers, the type and name scope, then the formals and the throws. */
export function method(v: Visitor, m: MethodHeader): void {
	modifiers(v, m.annotations ?? [], m.modifiers ?? [], true)
	v.b.open(4)
	const beforeName: Tag = { taken: false }
	const beforeType: Tag = { taken: false }
	nameScope(v, m, beforeName, beforeType)
	v.b.open(ifTaken(beforeName, 4))
	v.b.open(ifTaken(beforeType, 4))
	v.b.open(0)
	formals(v, m)
	v.b.close()
	v.b.close()
	v.b.close()
	if (m.end === ";") v.b.token(";")
	else {
		v.b.space()
		v.b.token(m.end)
	}
	v.b.close()
}

/** The type parameters, the return type and the name with its `(`, each break before them tagged. */
function nameScope(v: Visitor, m: MethodHeader, beforeName: Tag, beforeType: Tag): void {
	v.b.open(0)
	const params = m.typeParams ?? []
	let afterFirst = params.length > 0
	if (afterFirst) {
		v.b.token("<")
		v.b.open(4)
		v.b.breakOp()
		v.b.open(0)
		params.forEach((p, i) => {
			if (i > 0) {
				v.b.token(",")
				v.b.breakOp(" ")
			}
			v.b.token(p)
		})
		v.b.token(">")
		v.b.close()
		v.b.close()
	}
	const returns = m.returns
	if (returns !== undefined) {
		if (afterFirst) v.b.brk("independent", " ", 0, beforeType)
		afterFirst = true
		v.b.open(ifTaken(beforeType, 4))
		v.b.open(0)
		v.type(type(returns))
		v.b.close()
	}
	if (afterFirst) v.b.brk("independent", " ", 0, beforeName)
	/* a constructor's name scope opens after the break before its name */
	if (returns === undefined) v.b.open(0)
	v.b.token(m.name)
	v.b.token("(")
	v.b.close()
	v.b.close()
}

/** visitFormals and the throws clause: the parameters after a fill break, `)`, `throws` and its types. */
function formals(v: Visitor, m: MethodHeader): void {
	if (m.params.length > 0) {
		v.b.breakToFill("")
		v.b.open(0)
		m.params.forEach((p, i) => {
			if (i > 0) v.b.breakOp(" ")
			declareOne(v, p, { kind: "parameter", trailing: i < m.params.length - 1 ? "," : "" })
		})
		v.b.close()
	}
	v.b.token(")")
	const thrown = m.throws ?? []
	if (thrown.length === 0) return
	v.b.breakToFill(" ")
	v.b.open(4)
	v.b.token("throws")
	v.b.breakToFill(" ")
	thrown.forEach((t, i) => {
		if (i > 0) {
			v.b.token(",")
			v.b.breakOp(" ")
		}
		v.type(type(t))
	})
	v.b.close()
}
