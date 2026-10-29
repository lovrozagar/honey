/**
 * google-java-format's type declaration headers, ported (bit 21 i7a; JavaInputAstVisitor): an enum's
 * (visitEnumDeclaration: `enum` and a unified break before the name at +4), a record's (visitRecordDeclaration: its
 * components as formals, then `implements`) and a class's or interface's (visitClassDeclaration: `extends` or
 * `permits`, each classDeclarationTypeList). The annotations go each on its own line, the modifiers before an
 * independent break.
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
	v.b.open(0)
	h.modifiers.forEach((word, i) => {
		if (i > 0) v.b.breakFill()
		v.b.token(word)
	})
	v.b.close()
	v.b.breakFill()
}

/**
 * classDeclarationTypeList after an independent break: `word` and `types`, comma-separated, unified breaks between
 * them at +4 (a lone plain name has no break, so its level's indent never shows).
 */
function typeList(v: Visitor, word: string, types: readonly string[]): void {
	v.b.breakToFill(" ")
	v.b.open(4)
	v.b.token(word)
	types.forEach((t, i) => {
		if (i === 0) v.b.space()
		else {
			v.b.token(",")
			v.b.breakOp(" ")
		}
		v.type(type(t))
	})
	v.b.close()
}

/** A type declaration's header, through its `{` (or `{}`). */
export function typeDeclaration(v: Visitor, h: TypeHeader): void {
	if (h.kind === "enum") {
		/* visitEnumDeclaration's header: a level of its own, `enum` and a unified break before the name at +4 */
		v.b.open(0)
		typeModifiers(v, h)
		v.b.open(4)
		v.b.token("enum")
		v.b.breakOp(" ")
		v.b.token(h.name)
		v.b.close()
		v.b.close()
	} else {
		typeModifiers(v, h)
		v.b.token(h.kind)
		v.b.space()
		v.b.token(h.name)
		v.b.open(4)
		if (h.kind === "record") {
			/* visitRecordDeclaration's components as formals, then its interface */
			v.b.token("(")
			if (h.components.length > 0) {
				v.b.breakToFill("")
				v.b.open(0)
				h.components.forEach((c, i) => {
					if (i > 0) v.b.breakOp(" ")
					declareOne(v, c, { kind: "parameter", trailing: i < h.components.length - 1 ? "," : "" })
				})
				v.b.close()
			}
			v.b.token(")")
			if (h.implements !== undefined) typeList(v, "implements", [h.implements])
		} else if (h.kind === "class") {
			if (h.extends !== undefined) {
				/* classDeclarationTypeList of one superclass, in no level of its own */
				v.b.breakToFill(" ")
				v.b.token("extends")
				v.b.space()
				v.type(type(h.extends))
			}
		} else typeList(v, "permits", h.permits)
		v.b.close()
	}
	v.b.space()
	v.b.token(h.end)
}
