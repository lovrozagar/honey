/**
 * google-java-format's expression layouts, ported (bit 21 i7a; JavaInputAstVisitor): each expression the emitter
 * writes emits the ops GJF's visitor emits for it. Arguments (addArguments, argList, a format string's first argument
 * apart), `new`, array initializers, a lambda, a binary (its operands filled when all are short), a cast, an
 * assignment, a method reference, a conditional and a parameterized type; a dot chain is layout-dot.ts's.
 */
import { type Expr, flatText, id, type Of, type Type } from "./layout-ast.ts"
import type { Builder, Fill, Indent } from "./layout-doc.ts"
import { dot, type Emit } from "./layout-dot.ts"

/* hasOnlyShortItems: every item under MAX_ITEM_LENGTH_FOR_FILLING (10) characters */
const shortItems = (items: readonly Expr[]): boolean => items.every((item) => flatText(item).length < 10)

const isString = (e: Expr): boolean => e.k === "lit" && e.text.startsWith('"')

/** The ops of each expression, as GJF's visitor emits them. */
export class Visitor implements Emit {
	constructor(readonly b: Builder) {}

	private readonly kinds: { readonly [K in Expr["k"]]: (e: Of<K>) => void } = {
		array: (e) => this.newArray(e),
		assign: (e) => this.infix(e.to, "=", e.value),
		bin: (e) => this.binary(e),
		call: (e) => dot(this, e),
		cast: (e) => {
			this.b.open(4)
			this.b.token("(")
			this.type(e.type)
			this.b.token(")")
			this.b.breakOp(" ")
			this.expr(e.of)
			this.b.close()
		},
		cond: (e) => {
			this.b.open(4)
			this.expr(e.test)
			for (const [mark, arm] of [
				["?", e.yes],
				[":", e.no],
			] as const) {
				this.b.breakOp(" ")
				this.b.token(mark)
				this.b.space()
				this.expr(arm)
			}
			this.b.close()
		},
		id: (e) => this.b.token(e.name),
		lambda: (e) => this.lambda(e),
		lit: (e) => this.b.literal(e.text),
		new: (e) => this.newClass(e),
		ref: (e) => {
			this.b.open(4)
			this.expr(e.of)
			this.b.breakOp()
			this.b.token("::")
			this.b.token(e.name)
			this.b.close()
		},
		sel: (e) => dot(this, e),
		type: (e) => this.type(e.type),
	}

	expr(e: Expr): void {
		;(this.kinds[e.k] as (e: Expr) => void)(e)
	}

	/** visitAssignment: `to =`, a unified break, the value. */
	private infix(to: Expr, op: string, value: Expr): void {
		this.b.open(4)
		this.expr(to)
		this.b.space()
		this.b.token(op)
		this.b.breakOp(" ")
		this.expr(value)
		this.b.close()
	}

	/** visitParameterizedType, visitArrayType; a dotted name is a member select (visitDot). */
	type(t: Type): void {
		const dims = t.dims > 0
		if (dims) this.b.open(4)
		if (t.args.length === 0) this.typeName(t.name)
		else {
			this.b.open(4)
			this.typeName(t.name)
			this.b.token("<")
			this.b.breakOp()
			this.b.open(0)
			t.args.forEach((arg, i) => {
				if (i > 0) {
					this.b.token(",")
					this.b.breakOp(" ")
				}
				this.type(arg)
			})
			this.b.close()
			this.b.close()
			this.b.token(">")
		}
		if (dims) {
			for (let i = 0; i < t.dims; i += 1) this.b.token("[]")
			this.b.close()
		}
	}

	/** A type's or an annotation's name: a dotted one is a member select. */
	typeName(name: string): void {
		const path = id(name)
		if (path.k === "sel") dot(this, path)
		else this.b.token(name)
	}

	/** addTypeArguments: `<`, the arguments filled, `>`. */
	typeArgs(targs: readonly Type[], indent: Indent): void {
		this.b.token("<")
		this.b.open(indent)
		targs.forEach((t, i) => {
			if (i > 0) {
				this.b.token(",")
				this.b.breakToFill(" ")
			}
			this.type(t)
		})
		this.b.close()
		this.b.token(">")
	}

