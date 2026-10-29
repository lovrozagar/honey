/**
 * google-java-format's declarations, ported (bit 21 i7a; JavaInputAstVisitor): an annotation (visitAnnotation,
 * visitSingleMemberAnnotation), the modifiers (visitModifiers), one declaration (declareOne: an independent break
 * before the name, the initializer after `=` at +4 or +8 by whether the type broke) and a method's header (visitMethod,
 * visitFormals: the type and name scope, then the formals indented by whether the name broke).
 */
import {
	type Annotation,
	type Component,
	type Declaration,
	type Expr,
	expr,
	type MethodHeader,
	type,
} from "./layout-ast.ts"
import { ifTaken, type Tag } from "./layout-doc.ts"
import type { Visitor } from "./layout-visitor.ts"

/** visitAnnotation and visitSingleMemberAnnotation: `@Name`, `@Name(value)`, or `@Name(key = value)`. */
export function annotation(v: Visitor, a: Annotation): void {
	const [arg] = a.args ?? []
	if (arg !== undefined && !Array.isArray(arg)) {
		v.b.open(4)
		v.b.token("@")
		v.typeName(a.name)
		v.b.token("(")
		v.b.breakOp()
		v.expr(expr(arg as Expr | string))
		v.b.close()
		v.b.token(")")
		return
	}
	v.b.open(0)
	v.b.token("@")
	v.typeName(a.name)
	if (arg !== undefined) {
		const [key, value] = arg as readonly [string, Expr | string]
		v.b.open(4)
		v.b.token("(")
		v.b.breakOp()
		v.b.open(4)
		v.b.token(key)
		v.b.space()
		v.b.token("=")
		v.b.breakOp(" ")
		v.expr(expr(value))
		v.b.close()
		v.b.token(")")
		v.b.close()
	}
	v.b.close()
}

/**
 * visitModifiers: a component's annotations, unified breaks between and after them; or a declaration's modifiers,
 * each pair and the last one followed by an independent break of its own.
 */
function modifiers(v: Visitor, annotations: readonly Annotation[], words: readonly string[]): void {
	if (annotations.length > 0) {
		v.b.open(0)
		annotations.forEach((a, i) => {
			if (i > 0) v.b.breakOp(" ")
			annotation(v, a)
		})
		v.b.close()
		v.b.breakOp(" ")
	} else if (words.length > 0) {
		v.b.open(0)
		words.forEach((word, i) => {
			if (i > 0) v.b.breakFill()
			v.b.token(word)
		})
		v.b.close()
		v.b.breakFill()
	}
}

/** A declaration's place: a parameter (a component's annotations at +4) or a variable; the tokens closing it and before its initializer. */
export type Place = {
	readonly kind: "parameter" | "variable"
	readonly trailing?: string
	readonly equals?: string
}

/** declareOne: modifiers, the type, an independent break before the name, `equals` and the initializer. */
export function declareOne(v: Visitor, d: Declaration & Component, { equals = "=", kind, trailing = "" }: Place): void {
	const annotations = d.annotations ?? []
	const typeBreak: Tag = { taken: false }
	v.b.open(kind === "parameter" && annotations.length > 0 ? 4 : 0)
	modifiers(v, annotations, d.modifiers ?? [])
	v.b.open(4)
	v.b.open(0)
	v.b.open(0)
	v.type(type(d.type))
	v.b.close()
	v.b.brk("independent", " ", 0, typeBreak)
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

/** visitMethod: the modifiers, the type and name scope, then the formals, ` {`. */
export function method(v: Visitor, m: MethodHeader): void {
	modifiers(v, [], m.modifiers ?? [])
	v.b.open(4)
	const beforeName: Tag = { taken: false }
	nameScope(v, m, beforeName)
	v.b.open(ifTaken(beforeName, 4))
	v.b.open(0)
	v.b.open(0)
	formals(v, m)
	v.b.close()
	v.b.close()
	v.b.close()
	v.b.space()
	v.b.token("{")
	v.b.close()
}

/** The return type and the name with its `(`, the break before the name tagged. */
function nameScope(v: Visitor, m: MethodHeader, beforeName: Tag): void {
	v.b.open(0)
	if (m.returns !== undefined) {
		v.b.open(0)
		v.b.open(0)
		v.type(type(m.returns))
		v.b.close()
		v.b.brk("independent", " ", 0, beforeName)
	} else v.b.open(0) /* a constructor's name scope opens with its name */
	v.b.token(m.name)
	v.b.token("(")
	v.b.close()
	v.b.close()
}

/** visitFormals: the parameters after a fill break, then `)`. */
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
}
