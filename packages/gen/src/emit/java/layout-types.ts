/**
 * google-java-format's type declaration headers, ported (bit 21 i7a; JavaInputAstVisitor): an enum's
 * (visitEnumDeclaration: `enum` and a unified break before the name at +4), a record's (visitRecordDeclaration: its
 * components as formals, then `implements`) and a class's or interface's (visitClassDeclaration: `extends`,
 * `implements`, `permits`, each classDeclarationTypeList). The annotations go each on its own line, the modifiers
 * before an independent break.
 */
import { type TypeHeader, type } from "./layout-ast.ts"
import { annotation, declareOne } from "./layout-decl.ts"
import type { Visitor } from "./layout-visitor.ts"

/** typeDeclarationModifiers: each annotation on its own line, then the modifiers and an independent break. */
function typeModifiers(v: Visitor, h: TypeHeader): void {
	for (const a of h.annotations ?? []) {
		annotation(v, a)
		v.b.forced()
	}
	const words = h.modifiers ?? []
	if (words.length === 0) return
	v.b.open(0)
	words.forEach((word, i) => {
		if (i > 0) v.b.breakFill()
		v.b.token(word)
	})
	v.b.close()
	v.b.breakFill()
}

/** `word` and `types`, comma-separated, unified breaks between them. */
function typeList(v: Visitor, word: string, types: readonly string[], fill: "unified" | "independent" = "unified") {
	v.b.token(word)
	types.forEach((t, i) => {
		if (i === 0) v.b.space()
		else {
			v.b.token(",")
			v.b.brk(fill, " ")
		}
		v.type(type(t))
	})
}

/** visitEnumDeclaration's header: a level of its own, `enum` and a unified break before the name at +4. */
function enumHeader(v: Visitor, h: TypeHeader): void {
	v.b.open(0)
	typeModifiers(v, h)
	v.b.open(4)
	v.b.token("enum")
	v.b.breakOp(" ")
	v.b.token(h.name)
	v.b.close()
	v.b.close()
	const impls = h.implements ?? []
	if (impls.length > 0) {
		v.b.open(4)
		v.b.breakOp(" ")
		v.b.open(4)
		v.b.token("implements")
		v.b.breakOp(" ")
		v.b.open(0)
		impls.forEach((t, i) => {
			if (i > 0) {
				v.b.token(",")
				v.b.breakToFill(" ")
			}
			v.type(type(t))
		})
		v.b.close()
		v.b.close()
		v.b.close()
	}
}

/** typeParametersRest after `<`, at `indent`. */
function typeParams(v: Visitor, params: readonly string[], indent: number): void {
	v.b.open(indent)
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

/** visitRecordDeclaration's components and implements, inside its +4 level. */
function recordRest(v: Visitor, h: TypeHeader): void {
	const components = h.components ?? []
	v.b.token("(")
	if (components.length > 0) {
		v.b.breakToFill("")
		v.b.open(0)
		components.forEach((c, i) => {
			if (i > 0) v.b.breakOp(" ")
			declareOne(v, c, { kind: "parameter", trailing: i < components.length - 1 ? "," : "" })
		})
		v.b.close()
	}
	v.b.token(")")
	const impls = h.implements ?? []
	if (impls.length === 0) return
	v.b.breakToFill(" ")
	v.b.open(impls.length > 1 ? 4 : 0)
	typeList(v, "implements", impls)
	v.b.close()
}

/** visitClassDeclaration's extends, implements and permits (classDeclarationTypeList), inside its +4 level. */
function classRest(v: Visitor, h: TypeHeader): void {
	if (h.extends !== undefined) {
		v.b.breakToFill(" ")
		typeList(v, "extends", [h.extends])
	}
	for (const [word, types] of [
		[h.kind === "interface" ? "extends" : "implements", h.implements ?? []],
		["permits", h.permits ?? []],
	] as const) {
		if (types.length === 0) continue
		v.b.breakToFill(" ")
		v.b.open(types.length > 1 ? 4 : 0)
		typeList(v, word, types)
		v.b.close()
	}
}

/** A type declaration's header, through its `{` (or `{}`). */
export function typeDeclaration(v: Visitor, h: TypeHeader): void {
	if (h.kind === "enum") enumHeader(v, h)
	else {
		typeModifiers(v, h)
		v.b.token(h.kind)
		v.b.space()
		v.b.token(h.name)
		const params = h.typeParams ?? []
		const supers = h.extends !== undefined || (h.implements ?? []).length > 0 || (h.permits ?? []).length > 0
		if (params.length > 0) v.b.token("<")
		v.b.open(4)
		if (params.length > 0) typeParams(v, params, supers ? 4 : 0)
		if (h.kind === "record") recordRest(v, h)
		else classRest(v, h)
		v.b.close()
	}
	v.b.space()
	v.b.token(h.end)
}