	/** addArguments: `(`, a break, the argument list; a format string's first argument apart (isFormatMethod). */
	args(args: readonly Expr[], indent: Indent): void {
		this.b.open(indent)
		this.b.token("(")
		const first = args[0]
		if (first !== undefined && args.length >= 2 && isString(first) && /%|\{[0-9]\}/.test(flatText(first))) {
			this.b.breakOp()
			this.b.open(0)
			this.expr(first)
			this.b.token(",")
			this.b.breakOp(" ")
			this.b.open(0)
			this.argList(args.slice(1))
			this.b.close()
			this.b.close()
		} else if (first !== undefined) {
			this.b.breakOp()
			this.argList(args)
		}
		this.b.token(")")
		this.b.close()
	}

	private argList(args: readonly Expr[]): void {
		this.b.open(0)
		const fill: Fill = shortItems(args) ? "independent" : "unified"
		args.forEach((arg, i) => {
			if (i > 0) {
				this.b.token(",")
				this.b.brk(fill, " ")
			}
			this.expr(arg)
		})
		this.b.close()
	}

	/** visitNewClass: `new T(args)`, an empty anonymous body after it. */
	private newClass(e: Of<"new">): void {
		this.b.open(0)
		this.b.token("new")
		this.b.space()
		this.type(e.type)
		this.args(e.args, 4)
		this.b.close()
		if (e.body) {
			this.b.space()
			this.b.token("{}")
		}
	}

	/** visitNewArray: `new T[]` and the initializer, or the bare initializer. */
	private newArray(e: Of<"array">): void {
		if (e.type !== null) {
			this.b.open(4)
			this.b.token("new")
			this.b.space()
			this.type({ ...e.type, dims: 0 })
			this.b.open(0)
			for (let i = 0; i < e.type.dims; i += 1) this.b.token("[]")
			this.b.close()
			this.b.close()
			this.b.space()
		}
		this.arrayInit(e.items)
	}

	/** visitArrayInitializer, its plain form: `{`, the items (filled when all are short), `}`. */
	private arrayInit(items: readonly Expr[]): void {
		if (items.length === 0) {
			this.b.token("{")
			this.b.token("}")
			return
		}
		const fill: Fill = shortItems(items) ? "independent" : "unified"
		this.b.open(2)
		this.b.token("{")
		this.b.breakOp()
		this.b.open(0)
		items.forEach((item, i) => {
			if (i > 0) {
				this.b.token(",")
				this.b.brk(fill, " ")
			}
			this.expr(item)
		})
		this.b.close()
		this.b.breakOp("", -2)
		this.b.close()
		this.b.token("}")
	}

	/** visitLambdaExpression with an expression body: the parameters, `->`, a unified break, the body at +4. */
	private lambda(e: Of<"lambda">): void {
		const parens = e.params.length !== 1
		this.b.open(parens ? 4 : 0)
		if (parens) this.b.token("(")
		e.params.forEach((name, i) => {
			if (i > 0) {
				this.b.token(",")
				this.b.breakOp(" ")
			}
			this.b.token(name)
		})
		if (parens) this.b.token(")")
		this.b.close()
		this.b.space()
		this.b.token("->")
		this.b.open(4)
		this.b.breakOp(" ")
		this.expr(e.body)
		this.b.close()
	}

	/** visitBinary: one precedence's operands, a break before each operator; StringWrapper's chain marked. */
	private binary(e: Of<"bin">): void {
		const fill: Fill = shortItems(e.operands) ? "independent" : "unified"
		this.b.open(4)
		this.expr(e.operands[0] as Expr)
		e.operands.slice(1).forEach((operand, i) => {
			this.b.brk(fill, " ")
			this.b.token(e.op)
			this.b.space()
			/* a literal in a `+` after a non-literal operand reflows under its own quote */
			const later = e.op === "+" && isString(operand) && !e.operands.slice(0, i + 1).every(isString)
			if (later) this.b.literal(flatText(operand), true)
			else this.expr(operand)
		})
		this.b.close()
	}
}
