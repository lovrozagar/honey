/**
 * Java line breaking (bit 21 i7a): google-java-format 1.37's layout, ported, so every emitted statement and header is
 * GJF's canonical form at any name length, a name past the width included. The emitter builds nodes (layout-ast.ts),
 * never text it then re-lays: each function here takes nodes and gives the lines. The engine is layout-doc.ts
 * (GJF's Doc and DocBuilder), the visitor layout-visitor.ts, layout-dot.ts and layout-decl.ts (JavaInputAstVisitor),
 * and a long string literal is reflowed as StringWrapper reflows it (layout-strings.ts).
 */
import { type Annotation, type Declaration, type Expr, expr, type MethodHeader, type TypeHeader } from "./layout-ast.ts"
import { annotation, declareOne, method } from "./layout-decl.ts"
import { Builder } from "./layout-doc.ts"
import { wrapStrings } from "./layout-strings.ts"
import { typeDeclaration } from "./layout-types.ts"
import { Visitor } from "./layout-visitor.ts"

export {
	type Annotation,
	array,
	assign,
	bin,
	call,
	classOf,
	type Component,
	cond,
	type Declaration,
	type Expr,
	id,
	lambda,
	lit,
	type MethodHeader,
	newOf,
	param,
	ref,
	type TypeHeader,
} from "./layout-ast.ts"

/** The doc `build` writes, laid out at `indent` columns, its long literals reflowed, as its lines. */
function laid(indent: number, build: (v: Visitor) => void): string[] {
	const b = new Builder()
	build(new Visitor(b))
	return wrapStrings(b.laid(indent))
		.split("\n")
		.map((line) => line.trimEnd())
}

/** A statement the emitter writes; an `if` or a `for` ends at its `{`, a switch rule at its `;`. */
export type Statement =
	| { readonly k: "expr"; readonly expr: Expr }
	| { readonly k: "return"; readonly expr: Expr }
	| { readonly k: "throw"; readonly expr: Expr }
	| { readonly k: "local"; readonly decl: Declaration }
	| { readonly k: "if"; readonly cond: Expr }
	| { readonly k: "for"; readonly type: string; readonly name: string; readonly of: Expr }
	| { readonly k: "rule"; readonly label: Expr | null; readonly value: Expr }

const STATEMENTS: { readonly [K in Statement["k"]]: (v: Visitor, s: Extract<Statement, { k: K }>) => void } = {
	expr: (v, s) => {
		v.expr(s.expr)
		v.b.token(";")
	},
	for: (v, s) => {
		/* visitEnhancedForLoop: the variable declared with `:` before its iterable */
		v.b.open(0)
		v.b.token("for")
		v.b.space()
		v.b.token("(")
		v.b.open(0)
		declareOne(v, { init: s.of, name: s.name, type: s.type }, { equals: ":", kind: "variable" })
		v.b.close()
		v.b.token(")")
		v.b.close()
		v.b.space()
		v.b.token("{")
	},
	if: (v, s) => {
		v.b.open(0)
		v.b.token("if")
		v.b.space()
		v.b.token("(")
		v.expr(s.cond)
		v.b.token(")")
		v.b.space()
		v.b.token("{")
		v.b.close()
	},
	local: (v, s) => declareOne(v, s.decl, { kind: "variable", trailing: ";" }),
	return: (v, s) => keyword(v, "return", s.expr),
	rule: (v, s) => {
		/* visitCase, a rule: `case label ->` or `default ->`, a unified break, the value at +4 */
		v.b.open(4)
		if (s.label === null) v.b.token("default")
		else {
			v.b.token("case")
			v.b.open(0)
			v.b.space()
			v.expr(s.label)
			v.b.close()
		}
		v.b.space()
		v.b.token("->")
		v.b.breakOp(" ")
		v.expr(s.value)
		v.b.close()
		v.b.token(";")
	},
	throw: (v, s) => keyword(v, "throw", s.expr),
}

/** visitReturn and visitThrow: the word, the expression after a space, `;`. */
function keyword(v: Visitor, word: string, e: Expr): void {
	v.b.token(word)
	v.b.space()
	v.expr(e)
	v.b.token(";")
}

/** `s`'s lines at `indent` columns, as google-java-format lays them out. */
export const statement = (indent: number, s: Statement): string[] =>
	laid(indent, (v) => (STATEMENTS[s.k] as (v: Visitor, s: Statement) => void)(v, s))

/** Shorthands for the statements. */
export const exprStmt = (e: Expr): Statement => ({ expr: e, k: "expr" })
export const returnStmt = (e: Expr | string): Statement => ({ expr: expr(e), k: "return" })
export const throwStmt = (e: Expr): Statement => ({ expr: e, k: "throw" })
export const local = (decl: Declaration): Statement => ({ decl, k: "local" })
export const ifOpen = (test: Expr): Statement => ({ cond: test, k: "if" })
export const forOpen = (of: string, name: string, iterable: Expr): Statement => ({
	k: "for",
	name,
	of: iterable,
	type: of,
})
export const rule = (label: Expr | null, value: Expr): Statement => ({ k: "rule", label, value })

/** A field declaration at `indent`. */
export const field = (indent: number, d: Declaration): string[] =>
	laid(indent, (v) => declareOne(v, d, { kind: "variable", trailing: ";" }))

/** A method's or constructor's header at `indent`, through its ` {`. */
export const methodHeader = (indent: number, m: MethodHeader): string[] => laid(indent, (v) => method(v, m))

/** A single annotation on its own line at `indent`. */
export const annotationLine = (indent: number, a: Annotation): string[] => laid(indent, (v) => annotation(v, a))

/** An enum constant at `indent`: its name, and its argument as addArguments lays it; `trailing` closes it. */
export const enumConstant = (indent: number, name: string, arg: Expr | string, trailing: string) =>
	laid(indent, (v) => {
		v.b.token(name)
		v.args([expr(arg)], 4)
		v.b.token(trailing)
	})

/** A type declaration's header at `indent`, through its `{` (or `{}`). */
export const typeHeader = (indent: number, h: TypeHeader): string[] => laid(indent, (v) => typeDeclaration(v, h))

/** A class's header: `public final class Name {`. */
export const classHeader = (name: string) =>
	typeHeader(0, { end: "{", kind: "class", modifiers: ["public", "final"], name })

/** `private final Type name;`. */
export const finalField = (of: string, name: string) => field(2, { modifiers: ["private", "final"], name, type: of })

/** An accessor: `public Type name() { return name; }`. */
export const accessor = (of: string, name: string) => [
	...methodHeader(2, { modifiers: ["public"], name, params: [], returns: of }),
	...statement(4, returnStmt(name)),
	"  }",
]
